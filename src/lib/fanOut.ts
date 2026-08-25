import { BATCH_CHUNK_SIZE } from '@/features/sync/constant'

// Split a large fan-out into batches; batchTriggerAndWait caps items per call.
export const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  )

type BatchOptions = { concurrencyKey?: string; [key: string]: unknown }
type BatchItem<TItem> = TItem & { options?: BatchOptions }
type KeyedBatchTask<TItem> = {
  batchTriggerAndWait: (items: BatchItem<TItem>[]) => Promise<unknown>
}

// Keyed per portal for fairness. Trigger.dev forbids parallel waits, so batches
// are awaited one at a time (items within a batch still run concurrently).
export const fanOutAndWait = async <TItem extends object>(
  task: KeyedBatchTask<TItem>,
  items: BatchItem<TItem>[],
  concurrencyKey: string,
): Promise<void> => {
  if (!items.length) return
  // Merge the key into any existing options instead of replacing them.
  const keyed = items.map((item) => ({ ...item, options: { ...item.options, concurrencyKey } }))
  for (const batch of chunk(keyed, BATCH_CHUNK_SIZE)) {
    await task.batchTriggerAndWait(batch)
  }
}
