export interface AssemblyApiError extends Error {
  status: number
  body: {
    message: string
  }
}

export function isAssemblyApiError(err: unknown): err is AssemblyApiError {
  if (!(err instanceof Error)) return false

  // @ts-expect-error
  const error = err as Record<string, unknown>

  if (typeof error.status !== 'number') return false
  if (!error.body || typeof error.body !== 'object') return false

  const body = error.body as Record<string, unknown>

  return typeof body.message === 'string'
}
