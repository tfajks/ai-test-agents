# Architecture: Memory Store & Orchestrator

## Memory Store

The Memory Store is the shared state layer connecting all three agents. It acts as an in-process key-value store with JSON persistence — no agent calls another agent directly, they only read from and write to the store.

### Storage Strategy

The Memory Store uses **in-process state with JSON persistence**. The interface is storage-agnostic — swapping to Redis or any other backend requires only a new adapter implementing the same `MemoryStore` interface, with no changes to the agents themselves.

This approach was chosen deliberately: the pipeline runs as a single process triggered per PR, so distributed state is unnecessary complexity. If the system were to scale to parallel PR processing across multiple workers, a Redis adapter would be the natural next step.

### Design Principles

- **Immutable writes per stage** — each agent appends its output under its own namespace key; it never overwrites another agent's data.
- **Full persistence** — the entire state is written to `./output/memory_state.json` after each agent completes, enabling debugging and replay.
- **Typed access** — all reads and writes use TypeScript interfaces; no `any` access.

### Store Structure

```typescript
interface MemoryState {
  sessionId: string;
  startedAt: string;
  pr: PullRequestMeta;
  ingest: IngestAgentOutput;
  testGenerator: TestGeneratorAgentOutput;
  report: ReportAgentOutput;
}
```

### Usage Pattern

```typescript
// Write
memoryStore.set('ingest', ingestOutput)

// Read
const ingestData = memoryStore.get<IngestAgentOutput>('ingest')

// Persist to disk
await memoryStore.save('./output/memory_state.json')
```

---

## Orchestrator

The Orchestrator (`src/index.ts`) initialises all agents, runs them in sequence, passes the shared Memory Store between them, and handles top-level error recovery.

### Pipeline Sequence

```
1. Parse CLI arguments (--pr <number> or --latest)
2. Initialise Memory Store + Audit Log
3. Run IngestAgent         → fetch PR + classify files → write to Memory Store
4. Run TestGeneratorAgent  → generate Vitest + Playwright + k6 → write to Memory Store + disk
5. Run ReportAgent         → score tests + post PR comment → write report to disk
6. Save Memory Store       → ./output/memory_state.json
7. Save Audit Log          → ./output/audit_log.json
8. Exit 0 (go / go-with-caution) or Exit 1 (no-go)
```

### Error Recovery

- If **Ingest Agent** fails → halt immediately; all other agents depend on its output.
- If **Test Generator Agent** fails on one file → log, skip that file, continue with remaining files.
- If **Report Agent** fails to post GitHub comment → save report locally and exit 0; do not fail the pipeline over a comment post failure.

### CLI Interface

```bash
# Analyze a specific PR
npm run dev -- --pr 42

# Analyze the latest open PR
npm run dev -- --latest

# Dry run — generate files but do not post GitHub comment
npm run dev -- --pr 42 --dry-run

# Override base URL for k6 scripts
npm run dev -- --pr 42 --base-url https://staging.example.com
```

### Environment Variables

```env
ANTHROPIC_API_KEY=      # Required — Anthropic API key (Claude Sonnet 4)
GITHUB_TOKEN=           # Required — GitHub PAT with repo + pull_requests scope
GITHUB_OWNER=           # Required — GitHub org or username
GITHUB_REPO=            # Required — Repository name
BASE_URL=               # Optional — Base URL for k6 scripts (default: http://localhost:3000)
```

---

## Token Budget Summary

| Agent | Claude Calls | Approx Input Tokens | Approx Output Tokens |
|-------|-------------|--------------------|--------------------|
| Ingest Agent | 1 | ~3k | ~1k |
| Test Generator Agent | 1 per file (avg 3 files) | ~8k each | ~4k each |
| Report Agent | 1 | ~10k | ~2k |
| **Total (4 files PR)** | **5** | **~37k** | **~15k** |
| **Estimated cost** | | | **~$0.15** |

*Based on Claude Sonnet 4 pricing: $3/MTok input, $15/MTok output*
