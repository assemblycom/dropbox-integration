import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/lib/logger'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.LOG_LEVEL
})

describe('logger', () => {
  it('caps object depth so nested payloads are not fully dumped', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logger.info({ a: { b: { c: { secret: 'deep-value' } } } })
    const out = spy.mock.calls[0][0] as string
    expect(out).not.toContain('deep-value')
    expect(out).toContain('[Object]')
  })

  it('truncates long arrays instead of dumping every element', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logger.info(Array.from({ length: 100 }, (_, i) => i))
    expect(spy.mock.calls[0][0] as string).toContain('more items')
  })

  it('passes string args through unchanged', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logger.info('hello', 'world')
    expect(spy).toHaveBeenCalledWith('hello world')
  })

  it('suppresses levels below LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn'
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logger.info('quiet')
    logger.warn('loud')
    expect(info).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('defaults to info, suppressing the verbose log level', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logger.log('debug detail')
    logger.info('operational')
    expect(log).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalled()
  })

  it('truncates long strings nested in an object', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logger.info({ message: 'x'.repeat(1000) })
    expect(spy.mock.calls[0][0] as string).toContain('more characters')
  })

  it('always prints error, and treats an invalid LOG_LEVEL as the default', () => {
    process.env.LOG_LEVEL = 'BOGUS' // unrecognized → falls back to info
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logger.warn('kept at info default')
    logger.error('always')
    expect(warn).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })
})
