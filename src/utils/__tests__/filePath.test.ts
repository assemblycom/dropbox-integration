import { describe, expect, it } from 'vitest'
import { composeChildPath, ensureLeadingSlash, findDisallowedChars } from '@/utils/filePath'

describe('ensureLeadingSlash', () => {
  it('adds a leading slash when missing (Assembly returns paths without one)', () => {
    expect(ensureLeadingSlash('Hari_s Chiya Pasal/file.txt')).toBe('/Hari_s Chiya Pasal/file.txt')
  })

  it('leaves an already-slashed path unchanged and collapses extras', () => {
    expect(ensureLeadingSlash('/a/b')).toBe('/a/b')
    expect(ensureLeadingSlash('//a')).toBe('/a')
  })
})

describe('composeChildPath', () => {
  it('falls back to the raw child path when there is no parent path', () => {
    expect(composeChildPath(null, '/folder/file.txt')).toBe('/folder/file.txt')
    expect(composeChildPath(undefined, '/top-level')).toBe('/top-level')
  })

  it("appends the child's leaf name to the parent's real path", () => {
    // Assembly side: parent sanitized John's Cafe -> John_s Cafe
    expect(composeChildPath('/John_s Cafe', "/John's Cafe/file.txt")).toBe('/John_s Cafe/file.txt')
    // Dropbox side: parent's Dropbox path recovered from a diverged Assembly child
    expect(composeChildPath("/John's Cafe", '/John_s Cafe/file.txt')).toBe("/John's Cafe/file.txt")
  })

  it('uses only the leaf of a deep child path (parent path is already the full prefix)', () => {
    expect(composeChildPath('/a/b_c', '/a/b#c/leaf.pdf')).toBe('/a/b_c/leaf.pdf')
  })

  it('treats a backslash as a literal name char, not a separator (posix)', () => {
    // On win32 path semantics basename('/p/a\\b.txt') would wrongly return 'b.txt'.
    expect(composeChildPath('/p', '/p/a\\b.txt')).toBe('/p/a\\b.txt')
  })
})

describe('findDisallowedChars', () => {
  describe('assembly target (disallows * = | @ ^)', () => {
    it('returns empty string for a plain ascii path', () => {
      expect(findDisallowedChars('/folder/report.pdf', 'assembly')).toBe('')
    })

    it('allows accented names through unchanged', () => {
      expect(findDisallowedChars('/café/résumé.txt', 'assembly')).toBe('')
    })

    it('allows non-Latin names through unchanged', () => {
      expect(findDisallowedChars('/日本語/文書.txt', 'assembly')).toBe('')
    })

    it('allows emoji names through unchanged', () => {
      expect(findDisallowedChars('/📁 photos/🎉.png', 'assembly')).toBe('')
    })

    it('does not flag the / path separator', () => {
      expect(findDisallowedChars('/a/b/c/d.txt', 'assembly')).toBe('')
    })

    it.each([['*'], ['='], ['|'], ['@'], ['^']])('flags the disallowed character %s', (ch) => {
      expect(findDisallowedChars(`/folder/na${ch}me.txt`, 'assembly')).toContain(ch)
    })

    it('does not flag a backslash (allowed in Assembly)', () => {
      expect(findDisallowedChars('/folder/na\\me.txt', 'assembly')).toBe('')
    })

    it('returns distinct offending characters across segments', () => {
      const result = findDisallowedChars('/fo@lder/na*me@.txt', 'assembly')
      expect(result).toContain('@')
      expect(result).toContain('*')
      // distinct, not one entry per occurrence
      expect(result.length).toBe(2)
    })
  })

  describe('dropbox target (disallows \\)', () => {
    it('returns empty string for a plain ascii path', () => {
      expect(findDisallowedChars('/folder/report.pdf', 'dropbox')).toBe('')
    })

    it('allows accented, non-Latin, and emoji names through unchanged', () => {
      expect(findDisallowedChars('/café/日本語/📁.txt', 'dropbox')).toBe('')
    })

    it('flags a backslash', () => {
      expect(findDisallowedChars('/folder/na\\me.txt', 'dropbox')).toContain('\\')
    })

    it('does not flag characters Dropbox allows but Assembly rejects', () => {
      expect(findDisallowedChars('/folder/na@me*.txt', 'dropbox')).toBe('')
    })

    it('does not flag the / path separator', () => {
      expect(findDisallowedChars('/a/b/c/d.txt', 'dropbox')).toBe('')
    })
  })
})
