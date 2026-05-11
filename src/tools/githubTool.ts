import { Octokit } from '@octokit/rest'
import { PullRequestMeta } from '../types'

// Suppress Octokit deprecation warnings for getContent (scheduled removal 2028)
const originalWarn = console.warn
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('@octokit/request')) return
  originalWarn(...args)
}

export interface RawChangedFile {
  filename: string
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  sha: string
}

export class GitHubTool {
  private octokit: Octokit

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token })
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestMeta> {
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })
    return {
      number: data.number,
      title: data.title,
      description: data.body ?? '',
      author: data.user?.login ?? 'unknown',
      baseBranch: data.base.ref,
      headBranch: data.head.ref,
      headSha: data.head.sha,
    }
  }

  async listChangedFiles(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<RawChangedFile[]> {
    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    })
    return files.map((f) => ({
      filename: f.filename,
      status: f.status as RawChangedFile['status'],
      additions: f.additions,
      deletions: f.deletions,
      sha: f.sha,
    }))
  }

  async getFileContent(
    owner: string,
    repo: string,
    filePath: string,
    ref: string
  ): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref,
      })
      if (Array.isArray(data) || data.type !== 'file') return null
      if (!data.content) return null
      return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) return null
      throw err
    }
  }

  async createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<string> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    })
    return data.html_url
  }

  async getLatestOpenPR(owner: string, repo: string): Promise<number | null> {
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      sort: 'created',
      direction: 'desc',
      per_page: 1,
    })
    return data.length > 0 ? data[0].number : null
  }
}
