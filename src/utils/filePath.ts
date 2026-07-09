import * as p from 'node:path'
import dayjs from 'dayjs'
import { ObjectType } from '@/db/constants'

export function buildPathArray(path: string): string[] {
  // Split the path into parts, ignoring any empty segments
  const parts = path.split('/').filter(Boolean)

  // Accumulate the parts into full paths
  const result: string[] = []
  let current = ''

  for (const part of parts) {
    current += `/${part}`
    result.push(current)
  }

  return result
}

export function getFolderPath(path: string, type: ObjectType) {
  if (type === ObjectType.FOLDER) return path
  return p.dirname(path)
}

// Assembly/Dropbox paths are always '/'-delimited logical paths, so use posix
// semantics — the default `path` export splits on '\' on Windows.
export function getParentPath(path: string): string {
  return p.posix.dirname(path)
}

export function getBaseName(path: string): string {
  return p.posix.basename(path)
}

export function appendDateTimeToFilePath(filePath: string): string {
  // Extract directory, filename, and extension using regex
  const match = filePath.match(/^(.*\/)?([^/]+)\.([^.]+)$/)
  if (!match) throw new Error('Invalid file path format')

  const [, dir = '', filename, ext] = match

  // Create a timestamp in YYYY-MM-DD HH.mm.ss format
  const timestamp = dayjs().format('MM-DD-YYYY HH:mm:ss')

  // Return the new path
  return `${dir}${filename} (${timestamp}).${ext}`
}

export function getPathFromRoot(path: string, root: string) {
  // Root is a prefix: only strip when the path actually starts with it.
  return path.startsWith(root) ? path.slice(root.length) : path
}

export function replaceSpecialCharactersWithSpace(str: string) {
  const sanitizedString = str.replace(/[#@$%^&*()+=[\]{}|\\:;"'<>,?~`]/g, ' ')
  return sanitizedString.trim()
}

export function splitPathAndFolder(fullPath: string): { path: string; folder: string } {
  if (!fullPath) {
    return { path: '', folder: '' }
  }

  // if ends with slash then folder is empty, path is the full path
  if (fullPath.endsWith('/')) {
    const sanitizedPath = fullPath.startsWith('/') ? fullPath : `/${fullPath}`
    return { path: sanitizedPath.replace(/\/+$/, ''), folder: '' }
  }

  const lastSlashIndex = fullPath.lastIndexOf('/')

  // no slash at all -> folder is full path, path is empty
  if (lastSlashIndex === -1) {
    return { path: '', folder: fullPath }
  }

  // slash at the start (e.g., '/folder')
  if (lastSlashIndex === 0) {
    return { path: '', folder: fullPath.slice(1) }
  }

  const path = fullPath.substring(0, lastSlashIndex)
  return {
    path: path.startsWith('/') ? path : `/${path}`,
    folder: fullPath.substring(lastSlashIndex + 1),
  }
}

export function sanitizePath(path: string) {
  return path.replace(/^\/+/, '')
}

// Normalize to exactly one leading slash. Assembly returns paths without one, but
// we store/match assemblyPath and itemPath with a leading slash consistently.
export function ensureLeadingSlash(path: string): string {
  return `/${path.replace(/^\/+/, '')}`
}

// Chars each target rejects within a name segment; `/` is enforced by segmenting.
const DISALLOWED_CHARS = {
  assembly: /[*=|@^]/,
  dropbox: /\\/,
} as const

export type SyncTarget = keyof typeof DISALLOWED_CHARS

// Append the child's leaf name to its parent's stored full path. No parent path
// (top-level / brand-new subtree) → the raw child path.
export function composeChildPath(parentPath: string | null | undefined, childPath: string): string {
  if (!parentPath) return childPath
  return `${parentPath}/${p.posix.basename(childPath)}`
}

// Distinct disallowed chars across all segments; empty string means valid.
export function findDisallowedChars(path: string, target: SyncTarget): string {
  const disallowed = DISALLOWED_CHARS[target]
  const found = new Set<string>()

  for (const segment of path.split('/')) {
    for (const char of segment) {
      if (disallowed.test(char)) found.add(char)
    }
  }

  return [...found].join('')
}
