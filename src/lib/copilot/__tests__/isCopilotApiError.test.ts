import { DropboxResponseError } from 'dropbox'
import { describe, expect, it } from 'vitest'
import { isCopilotApiError } from '@/lib/copilot/CopilotAPI'

// A well-formed Copilot API error.
const copilotError = () =>
  Object.assign(new Error('boom'), {
    url: '/v1/files/x',
    status: 404,
    statusText: 'Not Found',
    body: { message: 'nope' },
  })

describe('isCopilotApiError', () => {
  it('accepts an Error carrying url/status/statusText/body', () => {
    expect(isCopilotApiError(copilotError())).toBe(true)
  })

  it('rejects a plain Error', () => {
    expect(isCopilotApiError(new Error('plain'))).toBe(false)
  })

  it('rejects a non-Error object even with the right shape', () => {
    const notAnError = { url: '/v1', status: 404, statusText: 'Not Found', body: {} }
    expect(isCopilotApiError(notAnError)).toBe(false)
  })

  it('rejects when a required field is missing (status)', () => {
    const err = Object.assign(new Error(), { url: '/v1', statusText: 'x', body: {} })
    expect(isCopilotApiError(err)).toBe(false)
  })

  it('rejects when body is null', () => {
    const err = Object.assign(new Error(), {
      url: '/v1',
      status: 500,
      statusText: 'x',
      body: null,
    })
    expect(isCopilotApiError(err)).toBe(false)
  })

  it('rejects a DropboxResponseError (no url/statusText/body — must not match)', () => {
    const err = new DropboxResponseError(429, {} as never, {} as never)
    expect(isCopilotApiError(err)).toBe(false)
  })
})
