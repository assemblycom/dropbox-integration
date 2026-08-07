import { describe, expect, it, vi } from 'vitest'
import { ApiError, logger, schedules, task } from './inlineSdk'

describe('inline task double', () => {
  it('trigger runs the task run() inline and resolves after it completes', async () => {
    const calls: number[] = []
    // genuinely async run: proves the double awaits it before resolving.
    const run = vi.fn(async (n: number) => {
      await Promise.resolve()
      calls.push(n)
    })
    const t = task({ id: 't', run })
    await t.trigger(5)
    expect(run).toHaveBeenCalledWith(5)
    expect(calls).toEqual([5])
  })

  it('trigger ignores the options argument (e.g. concurrencyKey)', async () => {
    const run = vi.fn(() => Promise.resolve())
    const t = task({ id: 't', run })
    await t.trigger('acct', { concurrencyKey: 'acct' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('acct') // second arg not forwarded
  })

  it('triggerAndWait resolves a { ok: true, output } TaskRunResult on success', async () => {
    const t = task({ id: 't', run: (p: { x: number }) => p.x * 2 })
    const res = await t.triggerAndWait({ x: 3 })
    expect(res).toMatchObject({ ok: true, output: 6, taskIdentifier: 't' })
  })

  it('triggerAndWait RESOLVES { ok: false, error } when run throws — it does not reject', async () => {
    const boom = new Error('boom')
    const t = task({
      id: 't',
      run: () => {
        throw boom
      },
    })
    // must resolve, not reject: real *AndWait absorbs run failures into the result.
    const res = await t.triggerAndWait(undefined)
    expect(res).toMatchObject({ ok: false, error: boom, taskIdentifier: 't' })
  })

  it('batchTriggerAndWait unwraps { payload } items and runs each in order', async () => {
    const seen: string[] = []
    const t = task({
      id: 't',
      run: (p: string) => {
        seen.push(p)
      },
    })
    const res = await t.batchTriggerAndWait([{ payload: 'a' }, { payload: 'b' }])
    expect(seen).toEqual(['a', 'b'])
    expect(res.runs.map((r) => r.ok)).toEqual([true, true])
  })

  it('batchTriggerAndWait runs EVERY item even when one throws, reporting per-item results', async () => {
    const seen: string[] = []
    const t = task({
      id: 't',
      run: (p: string) => {
        seen.push(p)
        if (p === 'b') throw new Error('bad b')
      },
    })
    const res = await t.batchTriggerAndWait([{ payload: 'a' }, { payload: 'b' }, { payload: 'c' }])
    expect(seen).toEqual(['a', 'b', 'c']) // b throwing did not skip c
    expect(res.runs.map((r) => r.ok)).toEqual([true, false, true])
  })

  it('batchTrigger unwraps { payload } items and runs each', async () => {
    const seen: string[] = []
    const t = task({
      id: 't',
      run: (p: string) => {
        seen.push(p)
      },
    })
    await t.batchTrigger([{ payload: 'x' }, { payload: 'y' }])
    expect(seen).toEqual(['x', 'y'])
  })

  it('batchTrigger runs every item and does not reject when one throws (fire-and-forget)', async () => {
    const seen: string[] = []
    const t = task({
      id: 't',
      run: (p: string) => {
        seen.push(p)
        if (p === 'x') throw new Error('bad x')
      },
    })
    await expect(t.batchTrigger([{ payload: 'x' }, { payload: 'y' }])).resolves.toEqual({ id: 't' })
    expect(seen).toEqual(['x', 'y'])
  })

  it('trigger swallows a run failure and does not reject (fire-and-forget)', async () => {
    const t = task({
      id: 't',
      run: () => {
        throw new Error('nope')
      },
    })
    await expect(t.trigger(undefined)).resolves.toEqual({ id: 't' })
  })

  it('preserves delete-before-create ordering across sequential awaited calls', async () => {
    const order: string[] = []
    const del = task({
      id: 'del',
      run: () => {
        order.push('delete')
      },
    })
    const create = task({
      id: 'create',
      run: () => {
        order.push('create')
      },
    })
    // mirrors handleChannelFileChanges: delete batch awaited before create batch
    await del.batchTriggerAndWait([{ payload: 1 }])
    await create.batchTriggerAndWait([{ payload: 2 }])
    expect(order).toEqual(['delete', 'create'])
  })

  it('schedules.task builds an inline handle too', async () => {
    const run = vi.fn(() => Promise.resolve())
    const t = schedules.task({ id: 's', cron: '0 8 * * *', run })
    await t.trigger(undefined)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('logger methods are no-ops', () => {
    expect(() => {
      logger.info('x')
      logger.error('y', {})
      logger.warn('z')
    }).not.toThrow()
  })

  it('ApiError is an Error subclass carrying status', () => {
    const e = new ApiError('boom')
    e.status = 429
    expect(e).toBeInstanceOf(Error)
    expect(e.status).toBe(429)
    expect(e.message).toBe('boom')
  })
})
