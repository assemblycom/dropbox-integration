// Test-only double of @trigger.dev/sdk (and /v3): runs each task's own run() inline so
// integration tests drive the real task graph with no Trigger server. Matches the real
// error contract — *AndWait resolve a TaskRunResult (never reject), trigger/batchTrigger
// are fire-and-forget, batches always run every item. Concurrency is not modelled (L2).

interface TaskConfig<P> {
  id: string
  run: (payload: P) => unknown | Promise<unknown>
  // config keys (machine/queue/retry/cron/…) are accepted and ignored.
  [key: string]: unknown
}

// Mirrors @trigger.dev/core's TaskRunResult.
type RunResult =
  | { ok: true; id: string; taskIdentifier: string; output: unknown }
  | { ok: false; id: string; taskIdentifier: string; error: unknown }

export interface InlineTaskHandle<P> {
  trigger(payload: P, options?: unknown): Promise<{ id: string }>
  triggerAndWait(payload: P, options?: unknown): Promise<RunResult>
  batchTrigger(items: { payload: P }[], options?: unknown): Promise<{ id: string }>
  batchTriggerAndWait(
    items: { payload: P }[],
    options?: unknown,
  ): Promise<{ id: string; runs: RunResult[] }>
}

// biome-ignore lint/suspicious/noExplicitAny: the double mirrors the SDK's loose payload generics.
export function task<P = any>(config: TaskConfig<P>): InlineTaskHandle<P> {
  const { id, run } = config

  // Run inline; capture success/throw as a result rather than rejecting.
  const runToResult = async (payload: P): Promise<RunResult> => {
    try {
      const output = await run(payload)
      return { ok: true, id, taskIdentifier: id, output }
    } catch (error) {
      return { ok: false, id, taskIdentifier: id, error }
    }
  }

  return {
    async trigger(payload) {
      await runToResult(payload) // fire-and-forget: swallow failures
      return { id }
    },
    triggerAndWait(payload) {
      return runToResult(payload)
    },
    async batchTrigger(items) {
      for (const item of items) await runToResult(item.payload)
      return { id }
    },
    async batchTriggerAndWait(items) {
      const runs: RunResult[] = []
      for (const item of items) runs.push(await runToResult(item.payload))
      return { id, runs }
    },
  }
}

export const schedules = { task }

const noop = (..._args: unknown[]): void => {
  /* no-op */
}
export const logger = {
  info: noop,
  error: noop,
  warn: noop,
  debug: noop,
  log: noop,
  trace: noop,
}

// Stub so withErrorLogger's `instanceof ApiError` resolves without the real SDK.
export class ApiError extends Error {
  status?: number
  constructor(message?: string) {
    super(message)
    this.name = 'ApiError'
  }
}
