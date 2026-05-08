# 🧪 Intelligent Test Automation Agent

> Accelerating Engineering Through AI-First Agentic Solutions

---

## Overview

The **Intelligent Test Automation Agent** is a multi-agent AI system that analyzes GitHub Pull Requests and automatically generates targeted, production-ready tests — eliminating the manual effort of deciding *what* to test after every code change.

The system detects which files changed in a PR, understands the intent of those changes using Claude AI, and produces three types of tests covering the full quality spectrum: unit tests, UI tests, and performance tests. It then posts a structured report as a GitHub PR comment with a risk assessment.

---

## Problem Statement

Engineering teams face a consistent challenge: after every PR, developers must manually decide which tests to write, which existing tests are now outdated, and whether the changes could introduce a performance regression. This process is slow, inconsistent, and often skipped under deadline pressure. The result is reduced test coverage, missed regressions, and fragile deployments.

The Intelligent Test Automation Agent solves this by embedding AI directly into the PR workflow — analyzing changes in seconds and generating contextually relevant tests automatically.

---

## Architecture

```
Developer opens / updates PR
           │
           ▼ POST /webhook
┌─────────────────────┐
│   Webhook Server    │  Verifies HMAC signature, returns 202 immediately
│   (Express)         │  Triggers pipeline async — GitHub never times out
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   Ingest Agent      │  Fetches PR diff + reads file contents from GitHub
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐     ┌──────────────────┐
│  Test Generator     │────►│  Memory Store    │
│      Agent          │◄────│                  │
│                     │     │ • PR context     │
│ One Claude call →   │     │ • Changed files  │
│ • Vitest tests      │     │ • Generated tests│
│ • Playwright specs  │     │ • Audit log      │
│ • k6 scripts        │     └──────────────────┘
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   Report Agent      │  Scores tests, assesses risk, posts PR comment
└─────────────────────┘
```

---

## Agents

| Agent | Responsibility | Input | Output |
|-------|---------------|-------|--------|
| **Ingest Agent** | Fetches PR diff and file contents from GitHub | PR number + repo | Changed files with content + metadata |
| **Test Generator Agent** | Generates all three test types in a single Claude call | Source code files | Vitest + Playwright + k6 files |
| **Report Agent** | Scores tests, assesses PR risk, posts GitHub comment | All generated tests | PR comment + JSON report |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript |
| AI Model | Claude claude-sonnet-4-20250514 (Anthropic API) |
| GitHub Integration | Octokit REST API |
| Unit Testing Framework | Vitest |
| UI Testing Framework | Playwright |
| Performance Testing | k6 |
| Memory / State | In-process store with JSON persistence |
| Output | Markdown report + GitHub PR comment |

---

## Project Structure

```
ai-test-agents/
├── src/
│   ├── agents/
│   │   ├── ingestAgent.ts          # Fetches PR data from GitHub
│   │   ├── testGeneratorAgent.ts   # Generates Vitest + Playwright + k6
│   │   └── reportAgent.ts          # Scores, assesses risk, posts PR comment
│   ├── tools/
│   │   ├── githubTool.ts           # GitHub API wrapper (Octokit)
│   │   └── claudeTool.ts           # Anthropic API wrapper
│   ├── memory/
│   │   └── memoryStore.ts          # Shared state between agents
│   ├── audit/
│   │   └── auditLog.ts             # Decision trail for all agents
│   ├── server.ts                   # Express webhook server (GitHub App)
│   └── index.ts                    # Orchestrator — runPipeline() function
├── output/                         # Generated test files + reports
├── docs/
│   ├── webhook-server.md
│   ├── agent-ingest.md
│   ├── agent-test-generator.md
│   ├── agent-report.md
│   └── architecture-memory-orchestrator.md
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- Anthropic API key
- GitHub Personal Access Token (with `repo` and `pull_requests` scope)

### Installation

```bash
git clone https://github.com/your-username/ai-test-agents.git
cd ai-test-agents
npm install
cp .env.example .env
# Fill in your keys in .env
```

### Configuration

```env
ANTHROPIC_API_KEY=your_anthropic_api_key
GITHUB_TOKEN=your_github_app_installation_token
GITHUB_OWNER=your_org_or_username
GITHUB_REPO=your_repository
WEBHOOK_SECRET=your_github_app_webhook_secret
BASE_URL=http://localhost:3000
```

### Running

```bash
# Start webhook server (production mode)
npm run start

# Manual CLI run — analyze a specific PR
npm run dev -- --pr 42

# Manual CLI run — analyze latest open PR
npm run dev -- --latest

# Dry run (generate files but do not post GitHub comment)
npm run dev -- --pr 42 --dry-run
```

---

## Sample Output

After running against a PR, the agent posts a comment like this:

```markdown
## 🤖 AI Test Automation Report

**PR #42** — `feat: add user authentication endpoints`
**Risk Level:** 🟡 Medium  
**Files analyzed:** 4 | **Tests generated:** 3 files

### Generated Tests

| Type | File |
|------|------|
| Unit (Vitest) | authService.test.ts |
| UI (Playwright) | login.spec.ts |
| Performance (k6) | auth-load.k6.js |

### Risk Assessment
- ⚠️ `authService.ts` — handles token signing, high security impact
- ✅ `userModel.ts` — CRUD operations, well covered by generated tests

### Go/No-Go: 🟡 Go with caution
```

---

## AI Usage Across the SDLC

| SDLC Phase | AI Contribution |
|-----------|----------------|
| **Planning** | Risk assessment of PR — which changes are high risk |
| **Development** | Unit test generation during PR review |
| **QA** | UI test generation for affected user flows |
| **Performance** | k6 script generation for changed endpoints |
| **Release** | Final report with go/no-go signal |
| **Operations** | Audit log of all AI decisions for post-mortems |

---

## Cost Profile

| Metric | Value |
|--------|-------|
| Claude calls per PR | 3 (one per agent) |
| Avg tokens per run | ~35k input / ~12k output |
| Estimated cost per PR | ~$0.15 |
| Model | Claude Sonnet 4 |

---

## Certification Context

This project was built as part of the **Senior RDE AI Engineer Certification** at Accenture. It demonstrates:

- Multi-agent orchestration with shared memory and audit trail
- Real GitHub API integration for PR analysis
- AI-generated tests across unit, UI, and performance layers
- LLM-as-judge evaluation methodology in the Report Agent
- Enterprise-grade architecture with modular, extensible agent design
