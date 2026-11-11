import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { configure } = vi.hoisted(() => ({ configure: vi.fn() }))
vi.mock('@trigger.dev/sdk/v3', () => ({ configure }))

const BACKUP_KEY = 'tr_prod_backup_test_key'

// The module configures the SDK as an import side effect and env is parsed at import
// time, so each case sets the env var first and re-imports a fresh copy.
const loadModule = (backupKey: string | undefined) => {
  if (backupKey === undefined) delete process.env.TRIGGER_BACKUP_SECRET_KEY
  else process.env.TRIGGER_BACKUP_SECRET_KEY = backupKey
  vi.resetModules()
  return import('@/lib/triggerClient')
}

describe('triggerClient', () => {
  beforeEach(() => {
    configure.mockClear()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })

  afterEach(() => {
    delete process.env.TRIGGER_BACKUP_SECRET_KEY
    vi.restoreAllMocks()
  })

  it('leaves the SDK untouched when the backup key is unset', async () => {
    const { configureTriggerClient } = await loadModule(undefined)

    expect(configure).not.toHaveBeenCalled()
    expect(configureTriggerClient(undefined)).toBe('primary')
    expect(configure).not.toHaveBeenCalled()
  })

  it('treats a blank backup key as unset', async () => {
    await loadModule('')

    expect(configure).not.toHaveBeenCalled()
  })

  it('configures the SDK once with the backup key when it is set', async () => {
    await loadModule(BACKUP_KEY)

    expect(configure).toHaveBeenCalledTimes(1)
    expect(configure).toHaveBeenCalledWith({ accessToken: BACKUP_KEY })
  })

  it('never logs the key', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await loadModule(BACKUP_KEY)

    const logged = JSON.stringify(info.mock.calls)
    expect(logged).toContain('backup')
    expect(logged).not.toContain(BACKUP_KEY)
  })
})
