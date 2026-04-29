# Happy Path Walkthrough

This document walks through a complete end-to-end execution of the Intelligent Test Automation Agent for a typical Pull Request — 4 changed TypeScript files, a running webhook server, and all environment variables configured.

---

## Setup assumptions

- Webhook server is running and publicly accessible (e.g. via Railway or ngrok)
- GitHub App is installed on the target repository
- `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `WEBHOOK_SECRET`, and `BASE_URL` are set in `.env`
- The PR contains 4 changed files: `authService.ts`, `userController.ts`, `LoginForm.tsx`, `userModel.ts`

---

## Step 1 — Developer opens a Pull Request

A developer pushes a branch and opens PR #42: `feat: add user authentication endpoints`.

GitHub detects the `pull_request.opened` event and immediately sends a `POST /webhook` request to the server with a JSON payload describing the PR and a `X-Hub-Signature-256` header containing the HMAC SHA256 signature of the payload body.

---

## Step 2 — Webhook Server receives and validates the request

The Express server receives the request. It computes the expected HMAC signature using `WEBHOOK_SECRET` and compares it to the header using `crypto.timingSafeEqual`. The signatures match — the request is authentic.

The server checks `x-github-event: pull_request` and `action: opened` — this is a trigger event. It extracts `owner`, `repo`, and `pull_number` from the payload, responds `202 Accepted` to GitHub immediately (before any agent runs), and calls `runPipeline()` asynchronously in the background.

GitHub marks the webhook delivery as successful. Total time: under 100ms.

---

## Step 3 — Orchestrator initialises

`runPipeline()` creates a new `MemoryStore` instance and an `AuditLog` instance, both scoped to this pipeline run with a unique `sessionId`. It then runs the three agents in sequence.

---

## Step 4 — Ingest Agent runs

The Ingest Agent calls `octokit.rest.pulls.listFiles()` to get the list of changed files. It finds 4 files matching the `.ts` / `.tsx` filter:

- `src/services/authService.ts` — 180 lines added
- `src/controllers/userController.ts` — 95 lines added
- `src/components/LoginForm.tsx` — 62 lines added
- `src/models/userModel.ts` — 44 lines added

For each file it calls `octokit.rest.repos.getContent()`, base64-decodes the response, and stores the full source content. It then calls Claude once with all four file summaries and asks for classification, endpoint detection, and risk assessment.

Claude responds with:

- `authService.ts` → categories: `service`, risk: `high` (JWT signing), endpoints: `POST /api/auth/login`, `POST /api/auth/refresh`
- `userController.ts` → categories: `controller`, risk: `medium`, endpoints: `GET /api/users`, `POST /api/users`, `DELETE /api/users/:id`
- `LoginForm.tsx` → categories: `component`, risk: `low`, components: `LoginForm`
- `userModel.ts` → categories: `model`, risk: `low`, endpoints: none

All results are written to the Memory Store under the `ingest` key. Audit log records 6 entries. Total time: ~4 seconds, ~3k tokens.

---

## Step 5 — Test Generator Agent runs

The agent reads the `ingest` output from the Memory Store. It iterates over the 4 changed files, skipping none (all have testable content). For each file it calls Claude once with the source code and a structured prompt requesting all three test types as a JSON object.

**File 1: authService.ts** (~8k tokens in, ~4k out)
Claude returns:
- `vitest`: 6 test cases — `hashPassword` happy path + wrong input, `verifyToken` valid + expired + tampered, `createSession` success + DB error. All external calls mocked with `vi.mock()`.
- `playwright`: `null` — no UI components detected.
- `k6`: smoke + load stages for `POST /api/auth/login` and `POST /api/auth/refresh`, tagged requests, `p(95)<500` threshold.

Output written to `output/unit/authService.test.ts` and `output/perf/authService.k6.js`.

**File 2: userController.ts** (~7k tokens in, ~3.5k out)
Claude returns:
- `vitest`: 8 test cases covering all 3 CRUD endpoints, error paths, and 404 handling.
- `playwright`: `null` — controller file, no UI.
- `k6`: load test for all 3 endpoints with auth header, realistic ramp-up (10 → 30 VUs over 5 minutes).

Output written to `output/unit/userController.test.ts` and `output/perf/userController.k6.js`.

**File 3: LoginForm.tsx** (~6k tokens in, ~3k out)
Claude returns:
- `vitest`: 4 test cases — renders correctly, email validation, password validation, submit calls handler.
- `playwright`: Page Object `LoginFormPage.ts` + spec with 5 scenarios: happy path login, empty email error, invalid email format, empty password error, API error state.
- `k6`: `null` — pure UI component, no HTTP endpoints.

Output written to `output/unit/LoginForm.test.ts`, `output/ui/pages/LoginFormPage.ts`, `output/ui/login-form.spec.ts`.

**File 4: userModel.ts** (~4k tokens in, ~2k out)
Claude returns:
- `vitest`: 4 test cases — `createUser`, `findById` hit + miss, `deleteUser` success + not found.
- `playwright`: `null`.
- `k6`: `null`.

Output written to `output/unit/userModel.test.ts`.

All file paths and metadata written to Memory Store under `testGenerator` key. Total time: ~35 seconds, ~25k tokens in / ~12.5k out across 4 calls.

---

## Step 6 — Report Agent runs

The Report Agent reads all generated test content from the Memory Store and calls Claude once with everything — PR metadata, changed files summary, and the full content of all 8 generated files.

Claude scores each file:

| File | Score | Notes |
|------|-------|-------|
| authService.test.ts | 8/10 | Good coverage, token expiry edge case missing |
| userController.test.ts | 9/10 | Comprehensive, clean mocking |
| LoginForm.test.ts | 7/10 | Missing loading state test |
| userModel.test.ts | 8/10 | All CRUD paths covered |
| login-form.spec.ts | 8/10 | Good POM structure, no mobile viewport check |
| authService.k6.js | 9/10 | Realistic ramp, good thresholds |
| userController.k6.js | 8/10 | All endpoints covered |

Overall risk: `high` — `authService.ts` handles JWT signing and token verification.
Go/No-Go: `go-with-caution` — high risk file but tests are solid; recommend manual review of token expiry scenarios.

The agent then calls `octokit.rest.issues.createComment()` to post the Markdown report on PR #42 and writes `output/report-pr-42.json` to disk.

Total time: ~8 seconds, ~10k tokens in / ~2k out.

---

## Step 7 — Cleanup and exit

The Orchestrator saves the full Memory Store to `output/memory_state.json` and the Audit Log to `output/audit_log.json`. Because the Go/No-Go is `go-with-caution` (not `no-go`), the process exits with code `0`.

---

## End-to-end summary

| Step | Actor | Duration | Claude tokens |
|------|-------|----------|--------------|
| Webhook validation | Express server | <100ms | 0 |
| Ingest | Ingest Agent | ~4s | ~3k in / ~1k out |
| Test generation (×4) | Test Generator Agent | ~35s | ~25k in / ~12.5k out |
| Scoring + report | Report Agent | ~8s | ~10k in / ~2k out |
| **Total** | | **~48 seconds** | **~38k in / ~15.5k out** |
| **Estimated cost** | | | **~$0.15** |

---

## Output files produced

```
output/
├── unit/
│   ├── authService.test.ts
│   ├── userController.test.ts
│   ├── LoginForm.test.ts
│   └── userModel.test.ts
├── ui/
│   ├── pages/LoginFormPage.ts
│   └── login-form.spec.ts
├── perf/
│   ├── authService.k6.js
│   └── userController.k6.js
├── report-pr-42.json
├── memory_state.json
└── audit_log.json
```
