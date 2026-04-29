import fs from 'fs'
import path from 'path'
import { ClaudeTool } from '../tools/claudeTool'
import { MemoryStore } from '../memory/memoryStore'
import { AuditLog } from '../audit/auditLog'
import { ChangedFile, GeneratedTestBundle, GeneratedTestFile, TestGeneratorAgentOutput } from '../types'

const MAX_FILE_CHARS = 24000

const SYSTEM_PROMPT = `You are a senior QA engineer. Generate production-ready tests for the provided TypeScript/JavaScript source file.

Output your response using ONLY these XML tags — no other text, no explanation, no markdown:

<vitest>
[complete .test.ts file using describe/it/expect, vi.mock() for all external deps, AAA pattern, edge cases and error paths]
</vitest>
<playwright>
[complete .spec.ts file using Page Object Model, getByRole() selectors, web-first assertions, happy path + validation + error states]
[write SKIP if no React/Vue components or page routes are present]
</playwright>
<k6>
[complete .k6.js file with smoke+load stages, check() assertions, tagged requests, thresholds p(95)<500ms, __ENV.BASE_URL]
[write SKIP if no HTTP endpoints are defined in this file]
</k6>

Rules:
- vitest: describe block named after module, it('should X when Y'), vi.mock() for all imports, beforeEach(() => vi.clearAllMocks())
- playwright: Page Object class, test.beforeEach to navigate, no waitForTimeout() ever
- k6: export const options with stages and thresholds, check() on status+time+body, sleep(1) between requests`

function parseXmlSection(text: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)
  const match = text.match(regex)
  if (!match) return null
  const content = match[1].trim()
  return content === 'SKIP' || content === '' ? null : content
}

function truncateToExports(content: string): string {
  const lines = content.split('\n')
  const exportLines = lines.filter(
    (l) => l.startsWith('export ') || l.startsWith('// ') || l.startsWith('import ')
  )
  return exportLines.join('\n') + '\n// (file truncated — only exported signatures shown)'
}

export class TestGeneratorAgent {
  constructor(
    private claudeTool: ClaudeTool,
    private memoryStore: MemoryStore,
    private auditLog: AuditLog
  ) {}

  async run(pullNumber: number, baseUrl: string): Promise<TestGeneratorAgentOutput> {
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
      this.auditLog.log({
        agent: 'TestGeneratorAgent',
        action: 'GENERATING',
        input: { path: file.path },
      })

      try {
        const bundle = await this.generateForFile(file, pullNumber, baseUrl, outBase)

        if (!bundle.vitest && !bundle.playwright && !bundle.k6) {
          skippedFiles.push(file.path)
          this.auditLog.log({
            agent: 'TestGeneratorAgent',
            action: 'SKIPPED',
            input: { path: file.path },
            reasoning: 'All test sections returned SKIP or were empty',
          })
          continue
        }

        await this.writeBundleToDisk(bundle)
        generatedFiles.push(bundle)

        if (bundle.vitest) unitTestsGenerated++
        if (bundle.playwright) uiTestsGenerated++
        if (bundle.k6) perfTestsGenerated++

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
        this.auditLog.log({
          agent: 'TestGeneratorAgent',
          action: 'ERROR',
          input: { path: file.path },
          reasoning: (err as Error).message,
        })
        console.error(`TestGeneratorAgent: failed on ${file.path}:`, (err as Error).message)
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

  private async generateForFile(
    file: ChangedFile,
    pullNumber: number,
    baseUrl: string,
    outBase: string
  ): Promise<GeneratedTestBundle> {
    const baseName = path.basename(file.path, path.extname(file.path))
    const content = file.content.length > MAX_FILE_CHARS
      ? truncateToExports(file.content)
      : file.content

    const userPrompt = `Source file: ${file.path}
Base URL for k6: ${baseUrl}
Detected endpoints: ${file.detectedEndpoints.join(', ') || 'none'}
Detected components: ${file.detectedComponents.join(', ') || 'none'}

${content}`

    let responseText = await this.claudeTool.complete(SYSTEM_PROMPT, userPrompt, {
      maxTokens: 8192,
      cacheSystem: true,
    })

    let vitest = parseXmlSection(responseText, 'vitest')
    let playwright = parseXmlSection(responseText, 'playwright')
    let k6 = parseXmlSection(responseText, 'k6')

    if (!vitest && !playwright && !k6) {
      this.auditLog.log({
        agent: 'TestGeneratorAgent',
        action: 'RETRY',
        input: { path: file.path },
        reasoning: 'No XML sections found in first response',
      })
      responseText = await this.claudeTool.complete(
        SYSTEM_PROMPT,
        userPrompt + '\n\nIMPORTANT: You MUST respond using the <vitest>, <playwright>, and <k6> XML tags. No other format is accepted.',
        { maxTokens: 8192, cacheSystem: true }
      )
      vitest = parseXmlSection(responseText, 'vitest')
      playwright = parseXmlSection(responseText, 'playwright')
      k6 = parseXmlSection(responseText, 'k6')
    }

    const bundle: GeneratedTestBundle = { sourcePath: file.path }

    if (vitest) {
      bundle.vitest = {
        outputPath: path.join(outBase, 'unit', `${baseName}.test.ts`),
        content: vitest,
      }
    }
    if (playwright) {
      bundle.playwright = {
        outputPath: path.join(outBase, 'ui', `${baseName}.spec.ts`),
        content: playwright,
      }
    }
    if (k6) {
      bundle.k6 = {
        outputPath: path.join(outBase, 'perf', `${baseName}.k6.js`),
        content: k6,
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
