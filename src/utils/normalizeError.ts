import { DropboxResponseError } from 'dropbox'
import { isCopilotApiError } from '@/lib/copilot/CopilotAPI'

export const normalizeError = (error: unknown): string => {
  if (isCopilotApiError(error)) {
    return `HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ''} — ${error.body?.message ?? 'no body message'}${error.url ? ` (url: ${error.url})` : ''}`
  }
  if (error instanceof DropboxResponseError) {
    return `${error.status}: ${typeof error.error === 'string' ? error.error : JSON.stringify(error.error)}`
  }
  if (error instanceof Error) return error.message
  return String(error)
}
