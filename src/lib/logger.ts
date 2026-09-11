import util from 'node:util'

type LogLevel = 'log' | 'info' | 'warn' | 'error'

// Only object args get the depth/length caps; string args are logged as-is. Pass the
// raw object (not JSON.stringify(obj)) if you want a large value to be bounded.
export interface Logger {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

// Lower rank = more verbose. LOG_LEVEL sets the minimum level that prints.
const LEVEL_RANK: Record<LogLevel, number> = { log: 0, info: 1, warn: 2, error: 3 }

const parseLevel = (value: string | undefined): LogLevel => {
  const level = value?.toLowerCase()
  return level === 'log' || level === 'info' || level === 'warn' || level === 'error'
    ? level
    : 'info'
}

// Read per call so the level can be set without a rebuild (and stays testable).
const minRank = (): number => LEVEL_RANK[parseLevel(process.env.LOG_LEVEL)]

// How many object levels to print. Deep enough to show nested payloads (e.g. a
// batched item's opts/file), still capped so a line can't dump everything.
const DEFAULT_DEPTH = 4

const parseDepth = (): number => {
  const raw = Number(process.env.LOG_DEPTH)
  return Number.isInteger(raw) && raw >= 0 && raw <= 10 ? raw : DEFAULT_DEPTH
}

// breakLength: Infinity keeps each log on one physical line so line-based log
// collectors don't split a wrapped object across entries.
function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  return util.inspect(arg, {
    depth: parseDepth(),
    colors: Boolean(process.stdout.isTTY),
    maxArrayLength: 10,
    maxStringLength: 512,
    breakLength: Infinity,
  })
}

function loggerFactory(level: LogLevel): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    if (LEVEL_RANK[level] < minRank()) return
    const line = args.map(formatArg).join(' ')
    // biome-ignore lint/suspicious/noConsole: this is the single console entry point
    console[level](line)
  }
}

export const logger: Logger = {
  log: loggerFactory('log'),
  info: loggerFactory('info'),
  warn: loggerFactory('warn'),
  error: loggerFactory('error'),
}

export default logger
