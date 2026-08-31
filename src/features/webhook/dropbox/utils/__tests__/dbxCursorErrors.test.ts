import { DropboxResponseError } from 'dropbox'
import { describe, expect, it } from 'vitest'
import {
  isDbxCursorResetError,
  isDbxRootMovedError,
} from '@/features/webhook/dropbox/utils/dbxCursorErrors'

const dbxError = (status: number, tag: string) =>
  new DropboxResponseError(status, { get: () => null } as never, {
    error_summary: `${tag}/...`,
    error: { '.tag': tag },
  })

describe('isDbxRootMovedError', () => {
  it('is true for a 409 path error (root moved/renamed/deleted)', () => {
    expect(isDbxRootMovedError(dbxError(409, 'path'))).toBe(true)
  })

  it('is false for a 409 reset (cursor invalid, same root)', () => {
    expect(isDbxRootMovedError(dbxError(409, 'reset'))).toBe(false)
  })

  it('is false for a non-409 Dropbox error', () => {
    expect(isDbxRootMovedError(dbxError(429, 'path'))).toBe(false)
  })

  it('is false for non-Dropbox errors', () => {
    expect(isDbxRootMovedError(new Error('boom'))).toBe(false)
    expect(isDbxRootMovedError(undefined)).toBe(false)
  })
})

describe('isDbxCursorResetError', () => {
  it('is true for a 409 reset error (cursor invalidated, same root)', () => {
    expect(isDbxCursorResetError(dbxError(409, 'reset'))).toBe(true)
  })

  it('is false for a 409 path error (a move, not a reset)', () => {
    expect(isDbxCursorResetError(dbxError(409, 'path'))).toBe(false)
  })

  it('is false for a non-409 Dropbox error', () => {
    expect(isDbxCursorResetError(dbxError(429, 'reset'))).toBe(false)
  })

  it('is false for non-Dropbox errors', () => {
    expect(isDbxCursorResetError(new Error('boom'))).toBe(false)
    expect(isDbxCursorResetError(undefined)).toBe(false)
  })
})
