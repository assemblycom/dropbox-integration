import { describe, expect, it } from 'vitest'
import { HexColorSchema } from '@/lib/copilot/types'

describe('HexColorSchema', () => {
  it.each(['#fff', '#FFFFFF', '#Ab12Cd'])('accepts the valid hex color %s', (value) => {
    expect(HexColorSchema.safeParse(value).success).toBe(true)
  })

  it.each(['fff', '#ff', '#12345', '#gggggg', ''])('rejects the invalid hex color %s', (value) => {
    expect(HexColorSchema.safeParse(value).success).toBe(false)
  })
})
