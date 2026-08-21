import { describe, expect, it } from 'vitest'
import { dropboxArgHeader } from '@/utils/header'

describe('dropboxArgHeader', () => {
  it('serializes a plain ascii object to JSON unchanged', () => {
    expect(dropboxArgHeader({ path: '/a/b.txt' })).toBe('{"path":"/a/b.txt"}')
  })

  it('escapes accented characters as \\uXXXX', () => {
    expect(dropboxArgHeader({ path: '/café' })).toBe('{"path":"/caf\\u00e9"}')
  })

  it('leaves no raw non-ascii character in the output (e.g. emoji)', () => {
    const out = dropboxArgHeader({ name: '📁 photos' })
    expect(out).toContain('\\u') // the emoji became escape sequences
    // nothing above ascii remains
    expect([...out].every((ch) => ch.charCodeAt(0) <= 0x7e)).toBe(true)
  })
})
