import fs from 'fs'
import path from 'path'

export interface AuditEntry {
  timestamp: string
  agent: string
  action: string
  input?: unknown
  output?: unknown
  reasoning?: string
}

export class AuditLog {
  private entries: AuditEntry[] = []

  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    this.entries.push({ timestamp: new Date().toISOString(), ...entry })
  }

  getEntries(): ReadonlyArray<AuditEntry> {
    return this.entries
  }

  async save(filePath: string): Promise<void> {
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(filePath, JSON.stringify(this.entries, null, 2), 'utf8')
  }
}
