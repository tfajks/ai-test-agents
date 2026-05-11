const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const RED = '\x1b[31m'
const MAGENTA = '\x1b[35m'

export class Logger {
  private startTime = Date.now()

  private elapsed(): string {
    return `${((Date.now() - this.startTime) / 1000).toFixed(1)}s`
  }

  section(title: string, icon = '▶'): void {
    console.log(`\n${BOLD}${CYAN}${'━'.repeat(50)}${RESET}`)
    console.log(`${BOLD}${CYAN}${icon}  ${title}${RESET}`)
    console.log(`${BOLD}${CYAN}${'━'.repeat(50)}${RESET}`)
  }

  step(msg: string): void {
    process.stdout.write(`  ${DIM}⟳${RESET}  ${msg}...\n`)
  }

  ok(msg: string): void {
    console.log(`  ${GREEN}✓${RESET}  ${msg}`)
  }

  warn(msg: string): void {
    console.log(`  ${YELLOW}⚠${RESET}  ${msg}`)
  }

  skip(msg: string): void {
    console.log(`  ${DIM}–  ${msg}${RESET}`)
  }

  error(msg: string): void {
    console.log(`  ${RED}✗${RESET}  ${msg}`)
  }

  streamHeader(label: string): void {
    process.stdout.write(`\n  ${MAGENTA}${BOLD}Claude ›${RESET} ${DIM}[${label}]${RESET}\n  `)
  }

  token(text: string): void {
    process.stdout.write(text)
  }

  streamEnd(): void {
    process.stdout.write('\n')
  }

  done(msg: string): void {
    console.log(`\n${GREEN}${BOLD}✔  ${msg}${RESET}  ${DIM}(${this.elapsed()})${RESET}`)
  }

  info(msg: string): void {
    console.log(`  ${DIM}${msg}${RESET}`)
  }
}
