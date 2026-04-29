import fs from 'fs'
import path from 'path'
import { GitHubTool } from '../tools/githubTool'
import { ClaudeTool } from '../tools/claudeTool'
import { MemoryStore } from '../memory/memoryStore'
import { AuditLog } from '../audit/auditLog'
import { GoNoGo, ReportAgentOutput, RiskLevel, TestScore } from '../types'

interface ScoringResult {
  testScores: TestScore[]
  overallRisk: RiskLevel
  riskReasons: string[]
  goNoGo: GoNoGo
}

function computeGoNoGo(risk: RiskLevel, avgScore: number): GoNoGo {
  if (risk === 'critical') return 'no-go'
  if (risk === 'high' || avgScore < 5) return 'no-go'
  if (risk === 'medium' || avgScore < 8) return 'go-with-caution'
  return 'go'
}

function riskEmoji(risk: RiskLevel): string {
  return { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[risk]
}

function goNoGoEmoji(g: GoNoGo): string {
  return { go: '✅ Go', 'go-with-caution': '🟡 Go with caution', 'no-go': '🔴 No-Go' }[g]
}

export class ReportAgent {
  constructor(
    private githubTool: GitHubTool,
    private claudeTool: ClaudeTool,
    private memoryStore: MemoryStore,
    private auditLog: AuditLog
  ) {}

  async run(owner: string, repo: string, pullNumber: number, dryRun: boolean): Promise<ReportAgentOutput> {
    this.auditLog.log({ agent: 'ReportAgent', action: 'STARTED', input: { owner, repo, pullNumber, dryRun } })

    const ingest = this.memoryStore.get('ingest')
    const testGenerator = this.memoryStore.get('testGenerator')

    const testContents: Array<{ path: string; type: 'unit' | 'ui' | 'perf'; content: string }> = []
    for (const bundle of testGenerator.generatedFiles) {
      if (bundle.vitest) testContents.push({ path: bundle.vitest.outputPath, type: 'unit', content: bundle.vitest.content })
      if (bundle.playwright) testContents.push({ path: bundle.playwright.outputPath, type: 'ui', content: bundle.playwright.content })
      if (bundle.k6) testContents.push({ path: bundle.k6.outputPath, type: 'perf', content: bundle.k6.content })
    }

    this.auditLog.log({
      agent: 'ReportAgent',
      action: 'SCORING',
      input: { testFileCount: testContents.length },
    })

    const scoring = await this.scoreTests(ingest.changedFiles, testContents)
    const avgScore =
      scoring.testScores.length > 0
        ? scoring.testScores.reduce((s, t) => s + t.score, 0) / scoring.testScores.length
        : 0

    const goNoGo = computeGoNoGo(scoring.overallRisk, avgScore)

    this.auditLog.log({
      agent: 'ReportAgent',
      action: 'SCORED',
      output: { avgScore: avgScore.toFixed(1), overallRisk: scoring.overallRisk, goNoGo },
    })

    const comment = this.buildComment(
      ingest.pr.number,
      ingest.pr.title,
      ingest.changedFiles,
      testGenerator.summary,
      scoring,
      avgScore,
      goNoGo
    )

    let prCommentUrl = ''
    if (!dryRun) {
      prCommentUrl = await this.githubTool.createComment(
        owner,
        repo,
        pullNumber,
        comment
      )
      this.auditLog.log({ agent: 'ReportAgent', action: 'COMMENT_POSTED', output: { url: prCommentUrl } })
    } else {
      this.auditLog.log({ agent: 'ReportAgent', action: 'COMMENT_SKIPPED', reasoning: 'dry-run mode' })
    }

    const reportPath = `output/pr-${pullNumber}/report.json`
    const reportData = {
      pullNumber,
      pr: ingest.pr,
      scoring,
      avgScore,
      goNoGo,
      testSummary: testGenerator.summary,
      comment,
    }

    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.promises.writeFile(reportPath, JSON.stringify(reportData, null, 2), 'utf8')

    const output: ReportAgentOutput = {
      overallRisk: scoring.overallRisk,
      riskReasons: scoring.riskReasons,
      testScores: scoring.testScores,
      averageScore: Math.round(avgScore * 10) / 10,
      goNoGo,
      prCommentUrl,
      reportPath,
    }

    this.memoryStore.set('report', output)
    this.auditLog.log({ agent: 'ReportAgent', action: 'COMPLETED', output: { goNoGo, reportPath } })
    return output
  }

  private async scoreTests(
    changedFiles: { path: string; risk: RiskLevel }[],
    testContents: Array<{ path: string; type: 'unit' | 'ui' | 'perf'; content: string }>
  ): Promise<ScoringResult> {
    const systemPrompt = `You are a senior QA lead. Score generated test files and assess PR risk.
Output ONLY valid JSON — no markdown, no code fences.`

    const filesSummary = changedFiles
      .map((f) => `- ${f.path} (risk: ${f.risk})`)
      .join('\n')

    const testsSummary = testContents
      .map(
        (t) =>
          `### ${t.path} (${t.type})\n${t.content.slice(0, 1500)}${t.content.length > 1500 ? '\n...(truncated)' : ''}`
      )
      .join('\n\n')

    const userPrompt = `PR changed these files:
${filesSummary}

Generated test files:
${testsSummary}

Score each test file 0-10 (0=useless, 10=excellent).
Assess overall PR risk and provide a Go/No-Go recommendation.

Respond with:
{
  "testScores": [
    { "filePath": "path/to/test", "type": "unit|ui|perf", "score": 8, "notes": "brief notes" }
  ],
  "overallRisk": "low|medium|high|critical",
  "riskReasons": ["reason 1", "reason 2"],
  "goNoGo": "go|go-with-caution|no-go"
}`

    return this.claudeTool.completeJSON<ScoringResult>(systemPrompt, userPrompt)
  }

  private buildComment(
    prNumber: number,
    prTitle: string,
    changedFiles: Array<{ path: string; risk: RiskLevel; detectedEndpoints: string[]; detectedComponents: string[] }>,
    summary: { unitTestsGenerated: number; uiTestsGenerated: number; perfTestsGenerated: number },
    scoring: ScoringResult,
    avgScore: number,
    goNoGo: GoNoGo
  ): string {
    const totalTests = summary.unitTestsGenerated + summary.uiTestsGenerated + summary.perfTestsGenerated

    const scoresTable = scoring.testScores.length > 0
      ? [
          '| File | Type | Score | Notes |',
          '|------|------|-------|-------|',
          ...scoring.testScores.map(
            (s) => `| \`${path.basename(s.filePath)}\` | ${s.type} | ${s.score}/10 | ${s.notes} |`
          ),
        ].join('\n')
      : '_No test files scored_'

    const riskList = changedFiles
      .map((f) => {
        const icon = { low: '✅', medium: '⚠️', high: '🔴', critical: '💀' }[f.risk]
        return `- ${icon} \`${f.path}\` — ${f.risk} risk`
      })
      .join('\n')

    return `## 🤖 AI Test Automation Report

**PR #${prNumber}** — \`${prTitle}\`
**Risk Level:** ${riskEmoji(scoring.overallRisk)} ${scoring.overallRisk}
**Files analyzed:** ${changedFiles.length} | **Tests generated:** ${totalTests} files | **Avg score:** ${avgScore.toFixed(1)}/10

### Generated Tests

| Type | Count |
|------|-------|
| Unit (Vitest) | ${summary.unitTestsGenerated} |
| UI (Playwright) | ${summary.uiTestsGenerated} |
| Performance (k6) | ${summary.perfTestsGenerated} |

### Test Scores

${scoresTable}

### Risk Assessment

${riskList}

${scoring.riskReasons.length > 0 ? `**Risk factors:**\n${scoring.riskReasons.map((r) => `- ${r}`).join('\n')}` : ''}

### Go/No-Go: ${goNoGoEmoji(goNoGo)}

---
_Generated by Intelligent Test Automation Agent_`
  }
}
