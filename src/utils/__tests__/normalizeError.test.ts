import { DropboxResponseError } from 'dropbox'
import { describe, expect, it } from 'vitest'
import { normalizeError } from '@/utils/normalizeError'

describe('normalizeError', () => {
  it('formats a Copilot API error with status, statusText, body message, and url', () => {
    const err = Object.assign(new Error('boom'), {
      url: '/v1/files/x',
      status: 404,
      statusText: 'Not Found',
      body: { message: 'nope' },
    })
    expect(normalizeError(err)).toBe('HTTP 404 Not Found — nope (url: /v1/files/x)')
  })

  it('falls back gracefully when the Copilot error has no statusText/url/body message', () => {
    const err = Object.assign(new Error(), { url: '', status: 500, statusText: '', body: {} })
    expect(normalizeError(err)).toBe('HTTP 500 — no body message')
  })

  it('formats a DropboxResponseError as "status: <serialized error>"', () => {
    const err = new DropboxResponseError(
      409,
      {} as never,
      { error_summary: 'path/not_found' } as never,
    )
    expect(normalizeError(err)).toBe('409: {"error_summary":"path/not_found"}')
  })

  it('uses the message for a plain Error', () => {
    expect(normalizeError(new Error('just a message'))).toBe('just a message')
  })

  it('stringifies a non-error value', () => {
    expect(normalizeError('a string')).toBe('a string')
    expect(normalizeError(42)).toBe('42')
  })
})
