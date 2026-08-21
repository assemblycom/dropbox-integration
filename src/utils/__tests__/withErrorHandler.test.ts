import { NextResponse } from 'next/server'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import APIError from '@/errors/APIError'
import { withErrorHandler } from '@/utils/withErrorHandler'

// req/params are unused by the handler under test.
const run = (handler: () => NextResponse | Promise<NextResponse>) =>
  withErrorHandler(() => Promise.resolve(handler()))({} as never, undefined)

describe('withErrorHandler', () => {
  it('passes a successful response through unchanged', async () => {
    const res = await run(() => NextResponse.json({ ok: true }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('maps an APIError to its status and message', async () => {
    const res = await run(() => {
      throw new APIError('nope', 404)
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'nope' })
  })

  it('maps a ZodError to 422', async () => {
    const res = await run(() => {
      z.number().parse('not a number')
      return NextResponse.json({})
    })

    expect(res.status).toBe(422)
    expect(typeof (await res.json()).error).toBe('string')
  })

  it('maps an unexpected Error to 500 with its message', async () => {
    const res = await run(() => {
      throw new Error('boom')
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
  })
})
