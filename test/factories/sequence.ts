// One process-global counter shared by every factory AND seeder, so a given
// logical entity carries one number across its Dropbox / Copilot / DB forms.
// Reset between tests via resetFactories() (see ./index.ts).
let counter = 0

export function nextSeq(): number {
  return ++counter
}

export function resetSeq(): void {
  counter = 0
}

// Deterministic, schema-valid UUID for id columns (z.uuid() / uuid()).
export function seqUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}
