import { task } from '@trigger.dev/sdk/v3'
import { describe, expect, it } from 'vitest'
import { processDropboxChanges } from '@/trigger/processFileSync'

// Load-bearing on the setup-level vi.mock: unmocked, the live SDK's trigger methods
// throw "can only be used from inside a task.run()".

describe('inline SDK double in the integration project', () => {
  it('the doubled task() runs run() inline and resolves a TaskRunResult', async () => {
    const ran: string[] = []
    // returns a Promise to satisfy the real `run` type (tsc sees the real SDK).
    const probe = task({
      id: 'inline-double-probe',
      run: (payload: string) => {
        ran.push(payload)
        return Promise.resolve()
      },
    })
    const result = await probe.triggerAndWait('hit')
    expect(ran).toEqual(['hit'])
    expect(result).toMatchObject({ ok: true, output: undefined })
  })

  it('drives a REAL exported task through the double, in-process, against Postgres', async () => {
    // No active connection in a truncated DB → fetchDropBoxChanges logs + returns early
    // (no MSW calls, no throw). Proves a real task ran inline via the double.
    const result = await processDropboxChanges.triggerAndWait('no-such-account')
    expect(result).toMatchObject({ ok: true })
  })
})
