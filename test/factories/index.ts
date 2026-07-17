import { resetSeq } from './sequence'

export * from './copilot'
export * from './dropbox'
export { seqUuid } from './sequence'

// Zeroes the shared sequence so ids (dbx:1, ...0001, /root/file-1.txt) are
// stable per test. Wired into the integration beforeEach in Task 6; call it
// manually in pure unit tests.
export function resetFactories(): void {
  resetSeq()
}
