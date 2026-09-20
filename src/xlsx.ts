/**
 * The smallest xlsx reader that can read a broker statement.
 *
 * An xlsx file is a zip of XML. This module unpacks the first worksheet into
 * a grid of strings and stops there — no types, no formatting, no formulas.
 * All the awkwardness of the file format is quarantined here so that every
 * other module works with plain rows.
 */

import { inflateRawSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

/** Extract one member of a zip archive, by exact name. */
function unzip(archive: Buffer, name: string): string {
  // Walk local file headers from the start; broker exports are small and
  // never use zip64 or encryption, so this is enough.
  let at = 0
  while (at + 30 <= archive.length && archive.readUInt32LE(at) === 0x04034b50) {
    const method = archive.readUInt16LE(at + 8)
    const compressedSize = archive.readUInt32LE(at + 18)
    const nameLength = archive.readUInt16LE(at + 26)
    const extraLength = archive.readUInt16LE(at + 28)
    const start = at + 30 + nameLength + extraLength
    const entry = archive.toString('utf8', at + 30, at + 30 + nameLength)

    if (entry === name) {
      const body = archive.subarray(start, start + compressedSize)
      return decodeXml(method === 8 ? inflateRawSync(body) : body)
    }
    at = start + compressedSize
  }
  throw new Error(`${name} not found in archive`)
}

/** MT5 writes its XML as UTF-16LE with a byte-order mark; Excel uses UTF-8. */
function decodeXml(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le')
  return bytes.toString('utf8')
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
}

function decode(xml: string): string {
  return xml.replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => ENTITIES[e] ?? e)
}

/** Concatenate the <t> runs inside a chunk of XML — how xlsx stores a string. */
function textOf(xml: string): string {
  const runs = xml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []
  return decode(runs.map((r) => r.replace(/<[^>]+>/g, '')).join(''))
}

/** "A1" -> 0, "B1" -> 1, "AA1" -> 26. */
function columnOf(reference: string): number {
  const letters = reference.match(/^[A-Z]+/)?.[0] ?? 'A'
  let column = 0
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64)
  return column - 1
}

/**
 * Read the first worksheet as a grid of strings. Empty cells become `''`;
 * rows are padded so every row has the same length.
 */
export function readSheet(path: string): string[][] {
  const archive = readFileSync(path)

  // Strings are pooled in a shared table and referenced by index.
  let pool: string[] = []
  try {
    pool = (unzip(archive, 'xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) ?? []).map(textOf)
  } catch {
    // A sheet with only numbers has no shared string table.
  }

  const sheet = unzip(archive, 'xl/worksheets/sheet1.xml')
  const rows: string[][] = []
  let width = 0

  for (const rowXml of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const row: string[] = []
    // Two shapes: an empty cell closes itself, a filled one wraps a value.
    for (const cellXml of rowXml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) ?? []) {
      const reference = cellXml.match(/\sr="([A-Z]+\d+)"/)?.[1] ?? 'A1'
      const type = cellXml.match(/\st="(\w+)"/)?.[1]
      const value = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1]

      const text =
        type === 's' ? (pool[Number(value)] ?? '')
        : type === 'inlineStr' ? textOf(cellXml)
        : value !== undefined ? decode(value)
        : ''

      row[columnOf(reference)] = text
    }
    for (let i = 0; i < row.length; i++) row[i] ??= ''
    width = Math.max(width, row.length)
    rows.push(row)
  }

  for (const row of rows) while (row.length < width) row.push('')
  return rows
}
