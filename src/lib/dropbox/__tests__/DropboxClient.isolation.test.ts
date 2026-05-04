import { describe, expect, it } from 'vitest'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'

// These tests lock in a structural invariant that today's safety relies on:
// each DropboxClient must produce a fully fresh, per-account client tree —
// distinct dbxAuthClient, distinct underlying authInstance, AND distinct
// SDK Dropbox clientInstance (the object that issues every API call).
//
// If a future refactor introduces module-level caching at any of these
// layers (e.g. Map<refreshToken, Dropbox> for clientInstance, or a shared
// singleton DropboxAuthClient), these tests fail loudly — preventing a
// cross-tenant credential leak from landing silently.
describe('DropboxClient isolation', () => {
  const refreshTokenA = 'refresh-token-account-a'
  const refreshTokenB = 'refresh-token-account-b'

  it('produces a fully isolated client tree per construction (different refresh tokens)', () => {
    const clientA = new DropboxClient(refreshTokenA)
    const clientB = new DropboxClient(refreshTokenB)

    expect(clientA.dbxAuthClient).not.toBe(clientB.dbxAuthClient)
    expect(clientA.dbxAuthClient.authInstance).not.toBe(clientB.dbxAuthClient.authInstance)
    expect(clientA.getDropboxClient()).not.toBe(clientB.getDropboxClient())
  })

  it('produces a fully isolated client tree per construction (identical refresh token)', () => {
    // Two webhooks for the same account arriving concurrently should still
    // construct independent client trees. A shared instance keyed by
    // refreshToken would be a regression.
    const clientA = new DropboxClient(refreshTokenA)
    const clientB = new DropboxClient(refreshTokenA)

    expect(clientA.dbxAuthClient).not.toBe(clientB.dbxAuthClient)
    expect(clientA.dbxAuthClient.authInstance).not.toBe(clientB.dbxAuthClient.authInstance)
    expect(clientA.getDropboxClient()).not.toBe(clientB.getDropboxClient())
  })
})
