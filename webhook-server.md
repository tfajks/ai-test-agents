# Webhook Server

## Role

The Webhook Server is the entry point for production deployments. It exposes a single `POST /webhook` endpoint that receives GitHub App event payloads, verifies their authenticity, and triggers the agent pipeline automatically on every Pull Request open or update event.

---

## Why a GitHub App webhook

A CLI tool works for demos and local development. In a real enterprise environment, no one runs commands manually after every PR. The webhook turns the system into a **always-on service** — any PR in any connected repository triggers the pipeline automatically, with no human intervention.

---

## How it works

```
Developer opens or updates a PR
           │
           ▼
   GitHub App sends POST /webhook
           │
           ▼
   Express validates X-Hub-Signature-256 (HMAC SHA256)
           │  invalid → 401, pipeline never starts
           │  valid   ↓
   Parse event payload
           │  not pull_request opened/synchronize → 200, skip
           │  is pull_request ↓
   Extract owner, repo, pr number
           │
           ▼
   Trigger Orchestrator (async, non-blocking)
           │
           ▼  (immediately)
   Return 202 Accepted to GitHub
           │
           ▼  (background)
   3 agents run → PR comment posted
```

GitHub expects a response within **10 seconds** or it marks the delivery as failed and retries. The server responds `202 Accepted` immediately and runs the pipeline in the background — the agents may take 30–60 seconds but GitHub never times out.

---

## Files

```
src/
├── server.ts          # Express app — webhook endpoint + HMAC verification
└── index.ts           # Orchestrator — now callable as a function, not just CLI
```

---

## server.ts implementation spec

```typescript
import express from 'express'
import crypto from 'crypto'
import { runPipeline } from './index'

const app = express()

app.use(express.raw({ type: 'application/json' }))

app.post('/webhook', (req, res) => {
  // 1. Verify HMAC signature
  const sig = req.headers['x-hub-signature-256'] as string
  const secret = process.env.WEBHOOK_SECRET!
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.body)
    .digest('hex')

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).send('Invalid signature')
  }

  // 2. Parse payload
  const payload = JSON.parse(req.body.toString())
  const event = req.headers['x-github-event']

  // 3. Filter — only act on PR open or update
  if (event !== 'pull_request') return res.status(200).send('Skipped')
  if (!['opened', 'synchronize'].includes(payload.action)) {
    return res.status(200).send('Skipped')
  }

  // 4. Respond immediately — run pipeline in background
  res.status(202).send('Accepted')

  const { number, base: { repo: { name, owner: { login } } } } = payload.pull_request
  runPipeline({ owner: login, repo: name, pullNumber: number })
    .catch(err => console.error('Pipeline error:', err))
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Webhook server listening on :${PORT}`))
```

---

## Environment variables

```env
ANTHROPIC_API_KEY=      # Required
GITHUB_TOKEN=           # Required — GitHub App installation token
WEBHOOK_SECRET=         # Required — set when creating the GitHub App
PORT=3000               # Optional — default 3000
BASE_URL=               # Optional — for k6 scripts
```

---

## GitHub App setup

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set **Webhook URL** to your server's public URL: `https://your-server.com/webhook`
3. Set **Webhook secret** — copy the value to `WEBHOOK_SECRET` in your `.env`
4. Under **Permissions**, enable:
   - Repository contents: Read
   - Pull requests: Read & Write (needed to post comments)
5. Under **Subscribe to events**, check: `Pull request`
6. Install the app on the target repository

---

## Deployment — AWS Elastic Beanstalk (current)

The server is deployed to **AWS Elastic Beanstalk** (Node.js 20 on AL2023):

| Item | Value |
|------|-------|
| Environment | `ai-test-agents-prod` |
| Region | `us-east-1` |
| URL | `http://ai-test-agents-prod.eba-pik3yw2m.us-east-1.elasticbeanstalk.com` |
| Webhook endpoint | `.../webhook` |
| Health endpoint | `.../health` |

### Checking server health

**Browser / curl:**
```
http://ai-test-agents-prod.eba-pik3yw2m.us-east-1.elasticbeanstalk.com/health
```

**PowerShell:**
```powershell
Invoke-WebRequest http://ai-test-agents-prod.eba-pik3yw2m.us-east-1.elasticbeanstalk.com/health
```

**Expected response:**
```json
{"status":"ok","activeRuns":0}
```

`activeRuns` shows how many pipelines are currently running (at most 1 per repo due to rate limiting).

### Checking EB environment status

```powershell
aws elasticbeanstalk describe-environments `
  --environment-names ai-test-agents-prod `
  --region us-east-1 `
  --query "Environments[0].[Status,Health,VersionLabel]" `
  --output text
```

Returns e.g. `Ready   Green   v6` — healthy and running.

### Viewing recent EB events (errors, deploys)

```powershell
aws elasticbeanstalk describe-events `
  --environment-name ai-test-agents-prod `
  --region us-east-1 `
  --max-items 10 `
  --query "Events[*].[Severity,Message]" `
  --output table
```

### Adding / updating environment variables

EB does **not** load `.env` — variables must be set explicitly:

```powershell
aws elasticbeanstalk update-environment `
  --application-name ai-test-agents `
  --environment-name ai-test-agents-prod `
  --region us-east-1 `
  --option-settings `
    "Namespace=aws:elasticbeanstalk:application:environment,OptionName=GITHUB_TOKEN,Value=YOUR_TOKEN" `
    "Namespace=aws:elasticbeanstalk:application:environment,OptionName=WEBHOOK_SECRET,Value=YOUR_SECRET"
```

Required variables:

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub PAT with `repo` scope |
| `WEBHOOK_SECRET` | Must match the secret set in the GitHub webhook |
| `AWS_REGION` | Already set — `us-east-1` |
| `BEDROCK_MODEL_ID` | Already set — `us.anthropic.claude-sonnet-4-6` |
| `GITHUB_OWNER` | Already set — `tfajks` |
| `GITHUB_REPO` | Already set — `uigen` |

### Redeploying after code changes

```powershell
# 1. Rebuild TypeScript
npm run build

# 2. Create ZIP with forward-slash paths (required for Linux extraction)
# Run the PowerShell script: scripts/package.ps1
# Or manually via System.IO.Compression (see deploy notes)

# 3. Upload and create new version
aws s3 cp deploy-vN.zip s3://elasticbeanstalk-us-east-1-381491969811/ai-test-agents/deploy-vN.zip
aws elasticbeanstalk create-application-version --application-name ai-test-agents --version-label vN --source-bundle S3Bucket=elasticbeanstalk-us-east-1-381491969811,S3Key=ai-test-agents/deploy-vN.zip --region us-east-1
aws elasticbeanstalk update-environment --environment-name ai-test-agents-prod --version-label vN --region us-east-1
```

> **Important:** Use `System.IO.Compression.ZipArchive` (not `Compress-Archive`) to create the ZIP — `Compress-Archive` generates Windows backslash paths that EB/Linux cannot extract correctly.

### GitHub webhook configuration

The webhook is registered on `tfajks/uigen` (webhook ID `619749955`):

- URL: `http://ai-test-agents-prod.eba-pik3yw2m.us-east-1.elasticbeanstalk.com/webhook`
- Events: `pull_request` only
- Secret: matches `WEBHOOK_SECRET` in EB env vars

To update the webhook URL (e.g. after redeployment to a new domain):
```powershell
curl -X PATCH `
  -H "Authorization: token YOUR_GITHUB_TOKEN" `
  -H "Content-Type: application/json" `
  https://api.github.com/repos/tfajks/uigen/hooks/619749955 `
  -d '{"config":{"url":"https://NEW-URL/webhook","content_type":"json","secret":"YOUR_SECRET"}}'
```

---

## Other deployment options

| Platform | Notes |
|----------|-------|
| **AWS Lambda + API Gateway** | Best for low-traffic; zero cost at idle |
| **Azure Functions** | Natural fit for Accenture/enterprise environments |
| **Google Cloud Run** | Auto-scales to zero; simple Docker deploy |
| **Railway / Render** | Fastest to set up for demos |

---

## Security notes

- Always use `crypto.timingSafeEqual` for signature comparison — never string equality (`===`). String equality is vulnerable to timing attacks.
- Use `express.raw()` not `express.json()` — the HMAC is computed over the raw body bytes. Parsing JSON first changes the bytes and invalidates the signature.
- The `WEBHOOK_SECRET` must be a random string of at least 32 characters. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- Never log the full payload in production — it contains repository metadata and PR content.

---

## Audit Log Entries

```json
{ "agent": "WebhookServer", "action": "REQUEST_RECEIVED", "input": { "event": "pull_request", "action": "opened", "pr": 42 } }
{ "agent": "WebhookServer", "action": "SIGNATURE_VALID", "output": { "repo": "org/repo" } }
{ "agent": "WebhookServer", "action": "PIPELINE_TRIGGERED", "output": { "pr": 42, "async": true } }
{ "agent": "WebhookServer", "action": "SIGNATURE_INVALID", "reasoning": "401 returned, pipeline not started" }
```
