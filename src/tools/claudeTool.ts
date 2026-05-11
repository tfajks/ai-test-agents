import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'

export interface ClaudeCompleteOptions {
  maxTokens?: number
  cacheSystem?: boolean
  onToken?: (text: string) => void
}

interface BedrockResponse {
  content: Array<{ type: string; text: string }>
}

export class ClaudeTool {
  private client: BedrockRuntimeClient
  readonly model: string

  constructor(model = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6') {
    this.client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
    })
    this.model = model
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    options: ClaudeCompleteOptions = {}
  ): Promise<string> {
    const { maxTokens = 8192, onToken } = options

    let spinnerInterval: ReturnType<typeof setInterval> | undefined
    if (onToken) {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      let i = 0
      process.stdout.write('  ')
      spinnerInterval = setInterval(() => {
        process.stdout.write(`\r  ${frames[i++ % frames.length]}  thinking...`)
      }, 80)
    }

    try {
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })

      const command = new InvokeModelCommand({
        modelId: this.model,
        contentType: 'application/json',
        accept: 'application/json',
        body: Buffer.from(body),
      })

      const response = await this.client.send(command)
      const responseBody = JSON.parse(Buffer.from(response.body).toString('utf8')) as BedrockResponse

      if (spinnerInterval) {
        clearInterval(spinnerInterval)
        process.stdout.write('\r  ✓  done' + ' '.repeat(20) + '\n')
      }

      const textBlock = responseBody.content.find((b) => b.type === 'text')
      if (!textBlock) throw new Error('No text content in Claude response')
      return textBlock.text

    } catch (err) {
      if (spinnerInterval) {
        clearInterval(spinnerInterval)
        process.stdout.write('\r' + ' '.repeat(30) + '\r')
      }
      throw err
    }
  }

  async completeJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    options: ClaudeCompleteOptions = {}
  ): Promise<T> {
    const text = await this.complete(systemPrompt, userPrompt, options)
    try {
      return JSON.parse(text) as T
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          return JSON.parse(match[0]) as T
        } catch (e) {
          throw new Error(`Failed to parse JSON from Claude response: ${(e as Error).message}`)
        }
      }
      throw new Error('No valid JSON found in Claude response')
    }
  }
}
