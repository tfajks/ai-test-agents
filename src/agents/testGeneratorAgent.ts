import fs from 'fs'
import path from 'path'
import { ClaudeTool } from '../tools/claudeTool'
import { MemoryStore } from '../memory/memoryStore'
import { AuditLog } from '../audit/auditLog'
import { Logger } from '../logger'
import { ChangedFile, GeneratedTestBundle, TestGeneratorAgentOutput } from '../types'

const MAX_FILE_CHARS = 24000
const MAX_TOKENS = 8192

// Separate system prompts per test type — each call gets a full token budget
const SYSTEM_VITEST = `You are a senior QA engineer. Generate a COMPLETE, production-ready Vitest unit test file for the provided TypeScript/JavaScript source file.

Output ONLY the raw .test.ts file content — no explanation, no markdown fences, no XML tags. The file must be complete and not truncated.

Rules:
- Single top-level describe block named after the module
- it('should X when Y') naming
- vi.mock() for ALL external imports at the top
- beforeEach(() => vi.clearAllMocks())
- AAA pattern: Arrange / Act / Assert
- Cover: happy path, all error paths, boundary values (0, max, max+1), edge cases
- For validators/services: test every public method thoroughly`

const SYSTEM_PLAYWRIGHT = `You are a senior QA engineer. Generate a COMPLETE, production-ready Playwright e2e test file for the provided React/Next.js source file.

Output ONLY the raw .spec.ts file content — no explanation, no markdown fences, no XML tags. The file must be complete and not truncated.

Write SKIP (just that word) if the file contains no React components or page routes.

Rules:
- Page Object Model class with typed locators
- test.beforeEach to navigate to the correct route
- Use data-testid selectors where available, getByRole() otherwise
- NEVER use waitForTimeout() — use web-first assertions
- Cover: happy path, keyboard interactions, validation states, disabled states`

const SYSTEM_K6 = `You are a senior QA engineer. Generate a COMPLETE, production-ready k6 performance test file for the provided API route source file.

Output ONLY the raw .k6.js file content — no explanation, no markdown fences, no XML tags. The file must be complete and not truncated.

Write SKIP (just that word) if the file contains no HTTP endpoints.

Rules:
- export const options with stages: smoke(30s/2vus) + ramp(1m/20) + sustained(2m/20) + down(30s/0)
- thresholds: http_req_duration p(95)<500, errors rate<0.05
- __ENV.BASE_URL fallback to localhost
- check() every response: status + timing + body shape
- Cover: valid payload, missing required fields (400), unsupported values (400/422), empty body
- Custom Trend metric for the primary endpoint duration`

function truncateToExports(content: string): string {
  const lines = content.split('\n')
  const exportLines = lines.filter(
    (l) => l.startsWith('export ') || l.startsWith('// ') || l.startsWith('import ')
  )
  return exportLines.join('\n') + '\n// (file truncated — only exported signatures shown)'
}

function isSkip(text: string): boolean {
  return text.trim().toUpperCase() === 'SKIP' || text.trim() === ''
}

export class TestGeneratorAgent {
  constructor(
    private claudeTool: ClaudeTool,
    private memoryStore: MemoryStore,
    private auditLog: AuditLog,
    private logger: Logger
  ) {}

  async run(pullNumber: number, baseUrl: string): Promise<TestGeneratorAgentOutput> {
    this.logger.section('TEST GENERATOR AGENT', '⚡')
    this.auditLog.log({ agent: 'TestGeneratorAgent', action: 'STARTED', input: { pullNumber, baseUrl } })

    const ingest = this.memoryStore.get('ingest')
    const { changedFiles } = ingest

    const generatedFiles: GeneratedTestBundle[] = []
    const skippedFiles: string[] = []
    let unitTestsGenerated = 0
    let uiTestsGenerated = 0
    let perfTestsGenerated = 0

    const outBase = `output/pr-${pullNumber}`

    for (const file of changedFiles) {
      const fileIdx = changedFiles.indexOf(file) + 1
      this.logger.section(`[${fileIdx}/${changedFiles.length}] ${path.basename(file.path)}`, '📄')
      this.logger.info(`risk: ${file.risk}  |  endpoints: ${file.detectedEndpoints.join(', ') || 'none'}`)
      this.auditLog.log({ agent: 'TestGeneratorAgent', action: 'GENERATING', input: { path: file.path } })

      try {
        const bundle = await this.generateForFile(file, pullNumber, baseUrl, outBase)

        if (!bundle.vitest && !bundle.playwright && !bundle.k6) {
          skippedFiles.push(file.path)
          this.logger.skip('All test types returned SKIP — no testable logic found')
          this.auditLog.log({
            agent: 'TestGeneratorAgent',
            action: 'SKIPPED',
            input: { path: file.path },
            reasoning: 'All test types returned SKIP or were empty',
          })
          continue
        }

        await this.writeBundleToDisk(bundle)
        generatedFiles.push(bundle)

        if (bundle.vitest)     { unitTestsGenerated++;  this.logger.ok(`vitest     → ${bundle.vitest.outputPath}`) }
        else                                             this.logger.skip('vitest     (no testable logic)')
        if (bundle.playwright) { uiTestsGenerated++;    this.logger.ok(`playwright → ${bundle.playwright.outputPath}`) }
        else                                             this.logger.skip('playwright (no UI components)')
        if (bundle.k6)         { perfTestsGenerated++;  this.logger.ok(`k6         → ${bundle.k6.outputPath}`) }
        else                                             this.logger.skip('k6         (no HTTP endpoints)')

        this.auditLog.log({
          agent: 'TestGeneratorAgent',
          action: 'GENERATED',
          output: {
            vitest: bundle.vitest?.outputPath ?? null,
            playwright: bundle.playwright?.outputPath ?? null,
            k6: bundle.k6?.outputPath ?? null,
          },
        })
      } catch (err) {
        skippedFiles.push(file.path)
        this.logger.error(`Failed: ${(err as Error).message}`)
        this.auditLog.log({
          agent: 'TestGeneratorAgent',
          action: 'ERROR',
          input: { path: file.path },
          reasoning: (err as Error).message,
        })
      }
    }

    const output: TestGeneratorAgentOutput = {
      generatedFiles,
      summary: {
        totalFilesProcessed: changedFiles.length,
        unitTestsGenerated,
        uiTestsGenerated,
        perfTestsGenerated,
        skippedFiles,
      },
    }

    this.memoryStore.set('testGenerator', output)
    this.auditLog.log({ agent: 'TestGeneratorAgent', action: 'COMPLETED', output: output.summary })
    return output
  }

  private buildUserPrompt(file: ChangedFile, baseUrl: string): string {
    const content = file.content.length > MAX_FILE_CHARS
      ? truncateToExports(file.content)
      : file.content
    return `Source file: ${file.path}
Base URL: ${baseUrl}
Detected endpoints: ${file.detectedEndpoints.join(', ') || 'none'}
Detected components: ${file.detectedComponents.join(', ') || 'none'}
Risk level: ${file.risk}

${content}`
  }

  private async callClaude(systemPrompt: string, userPrompt: string, label: string): Promise<string> {
    this.logger.streamHeader(label)
    const text = await this.claudeTool.complete(systemPrompt, userPrompt, {
      maxTokens: MAX_TOKENS,
      cacheSystem: true,
      onToken: (t) => this.logger.token(t),
    })
    this.logger.streamEnd()
    return text
  }

  private async generateForFile(
    file: ChangedFile,
    pullNumber: number,
    baseUrl: string,
    outBase: string
  ): Promise<GeneratedTestBundle> {
    const baseName = path.basename(file.path, path.extname(file.path))
    const userPrompt = this.buildUserPrompt(file, baseUrl)
    const hasEndpoints = file.detectedEndpoints.length > 0
    // Playwright only for page-level components or files with endpoints — not UI primitives
    const isPageLevel = /\/(pages|app|routes|views)\//i.test(file.path) ||
      /page\.(tsx?|jsx?)$/.test(file.path) ||
      /layout\.(tsx?|jsx?)$/.test(file.path)
    const hasComponents = (file.detectedComponents.length > 0 || file.category.includes('component')) &&
      (isPageLevel || hasEndpoints)

    // Three separate calls — each gets full MAX_TOKENS budget
    const [vitestRaw, playwrightRaw, k6Raw] = await Promise.all([
      this.callClaude(SYSTEM_VITEST, userPrompt, `${baseName} [vitest]`),
      hasComponents
        ? this.callClaude(SYSTEM_PLAYWRIGHT, userPrompt, `${baseName} [playwright]`)
        : Promise.resolve('SKIP'),
      hasEndpoints
        ? this.callClaude(SYSTEM_K6, userPrompt, `${baseName} [k6]`)
        : Promise.resolve('SKIP'),
    ])

    const bundle: GeneratedTestBundle = { sourcePath: file.path }

    if (!isSkip(vitestRaw)) {
      bundle.vitest = {
        outputPath: path.join(outBase, 'unit', `${baseName}.test.ts`),
        content: vitestRaw.trim(),
      }
    }
    if (!isSkip(playwrightRaw)) {
      bundle.playwright = {
        outputPath: path.join(outBase, 'ui', `${baseName}.spec.ts`),
        content: playwrightRaw.trim(),
      }
    }
    if (!isSkip(k6Raw)) {
      bundle.k6 = {
        outputPath: path.join(outBase, 'perf', `${baseName}.k6.js`),
        content: k6Raw.trim(),
      }
    }

    return bundle
  }

  private async writeBundleToDisk(bundle: GeneratedTestBundle): Promise<void> {
    const writes: Promise<void>[] = []
    for (const testFile of [bundle.vitest, bundle.playwright, bundle.k6]) {
      if (!testFile) continue
      const dir = path.dirname(testFile.outputPath)
      writes.push(
        fs.promises.mkdir(dir, { recursive: true }).then(() =>
          fs.promises.writeFile(testFile.outputPath, testFile.content, 'utf8')
        )
      )
    }
    await Promise.all(writes)
  }
}
