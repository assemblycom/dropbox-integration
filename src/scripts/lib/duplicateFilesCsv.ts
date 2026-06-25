/**
 * Shared parser for the "Duplicate files in Assembly" CSV.
 *
 * Columns: DropboxId, Original itemPath, Original assemblyId, Duplicate itemPath,
 * Duplicate assemblyId (Ids to DELETE). The last two columns may pack a
 * comma-separated, double-quoted list when one original has several duplicates.
 */
import { readFileSync } from 'node:fs'

export type DuplicateRecord = {
  line: number
  dropboxId: string
  originalPath: string
  originalId: string
  duplicates: { id: string; path: string }[]
  parseWarning?: string
}

/** Minimal RFC-4180-ish parser: handles double-quoted fields with embedded commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function splitList(cell: string): string[] {
  return cell
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parseDuplicateRecords(rows: string[][]): DuplicateRecord[] {
  const records: DuplicateRecord[] = []
  // rows[0] is the header.
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const [dropboxId = '', originalPath = '', originalId = '', dupPathCell = '', dupIdCell = ''] =
      row.map((c) => c.trim())

    // Skip blank separator rows.
    if (!originalId && !dupIdCell) continue

    const dupIds = splitList(dupIdCell)
    const dupPaths = splitList(dupPathCell)

    let parseWarning: string | undefined
    if (dupPaths.length !== dupIds.length) {
      parseWarning = `path/id count mismatch (${dupPaths.length} paths vs ${dupIds.length} ids); pairing by index with fallback`
    }

    const duplicates = dupIds.map((id, i) => ({
      id,
      // Fall back to the single provided path, else the original path.
      path: dupPaths[i] ?? dupPaths[0] ?? originalPath,
    }))

    records.push({ line: r + 1, dropboxId, originalPath, originalId, duplicates, parseWarning })
  }
  return records
}

export function readDuplicateRecords(csvPath: string): DuplicateRecord[] {
  return parseDuplicateRecords(parseCsv(readFileSync(csvPath, 'utf8')))
}
