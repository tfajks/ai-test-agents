# Agent: Test Generator Agent

## Role

The Test Generator Agent is the core of the pipeline. It reads all changed source files from the Memory Store and generates all three test types — Vitest unit tests, Playwright UI specs, and k6 performance scripts — in a **single Claude API call per file**. This keeps costs low while maintaining full test coverage across the quality spectrum.

---

## Responsibilities

1. Read all changed files from the Memory Store (output of Ingest Agent).
2. For each relevant source file, call Claude once and request all three test types in a single structured response.
3. Parse the JSON response and extract Vitest, Playwright, and k6 content.
4. Write generated files to `./output/unit/`, `./output/ui/`, `./output/perf/`.
5. Skip file types that don't apply (e.g. no Playwright spec for a pure service file with no UI).
6. Write all generated file paths and metadata to the Memory Store.
7. Log every generation decision to the Audit Log.

---

## Input (read from Memory Store)

```typescript
interface TestGeneratorAgentInput {
  changedFiles: ChangedFile[];   // from IngestAgent
  baseUrl: string;               // from env: BASE_URL — used in k6 scripts
}
```

---

## Output (written to Memory Store + disk)

```typescript
interface TestGeneratorAgentOutput {
  generatedFiles: GeneratedTestBundle[];
  summary: {
    totalFilesProcessed: number;
    unitTestsGenerated: number;
    uiTestsGenerated: number;
    perfTestsGenerated: number;
    skippedFiles: string[];
  };
}

interface GeneratedTestBundle {
  sourcePath: string;
  vitest?: { outputPath: string; content: string; };
  playwright?: { outputPath: string; content: string; };
  k6?: { outputPath: string; content: string; };
}
```

---

## Claude AI Usage

One Claude call per source file. The prompt requests a JSON object with three keys. Claude's deep knowledge of Vitest, Playwright, and k6 means no knowledge base injection is needed — the prompt stays short and focused.

### Prompt Pattern

```typescript
const systemPrompt = `
You are a senior QA engineer. Generate production-ready tests for the provided TypeScript source file.
Output ONLY valid JSON — no markdown, no code fences, no explanations.
`

const userPrompt = `
Source file: ${file.path}
Base URL for k6: ${baseUrl}

${file.content}

Generate:
{
  "vitest": "<complete .test.ts file using describe/it/expect, vi.mock() for dependencies, AAA pattern, edge cases and error paths>",
  "playwright": "<complete .spec.ts file using Page Object Model, getByRole() selectors, web-first assertions, happy path + validation + error states — or null if no UI>",
  "k6": "<complete .k6.js file with smoke+load stages, check() assertions, tagged requests, thresholds p(95)<500ms — or null if no HTTP endpoints>"
}
`
```

### Skipping Logic

The prompt instructs Claude to return `null` for test types that don't apply:
- `playwright: null` — when file has no React/Vue components or page routes
- `k6: null` — when file has no HTTP endpoints or route definitions
- `vitest: null` — when file has no exported functions or testable logic (rare)

---

## Generation Rules

### Vitest tests must include:
- `describe` block named after the module
- `it` blocks with the pattern: *"should [expected] when [condition]"*
- `vi.mock()` for all external imports (HTTP clients, DB, FS, SDKs)
- `beforeEach(() => vi.clearAllMocks())`
- Tests for: happy path, null/undefined inputs, error throws, async rejection, boundary values

### Playwright specs must include:
- A Page Object class that encapsulates selectors and actions
- `test.beforeEach` to navigate to the relevant route
- `getByRole()` as first choice for selectors
- Web-first assertions only (`toBeVisible()`, `toContainText()`, `toBeEnabled()`)
- No `waitForTimeout()` — ever
- Tests for: happy path, form validation errors, error states, empty states

### k6 scripts must include:
- `export const options` with stages (ramp-up → steady → ramp-down) and thresholds
- `check()` assertions on status code, response time, and body
- Tagged requests: `{ tags: { name: 'endpoint name' } }`
- `sleep(1)` between requests to simulate think time
- `__ENV.BASE_URL` and `__ENV.API_TOKEN` for configuration — never hardcoded values
- Thresholds: `p(95)<500`, `http_req_failed rate<0.01`

---

## Output File Naming

| Test Type | Output Path |
|-----------|------------|
| Vitest | `output/unit/<filename>.test.ts` |
| Playwright | `output/ui/<filename>.spec.ts` |
| k6 | `output/perf/<filename>.k6.js` |

---

## Error Handling

- If Claude returns invalid JSON → retry once with explicit instruction: *"Return only valid JSON, no other text."*
- If retry fails → write a placeholder file with a `// TODO: generation failed` comment and log warning.
- If a test type key is missing from the JSON response → treat as `null` (skip that type).
- If file content exceeds ~6000 tokens → truncate to exported functions only and add a comment in the generated file noting truncation.

---

## Audit Log Entries

```json
{ "agent": "TestGeneratorAgent", "action": "GENERATING", "input": { "path": "src/services/authService.ts" } }
{ "agent": "TestGeneratorAgent", "action": "GENERATED", "output": { "vitest": "output/unit/authService.test.ts", "playwright": null, "k6": "output/perf/authService.k6.js" } }
{ "agent": "TestGeneratorAgent", "action": "RETRY", "input": { "path": "src/components/LoginForm.tsx" }, "reasoning": "Invalid JSON on first attempt" }
{ "agent": "TestGeneratorAgent", "action": "SKIPPED", "input": { "path": "src/types/index.ts" }, "reasoning": "Pure type definitions, no testable logic" }
```
