export type FileCategory =
  | 'service'
  | 'controller'
  | 'component'
  | 'utility'
  | 'model'
  | 'config'
  | 'test'
  | 'other'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export type GoNoGo = 'go' | 'go-with-caution' | 'no-go'

export interface ChangedFile {
  path: string
  filename: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  content: string
  category: FileCategory[]
  linesAdded: number
  linesRemoved: number
  detectedEndpoints: string[]
  detectedComponents: string[]
  risk: RiskLevel
}

export interface PullRequestMeta {
  number: number
  title: string
  description: string
  author: string
  baseBranch: string
  headBranch: string
  headSha: string
}

export interface IngestAgentOutput {
  pr: PullRequestMeta
  changedFiles: ChangedFile[]
  summary: {
    totalFiles: number
    byCategory: Partial<Record<FileCategory, number>>
    hasApiEndpoints: boolean
    hasUIComponents: boolean
  }
}

export interface GeneratedTestFile {
  outputPath: string
  content: string
}

export interface GeneratedTestBundle {
  sourcePath: string
  vitest?: GeneratedTestFile
  playwright?: GeneratedTestFile
  k6?: GeneratedTestFile
}

export interface TestGeneratorAgentOutput {
  generatedFiles: GeneratedTestBundle[]
  summary: {
    totalFilesProcessed: number
    unitTestsGenerated: number
    uiTestsGenerated: number
    perfTestsGenerated: number
    skippedFiles: string[]
  }
}

export interface TestScore {
  filePath: string
  type: 'unit' | 'ui' | 'perf'
  score: number
  notes: string
}

export interface ReportAgentOutput {
  overallRisk: RiskLevel
  riskReasons: string[]
  testScores: TestScore[]
  averageScore: number
  goNoGo: GoNoGo
  prCommentUrl: string
  reportPath: string
}

export interface MemoryState {
  sessionId: string
  startedAt: string
  ingest?: IngestAgentOutput
  testGenerator?: TestGeneratorAgentOutput
  report?: ReportAgentOutput
}

export interface PipelineInput {
  owner: string
  repo: string
  pullNumber: number
  dryRun?: boolean
  baseUrl?: string
}
