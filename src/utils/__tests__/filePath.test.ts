import { describe, expect, it } from 'vitest'
import { ObjectType } from '@/db/constants'
import {
  appendDateTimeToFilePath,
  buildPathArray,
  composeChildPath,
  ensureLeadingSlash,
  findDisallowedChars,
  getBaseName,
  getFolderPath,
  getParentPath,
  getPathFromRoot,
  replaceSpecialCharactersWithSpace,
  sanitizePath,
  splitPathAndFolder,
} from '@/utils/filePath'

describe('buildPathArray', () => {
  it('accumulates each path prefix as an absolute path', () => {
    expect(buildPathArray('/a/b/c')).toEqual(['/a', '/a/b', '/a/b/c'])
  })

  it('ignores empty segments from leading/duplicate/trailing slashes', () => {
    expect(buildPathArray('//a//b/')).toEqual(['/a', '/a/b'])
  })

  it('adds a leading slash to every prefix when the input has none', () => {
    expect(buildPathArray('a/b/file.txt')).toEqual(['/a', '/a/b', '/a/b/file.txt'])
  })

  it('returns an empty array for an empty or root-only path', () => {
    expect(buildPathArray('')).toEqual([])
    expect(buildPathArray('/')).toEqual([])
  })
})

describe('getFolderPath', () => {
  it('returns the path unchanged for a folder', () => {
    expect(getFolderPath('/a/b', ObjectType.FOLDER)).toBe('/a/b')
  })

  it('returns the containing directory for a file', () => {
    expect(getFolderPath('/a/b/file.txt', ObjectType.FILE)).toBe('/a/b')
  })
})

describe('appendDateTimeToFilePath', () => {
  it('inserts a timestamp between the filename and extension', () => {
    expect(appendDateTimeToFilePath('/folder/file.txt')).toMatch(
      /^\/folder\/file \(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}\)\.txt$/,
    )
  })

  it('handles a filename with no directory', () => {
    expect(appendDateTimeToFilePath('file.pdf')).toMatch(
      /^file \(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}\)\.pdf$/,
    )
  })

  it('throws when the path has no extension', () => {
    expect(() => appendDateTimeToFilePath('/folder/file')).toThrow('Invalid file path format')
  })
})

describe('getPathFromRoot', () => {
  it('strips the root prefix from the path', () => {
    expect(getPathFromRoot('/root/folder/file.txt', '/root')).toBe('/folder/file.txt')
  })

  it('returns the path unchanged when the root is absent', () => {
    expect(getPathFromRoot('/folder/file.txt', '/other')).toBe('/folder/file.txt')
  })

  it('returns the path unchanged when the root is not a prefix (appears mid-path)', () => {
    expect(getPathFromRoot('/folder/root/file.txt', '/root')).toBe('/folder/root/file.txt')
  })

  it('does not strip a partial segment match (root must end at a segment boundary)', () => {
    expect(getPathFromRoot('/rootdir/file.txt', '/root')).toBe('/rootdir/file.txt')
  })

  it('returns an empty string when the path equals the root', () => {
    expect(getPathFromRoot('/root', '/root')).toBe('')
  })
})

describe('replaceSpecialCharactersWithSpace', () => {
  it('replaces disallowed punctuation with spaces and trims', () => {
    expect(replaceSpecialCharactersWithSpace('#hello@world!')).toBe('hello world!')
  })

  it('leaves plain text unchanged', () => {
    expect(replaceSpecialCharactersWithSpace('hello world')).toBe('hello world')
  })
})

describe('splitPathAndFolder', () => {
  it('returns empty path and folder for an empty input', () => {
    expect(splitPathAndFolder('')).toEqual({ path: '', folder: '' })
  })

  it('treats a trailing slash as folder-less and strips it', () => {
    expect(splitPathAndFolder('/a/b/')).toEqual({ path: '/a/b', folder: '' })
    expect(splitPathAndFolder('a/b/')).toEqual({ path: '/a/b', folder: '' })
  })

  it('treats a name with no slash as a top-level folder', () => {
    expect(splitPathAndFolder('folder')).toEqual({ path: '', folder: 'folder' })
  })

  it('treats a leading-slash-only name as a top-level folder', () => {
    expect(splitPathAndFolder('/folder')).toEqual({ path: '', folder: 'folder' })
  })

  it('splits a nested path into parent path and leaf folder', () => {
    expect(splitPathAndFolder('/a/b/c')).toEqual({ path: '/a/b', folder: 'c' })
  })

  it('adds a leading slash to the parent path when missing', () => {
    expect(splitPathAndFolder('a/b/c')).toEqual({ path: '/a/b', folder: 'c' })
  })
})

describe('sanitizePath', () => {
  it('removes leading slashes', () => {
    expect(sanitizePath('/a/b')).toBe('a/b')
    expect(sanitizePath('///a/b')).toBe('a/b')
  })

  it('leaves an already-relative path unchanged', () => {
    expect(sanitizePath('a/b')).toBe('a/b')
  })
})

describe('getParentPath', () => {
  it('returns the parent directory of a file path', () => {
    expect(getParentPath('/folder/sub/file.txt')).toBe('/folder/sub')
  })

  it('returns the parent directory of a folder path', () => {
    expect(getParentPath('/folder/sub/leaf')).toBe('/folder/sub')
  })

  it('returns the root for a top-level entry', () => {
    expect(getParentPath('/file.txt')).toBe('/')
  })

  it('treats a backslash as a literal name char, not a separator (posix)', () => {
    // On win32 semantics dirname('/p/a\\b.txt') would treat '\' as a separator
    // and wrongly return '/p/a'; posix keeps the whole leaf.
    expect(getParentPath('/p/a\\b.txt')).toBe('/p')
    expect(getParentPath('/p/a\\b.txt')).not.toEqual('/p/a')
  })

  it('preserves special characters in the parent segments', () => {
    expect(getParentPath("/John's Cafe/file.txt")).toBe("/John's Cafe")
  })
})

describe('getBaseName', () => {
  it("returns the file's leaf name", () => {
    expect(getBaseName('/folder/sub/file.txt')).toBe('file.txt')
  })

  it('returns the leaf name of a folder path (no trailing slash)', () => {
    expect(getBaseName('/folder/sub')).toBe('sub')
  })

  it('treats a backslash as a literal name char, not a separator (posix)', () => {
    // On win32 semantics basename('/p/a\\b.txt') would wrongly return 'b.txt'.
    expect(getBaseName('/p/a\\b.txt')).toBe('a\\b.txt')
    expect(getBaseName('/p/a\\b.txt')).not.toEqual('b.txt')
  })

  it('preserves special characters in the leaf name', () => {
    expect(getBaseName("/folder/John's Cafe")).toBe("John's Cafe")
  })
})

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
    expect(composeChildPath('/p', '/p/a\\b.txt')).not.toEqual('/p/b.txt')
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
