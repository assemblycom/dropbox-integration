import { DropboxResponseError } from 'dropbox'
import httpStatus from 'http-status'

// The `.tag` on a Dropbox 409 error, or undefined if it is not one.
const dbxConflictTag = (error: unknown): string | undefined =>
  error instanceof DropboxResponseError && error.status === httpStatus.CONFLICT
    ? (error.error as { error?: { '.tag'?: string } } | undefined)?.error?.['.tag']
    : undefined

// True when the root folder was moved, renamed, or deleted.
export const isDbxRootMovedError = (error: unknown): boolean => dbxConflictTag(error) === 'path'

// True when the cursor is stale and cannot continue (folder is fine).
export const isDbxCursorResetError = (error: unknown): boolean => dbxConflictTag(error) === 'reset'
