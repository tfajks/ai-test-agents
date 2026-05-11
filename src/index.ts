import 'dotenv/config'
import crypto from 'crypto'
import { GitHubTool } from './tools/githubTool'
import { ClaudeTool } from './tools/claudeTool'
import { MemoryStore } from './memory/memoryStore'
import { AuditLog } from './audit/auditLog'
import { Logger } from './logger'
import { IngestAgent } from './agents/ingestAgent'
import { TestGeneratorAgent } from './agents/testGeneratorAgent'
import { ReportAgent } from './agents/reportAgent'
import { PipelineInput } from './types'

export async function runPipeline(input: PipelineInput): Promise<void> {
  const sessionId = crypto.randomUUID()
  const memoryStore = new MemoryStore(sessionId)
  const auditLog = new AuditLog()
  const logger = new Logger()

  const githubToken = process.env.GITHUB_TOKEN
  if (!githubToken) throw new Error('GITHUB_TOKEN is required')

  const claudeTool = new ClaudeTool()
  const githubTool = new GitHubTool(githubToken)

  const baseUrl = input.baseUrl ?? process.env.BASE_URL ?? 'http://localhost:3000'
  const dryRun = input.dryRun ?? false
  const outBase = `output/pr-${input.pullNumber}`

  console.log(`\nSession ${sessionId}`)
  console.log(`PR #${input.pullNumber}  ·  ${input.owner}/${input.repo}  ·  ${dryRun ? 'dry-run' : 'live'}\n`)

  const ingestAgent = new IngestAgent(githubTool, claudeTool, memoryStore, auditLog, logger)
  await ingestAgent.run(input)
  await memoryStore.save(`${outBase}/memory_state.json`)

  const testGeneratorAgent = new TestGeneratorAgent(claudeTool, memoryStore, auditLog, logger)
  await testGeneratorAgent.run(input.pullNumber, baseUrl)
  await memoryStore.save(`${outBase}/memory_state.json`)

  const reportAgent = new ReportAgent(githubTool, claudeTool, memoryStore, auditLog, logger)
  const report = await reportAgent.run(input.owner, input.repo, input.pullNumber, dryRun)
  await memoryStore.save(`${outBase}/memory_state.json`)

  await auditLog.save(`${outBase}/audit_log.json`)

  console.log(`\nAudit log  → ${outBase}/audit_log.json`)
  console.log(`Memory     → ${outBase}/memory_state.json`)
  console.log(`Report     → ${outBase}/report.json\n`)

  if (require.main === module && report.goNoGo === 'no-go') {
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const prFlagIdx = args.indexOf('--pr')
  const latestFlag = args.includes('--latest')
  const dryRun = args.includes('--dry-run')
  const baseUrlIdx = args.indexOf('--base-url')
  const baseUrl = baseUrlIdx !== -1 ? args[baseUrlIdx + 1] : undefined

  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  if (!owner || !repo) {
    console.error('GITHUB_OWNER and GITHUB_REPO must be set in .env')
    process.exit(1)
  }

  let pullNumber: number | null = null

  if (prFlagIdx !== -1) {
    pullNumber = parseInt(args[prFlagIdx + 1], 10)
    if (isNaN(pullNumber)) {
      console.error('--pr must be followed by a valid PR number')
      process.exit(1)
    }
  } else if (latestFlag) {
    const githubToken = process.env.GITHUB_TOKEN
    if (!githubToken) { console.error('GITHUB_TOKEN is required'); process.exit(1) }
    const githubTool = new GitHubTool(githubToken)
    pullNumber = await githubTool.getLatestOpenPR(owner, repo)
    if (pullNumber === null) {
      console.error('No open PRs found')
      process.exit(0)
    }
    console.log(`Using latest open PR: #${pullNumber}`)
  } else {
    console.error('Usage: npm run dev -- --pr <number> | --latest [--dry-run] [--base-url <url>]')
    process.exit(1)
  }

  await runPipeline({ owner, repo, pullNumber, dryRun, baseUrl })
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error((err as Error).message)
    process.exit(1)
  })
}
