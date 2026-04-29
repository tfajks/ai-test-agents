import 'dotenv/config'
import express, { Request, Response } from 'express'
import crypto from 'crypto'
import { runPipeline } from './index'

const app = express()

app.use(express.raw({ type: 'application/json' }))

const activeRuns = new Set<string>()

app.post('/webhook', (req: Request, res: Response) => {
  const sig = req.headers['x-hub-signature-256'] as string | undefined
  const secret = process.env.WEBHOOK_SECRET

  if (!sig || !secret) {
    res.status(401).send('Missing signature or secret')
    return
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.body as Buffer)
    .digest('hex')

  if (
    Buffer.byteLength(sig) !== Buffer.byteLength(expected) ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    res.status(401).send('Invalid signature')
    return
  }

  const payload = JSON.parse((req.body as Buffer).toString()) as {
    action?: string
    pull_request?: {
      number: number
      base: { repo: { name: string; owner: { login: string } } }
    }
  }
  const event = req.headers['x-github-event']

  if (event !== 'pull_request') {
    res.status(200).send('Skipped')
    return
  }

  if (!payload.action || !['opened', 'synchronize'].includes(payload.action)) {
    res.status(200).send('Skipped')
    return
  }

  if (!payload.pull_request) {
    res.status(400).send('Missing pull_request payload')
    return
  }

  const { number, base: { repo: { name, owner: { login } } } } = payload.pull_request
  const runKey = `${login}/${name}`

  if (activeRuns.has(runKey)) {
    res.status(202).send('Pipeline already running for this repo')
    return
  }

  res.status(202).send('Accepted')

  activeRuns.add(runKey)
  runPipeline({ owner: login, repo: name, pullNumber: number })
    .catch((err: unknown) => console.error('Pipeline error:', (err as Error).message))
    .finally(() => activeRuns.delete(runKey))
})

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', activeRuns: activeRuns.size })
})

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => console.log(`Webhook server listening on :${PORT}`))

export { app }
