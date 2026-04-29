import fs from 'fs'
import path from 'path'
import { MemoryState } from '../types'

export class MemoryStore {
  private state: MemoryState

  constructor(sessionId: string) {
    this.state = {
      sessionId,
      startedAt: new Date().toISOString(),
    }
  }

  set<K extends keyof Omit<MemoryState, 'sessionId' | 'startedAt'>>(
    key: K,
    value: NonNullable<MemoryState[K]>
  ): void {
    (this.state as unknown as Record<string, unknown>)[key] = value
  }

  get<K extends keyof MemoryState>(key: K): NonNullable<MemoryState[K]> {
    const value = this.state[key]
    if (value === undefined) {
      throw new Error(`MemoryStore: key '${key}' not set`)
    }
    return value as NonNullable<MemoryState[K]>
  }

  has(key: keyof MemoryState): boolean {
    return this.state[key] !== undefined
  }

  getState(): Readonly<MemoryState> {
    return this.state
  }

  async save(filePath: string): Promise<void> {
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(filePath, JSON.stringify(this.state, null, 2), 'utf8')
  }
}
