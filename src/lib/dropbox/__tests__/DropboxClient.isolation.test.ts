import { describe, expect, it } from 'vitest'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'

// These tests lock in a structural invariant that today's safety relies on:
// each DropboxClient (and its dbxAuthClient + underlying authInstance) must be
// a fresh, per-account object. If a future refactor introduces module-level
// caching of clients keyed by anything other than the refresh token (or worse,
// a shared singleton), these tests fail loudly — preventing a cross-tenant
// credential leak from landing silently.
describe('DropboxClient isolation', () => {
  const refreshTokenA = 'refresh-token-account-a'
  const refreshTokenB = 'refresh-token-account-b'

  it('produces a distinct DropboxAuthClient instance per DropboxClient', () => {
    const clientA = new DropboxClient(refreshTokenA)
    const clientB = new DropboxClient(refreshTokenB)

    expect(clientA.dbxAuthClient).not.toBe(clientB.dbxAuthClient)
  })

  it('produces a distinct underlying authInstance per DropboxClient', () => {
    const clientA = new DropboxClient(refreshTokenA)
    const clientB = new DropboxClient(refreshTokenB)

    expect(clientA.dbxAuthClient.authInstance).not.toBe(clientB.dbxAuthClient.authInstance)
  })

  it('produces a distinct DropboxAuthClient instance even when refresh tokens are identical', () => {
    // Two webhooks for the same account arriving concurrently should still
    // construct independent client trees. A shared instance would be a regression.
    const clientA = new DropboxClient(refreshTokenA)
    const clientB = new DropboxClient(refreshTokenA)

    expect(clientA.dbxAuthClient).not.toBe(clientB.dbxAuthClient)
    expect(clientA.dbxAuthClient.authInstance).not.toBe(clientB.dbxAuthClient.authInstance)
  })
})
