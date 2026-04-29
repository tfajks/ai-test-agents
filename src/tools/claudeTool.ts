import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'

export interface ClaudeCompleteOptions {
  maxTokens?: number
  cacheSystem?: boolean
}

export class ClaudeTool {
  private client: AnthropicBedrock
  readonly model: string

  constructor(model = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6') {
    this.client = new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? 'us-east-1',
    })
    this.model = model
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    options: ClaudeCompleteOptions = {}
  ): Promise<string> {
    const { maxTokens = 8192 } = options

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })

    const message = await stream.finalMessage()

    for (const block of message.content) {
      if (block.type === 'text') return block.text
    }
    throw new Error('No text content in Claude response')
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
