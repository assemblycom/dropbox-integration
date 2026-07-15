import httpStatus from 'http-status'
import { HttpResponse } from 'msw'

function statusText(status: number): string {
  const text = (httpStatus as unknown as Record<number, string>)[status]
  return typeof text === 'string' ? text : 'Error'
}

// Copilot: the SDK turns a 4xx JSON body into the ApiError shape isCopilotApiError checks.
export function copilotError({ status, body }: { status: number; body: Record<string, unknown> }) {
  return HttpResponse.json(body, { status, statusText: statusText(status) })
}

export const copilotFolderExists = () =>
  copilotError({ status: 400, body: { message: 'Folder already exists' } })

export const copilotNotFound = (body: Record<string, unknown> = { message: 'Not found' }) =>
  copilotError({ status: 404, body })

// Dropbox: the SDK puts the JSON body on DropboxResponseError.error.
// Prod reads err.error.error.path['.tag'] and err.error.error_summary.
export function dropboxRpcError({
  status,
  errorSummary,
  error,
}: {
  status: number
  errorSummary: string
  error: Record<string, unknown>
}) {
  return HttpResponse.json(
    { error_summary: errorSummary, error },
    { status, statusText: statusText(status) },
  )
}

// not_found via the path tag (get_metadata branch).
export const dropboxGetMetadataNotFound = () =>
  dropboxRpcError({
    status: 409,
    errorSummary: 'path/not_found/..',
    error: { '.tag': 'path', path: { '.tag': 'not_found' } },
  })

// not_found via the error_summary prefix; path tag also set so both branches match.
export const dropboxPathLookupNotFound = () =>
  dropboxRpcError({
    status: 409,
    errorSummary: 'path_lookup/not_found/..',
    error: { '.tag': 'path', path: { '.tag': 'not_found' } },
  })
