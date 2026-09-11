// Reads a byte stream into fixed-size buffers; the last one may be smaller.
export async function* chunkStream(
  source: AsyncIterable<Uint8Array>,
  chunkSize: number,
): AsyncGenerator<Buffer> {
  if (chunkSize <= 0) throw new Error('chunkStream: chunk size must be greater than zero')

  let held: Buffer[] = []
  let heldBytes = 0

  for await (const part of source) {
    held.push(Buffer.from(part))
    heldBytes += part.byteLength

    while (heldBytes >= chunkSize) {
      const merged = Buffer.concat(held, heldBytes)
      yield merged.subarray(0, chunkSize)
      const rest = merged.subarray(chunkSize)
      held = rest.byteLength ? [rest] : []
      heldBytes = rest.byteLength
    }
  }

  if (heldBytes > 0) yield Buffer.concat(held, heldBytes)
}
