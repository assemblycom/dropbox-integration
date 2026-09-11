import { describe, expect, it } from 'vitest'
import { chunkStream } from '@/utils/chunkStream'

// Turns a list of byte-arrays into an async iterable, like a streamed body.
// biome-ignore lint/suspicious/useAwait: an async generator is the async iterable under test
async function* source(parts: number[][]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Uint8Array.from(part)
}

async function collect(gen: AsyncGenerator<Buffer>): Promise<number[][]> {
  const out: number[][] = []
  for await (const chunk of gen) out.push([...chunk])
  return out
}

describe('chunkStream', () => {
  it('yields nothing for an empty stream', async () => {
    expect(await collect(chunkStream(source([]), 4))).toEqual([])
  })

  it('yields a single short chunk when the stream is smaller than the chunk size', async () => {
    expect(await collect(chunkStream(source([[1, 2, 3]]), 4))).toEqual([[1, 2, 3]])
  })

  it('splits an exact multiple into full chunks with no remainder', async () => {
    const chunks = await collect(chunkStream(source([[1, 2, 3, 4, 5, 6]]), 3))
    expect(chunks).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])
  })

  it('emits full chunks then a smaller final chunk for the remainder', async () => {
    const chunks = await collect(chunkStream(source([[1, 2, 3, 4, 5]]), 2))
    expect(chunks).toEqual([[1, 2], [3, 4], [5]])
  })

  it('coalesces many small source reads into full chunks across boundaries', async () => {
    const parts = [[1], [2, 3], [4], [5, 6, 7]]
    const chunks = await collect(chunkStream(source(parts), 3))
    expect(chunks).toEqual([[1, 2, 3], [4, 5, 6], [7]])
  })

  it('rejects a non-positive chunk size', async () => {
    await expect(collect(chunkStream(source([[1]]), 0))).rejects.toThrow(/chunk size/i)
  })
})
