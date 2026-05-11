import path from 'path'
import { GitHubTool } from '../tools/githubTool'
import { ClaudeTool } from '../tools/claudeTool'
import { MemoryStore } from '../memory/memoryStore'
import { AuditLog } from '../audit/auditLog'
import { Logger } from '../logger'
import {
  ChangedFile,
  FileCategory,
  IngestAgentOutput,
  PipelineInput,
  RiskLevel,
} from '../types'

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const SKIP_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /\/dist\//,
  /\\dist\\/,
  /\/node_modules\//,
  /\\node_modules\\/,
  /\.d\.ts$/,
]

interface ClassificationResult {
  files: Array<{
    path: string
    category: FileCategory[]
    detectedEndpoints: string[]
    detectedComponents: string[]
    risk: RiskLevel
  }>
}

export class IngestAgent {
  constructor(
    private githubTool: GitHubTool,
    private claudeTool: ClaudeTool,
    private memoryStore: MemoryStore,
    private auditLog: AuditLog,
    private logger: Logger
  ) {}

  async run(input: PipelineInput): Promise<IngestAgentOutput> {
    this.logger.section('INGEST AGENT', '🔍')
    this.auditLog.log({ agent: 'IngestAgent', action: 'STARTED', input })

    this.logger.step(`Fetching PR #${input.pullNumber} from ${input.owner}/${input.repo}`)
    const pr = await this.githubTool.getPullRequest(input.owner, input.repo, input.pullNumber)
    this.logger.ok(`PR: "${pr.title}" by @${pr.author}`)
    this.auditLog.log({ agent: 'IngestAgent', action: 'PR_FETCHED', output: { title: pr.title, author: pr.author } })

    this.logger.step('Fetching changed files')
    const rawFiles = await this.githubTool.listChangedFiles(input.owner, input.repo, input.pullNumber)
    this.auditLog.log({ agent: 'IngestAgent', action: 'FILES_FETCHED', output: { count: rawFiles.length } })

    const filteredFiles = rawFiles.filter((f) => {
      const ext = path.extname(f.filename).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.has(ext)) return false
      if (f.status === 'removed') return false
      if (SKIP_PATTERNS.some((p) => p.test(f.filename))) return false
      return true
    })
    this.auditLog.log({
      agent: 'IngestAgent',
      action: 'FILES_FILTERED',
      output: { kept: filteredFiles.length, skipped: rawFiles.length - filteredFiles.length },
    })

    const filesWithContent: Array<{ filename: string; additions: number; deletions: number; content: string }> = []
    for (const f of filteredFiles) {
      const content = await this.githubTool.getFileContent(
        input.owner,
        input.repo,
        f.filename,
        pr.headSha
      )
      if (content !== null) {
        filesWithContent.push({ filename: f.filename, additions: f.additions, deletions: f.deletions, content })
        this.logger.ok(`${f.filename}  (+${f.additions}/-${f.deletions})`)
      } else {
        this.logger.skip(`${f.filename}  (skipped — binary or missing)`)
      }
    }

    this.logger.step('Classifying files with Claude')
    this.logger.streamHeader('classification')
    this.auditLog.log({
      agent: 'IngestAgent',
      action: 'CLASSIFYING',
      input: { files: filesWithContent.map((f) => f.filename) },
    })

    const classification = await this.classify(filesWithContent)
    this.logger.streamEnd()

    this.auditLog.log({
      agent: 'IngestAgent',
      action: 'CLASSIFIED',
      output: classification.files.map((f) => ({ path: f.path, risk: f.risk, category: f.category })),
    })

    const changedFiles: ChangedFile[] = filesWithContent.map((f) => {
      const cls = classification.files.find((c) => c.path === f.filename) ?? {
        path: f.filename,
        category: ['other' as FileCategory],
        detectedEndpoints: [],
        detectedComponents: [],
        risk: 'low' as RiskLevel,
      }
      return {
        path: f.filename,
        filename: path.basename(f.filename),
        status: 'modified' as const,
        content: f.content,
        category: cls.category,
        linesAdded: f.additions,
        linesRemoved: f.deletions,
        detectedEndpoints: cls.detectedEndpoints,
        detectedComponents: cls.detectedComponents,
        risk: cls.risk,
      }
    })

    const byCategory: Partial<Record<FileCategory, number>> = {}
    for (const f of changedFiles) {
      for (const cat of f.category) {
        byCategory[cat] = (byCategory[cat] ?? 0) + 1
      }
    }

    const output: IngestAgentOutput = {
      pr,
      changedFiles,
      summary: {
        totalFiles: changedFiles.length,
        byCategory,
        hasApiEndpoints: changedFiles.some((f) => f.detectedEndpoints.length > 0),
        hasUIComponents: changedFiles.some((f) => f.detectedComponents.length > 0),
      },
    }

    for (const f of changedFiles) {
      const riskColor = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[f.risk]
      this.logger.info(`${riskColor} ${f.path}  [${f.category.join(', ')}]  endpoints: ${f.detectedEndpoints.length}`)
    }

    this.memoryStore.set('ingest', output)
    this.auditLog.log({ agent: 'IngestAgent', action: 'COMPLETED', output: output.summary })
    return output
  }

  private async classify(
    files: Array<{ filename: string; content: string }>
  ): Promise<ClassificationResult> {
    const systemPrompt = `You are a senior TypeScript engineer. Classify source files in a PR.
Output ONLY valid JSON — no markdown, no code fences, no explanation.`

    const fileSummaries = files
      .map(
        (f) =>
          `### ${f.filename}\n${f.content.slice(0, 2000)}${f.content.length > 2000 ? '\n...(truncated)' : ''}`
      )
      .join('\n\n')

    const userPrompt = `Classify each file below. For each, identify:
- category: array of one or more from: service, controller, component, utility, model, config, test, other
- detectedEndpoints: HTTP endpoints defined in this file (e.g. "POST /api/users"), empty array if none
- detectedComponents: React/Vue component names exported, empty array if none
- risk: one of: low, medium, high, critical
  - critical: auth, security, payment, encryption
  - high: business logic, data persistence, external API calls
  - medium: controllers, routing
  - low: UI components, utilities, models

Files:
${fileSummaries}

Respond with:
{
  "files": [
    {
      "path": "filename",
      "category": ["service"],
      "detectedEndpoints": ["POST /api/auth/login"],
      "detectedComponents": [],
      "risk": "high"
    }
  ]
}`

    return this.claudeTool.completeJSON<ClassificationResult>(systemPrompt, userPrompt, {
      onToken: (t) => this.logger.token(t),
    })
  }
}
