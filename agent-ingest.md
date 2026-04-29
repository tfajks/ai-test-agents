# Agent: Ingest Agent

## Role

The Ingest Agent is the entry point of the pipeline. It connects to the GitHub API, fetches the Pull Request diff, reads the full content of every changed TypeScript/JavaScript file, classifies each file by type, and writes everything to the Memory Store for the Test Generator Agent to consume.

---

## Responsibilities

1. Fetch the list of changed files from a GitHub Pull Request via Octokit REST API.
2. Read the full source content of each changed `.ts`, `.tsx`, `.js`, or `.jsx` file.
3. Classify each file into one or more categories: `service`, `controller`, `component`, `utility`, `model`, `config`, `test`, `other`.
4. Extract metadata: file path, change type (`added`, `modified`, `removed`), lines added/removed.
5. Identify potential API endpoints (Express/Fastify route definitions, HTTP method patterns).
6. Identify potential UI components (React/Vue component patterns, page files).
7. Write all results to the Memory Store.
8. Log every action to the Audit Log.

---

## Input

```typescript
interface IngestAgentInput {
  owner: string;        // GitHub org or username
  repo: string;         // Repository name
  pullNumber: number;   // PR number to analyze
}
```

---

## Output (written to Memory Store)

```typescript
interface IngestAgentOutput {
  pr: {
    number: number;
    title: string;
    description: string;
    author: string;
    baseBranch: string;
    headBranch: string;
  };
  changedFiles: ChangedFile[];
  summary: {
    totalFiles: number;
    byCategory: Record<FileCategory, number>;
    hasApiEndpoints: boolean;
    hasUIComponents: boolean;
  };
}

interface ChangedFile {
  path: string;
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  content: string;
  category: FileCategory[];
  linesAdded: number;
  linesRemoved: number;
  detectedEndpoints: string[];
  detectedComponents: string[];
}

type FileCategory =
  | 'service' | 'controller' | 'component'
  | 'utility' | 'model' | 'config' | 'test' | 'other';
```

---

## Claude AI Usage

The Ingest Agent uses Claude **once** — a lightweight call to classify all changed files together and extract endpoint/component metadata.

### Prompt Pattern

```typescript
const prompt = `
Analyze these changed files from a GitHub Pull Request.
For each file respond in JSON only:
{
  "files": [
    {
      "path": "src/services/authService.ts",
      "categories": ["service"],
      "detectedEndpoints": ["POST /api/auth/login", "POST /api/auth/refresh"],
      "detectedComponents": [],
      "riskLevel": "high",
      "riskReason": "handles JWT signing and token verification"
    }
  ]
}

Files to classify:
${changedFiles.map(f => `=== ${f.path} ===\n${f.content.slice(0, 1500)}`).join('\n\n')}
`
```

---

## Files to Process

**Include:**
- `.ts`, `.tsx`, `.js`, `.jsx` files
- Files in `src/`, `app/`, `lib/`, `pages/`, `components/`, `services/`, `controllers/`

**Skip:**
- `node_modules/`, `dist/`, `coverage/`, `.next/`, `build/`
- Binary files (images, fonts, PDFs)
- Existing test files (`*.test.ts`, `*.spec.ts`) — we generate tests, not tests of tests
- Pure type/interface files with no logic
- Config files (`.eslintrc`, `tsconfig.json`, etc.)

---

## Error Handling

- If file content exceeds 500KB → skip and log warning.
- If GitHub API rate limit hit → exponential backoff, 3 retries.
- If PR does not exist → throw descriptive error and halt pipeline.
- All errors written to Audit Log before re-throwing.

---

## Audit Log Entries

```json
{ "agent": "IngestAgent", "action": "PR_FETCHED", "output": { "pr": 42, "filesCount": 4 } }
{ "agent": "IngestAgent", "action": "FILES_CLASSIFIED", "output": { "service": 2, "component": 1, "utility": 1 } }
{ "agent": "IngestAgent", "action": "FILE_SKIPPED", "input": { "path": "src/assets/logo.png" }, "reasoning": "Binary file" }
{ "agent": "IngestAgent", "action": "INGEST_COMPLETE", "output": { "totalFiles": 4, "hasEndpoints": true, "hasComponents": true } }
```
