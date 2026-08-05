import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFakeClock } from './fakeClock'
import { minutesAgo } from './offsets'

afterEach(() => vi.useRealTimers())

// JS world: mirrors the debounce comparison at
// src/features/webhook/dropbox/lib/webhook.service.ts:42, reproduced purely
// (no DB, no prod import — DEBOUNCE_WINDOW_MS is module-local in prod).
describe('JS-world boundary example: webhook debounce', () => {
  const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000 // documentation copy of the prod window

  const isRecentlySynced = (lastStartedAt: Date) =>
    lastStartedAt >= new Date(Date.now() - DEBOUNCE_WINDOW_MS)

  it('a stamp 4 minutes ago is inside the window (debounced → defer to cron)', () => {
    const clock = useFakeClock()
    expect(isRecentlySynced(minutesAgo(4))).toBe(true)
    clock.restore()
  })

  it('a stamp 6 minutes ago is outside the window (sync triggers)', () => {
    const clock = useFakeClock()
    expect(isRecentlySynced(minutesAgo(6))).toBe(false)
    clock.restore()
  })
})

// SQL world: the resync backoff compares in Postgres (NOW()), which JS cannot
// fake. This documents the seed-offset shape; the real assertion against real
// Postgres lands in L2.3, not here.
describe('SQL-world boundary template: resync backoff', () => {
  it('documents the past-backoff seed offset (real assertion in L2.3)', () => {
    // Integration usage:
    //   await fileSyncSeeder.create(
    //     pendingCreate(PendingActionTarget.DROPBOX),
    //     { pendingActionLastAttemptAt: minutesAgo(6) }, // past 5min × 1 attempt
    //   )
    //   // then assert findFailedSyncs() (SQL NOW()) INCLUDES the row.
    const seededAt = minutesAgo(6)
    expect(seededAt.getTime()).toBeLessThan(Date.now())
  })
})
