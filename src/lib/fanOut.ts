import { BATCH_CHUNK_SIZE } from '@/features/sync/constant'

// Split a large fan-out into batches; batchTriggerAndWait caps items per call.
export const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  )

type BatchItemWithKey<TItem> = TItem & { options?: { concurrencyKey?: string } }
type KeyedBatchTask<TItem> = {
  batchTriggerAndWait: (items: BatchItemWithKey<TItem>[]) => Promise<unknown>
}

// Keyed per portal for fairness. Trigger.dev forbids parallel waits, so batches
// are awaited one at a time (items within a batch still run concurrently).
export const fanOutAndWait = async <TItem extends object>(
  task: KeyedBatchTask<TItem>,
  items: TItem[],
  concurrencyKey: string,
): Promise<void> => {
  if (!items.length) return
  const keyed = items.map((item) => ({ ...item, options: { concurrencyKey } }))
  for (const batch of chunk(keyed, BATCH_CHUNK_SIZE)) {
    await task.batchTriggerAndWait(batch)
  }
}
