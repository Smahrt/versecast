/**
 * XML bible parsers — Zefania, OpenSong, OSIS (TDD §8 phases 1–2).
 * Format auto-detected from the root element.
 */
import { XMLParser } from 'fast-xml-parser'
import { BOOKS, OSIS_TO_BOOK, buildAliasTable } from '@versecast/shared'

export interface RawVerse {
  book: number // canonical 1–66
  chapter: number
  verse: number
  text: string
}

export interface ParsedBible {
  format: 'zefania' | 'opensong' | 'osis'
  name: string | null
  abbrev: string | null
  verses: RawVerse[]
  /** notes generated during parse/normalize (unknown books fail instead) */
  notes: string[]
}

export class ImportError extends Error {}

const ALIAS_LOOKUP = new Map(buildAliasTable().map((a) => [a.alias, a.book]))

function bookByName(name: string): number | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ')
  if (ALIAS_LOOKUP.has(key)) return ALIAS_LOOKUP.get(key)!
  const exact = BOOKS.find((b) => b.name.toLowerCase() === key)
  return exact?.n ?? null
}

function makeParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, jpath) =>
      /(?:BIBLEBOOK|CHAPTER|VERS|\bb\b|\bc\b|\bv\b|div|chapter|verse)$/.test(
        String(jpath).split('.').pop() ?? '',
      ),
  })
}

/** Extract all text from a parsed node, dropping notes/headings. */
function nodeText(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join(' ')
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    return Object.entries(obj)
      .filter(([k]) => !k.startsWith('@_') && k !== 'note' && k !== 'title')
      .map(([, v]) => nodeText(v))
      .join(' ')
  }
  return ''
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function detectFormat(xml: string): 'zefania' | 'opensong' | 'osis' | null {
  const head = xml.slice(0, 4000)
  if (/<XMLBIBLE[\s>]/i.test(head)) return 'zefania'
  if (/<osis[\s>]/i.test(head)) return 'osis'
  if (/<bible[\s>]/i.test(head)) return 'opensong'
  return null
}

export function parseBibleXml(xml: string, filename: string): ParsedBible {
  const format = detectFormat(xml)
  if (!format) {
    throw new ImportError(
      'Unrecognized file: expected a Zefania (<XMLBIBLE>), OpenSong (<bible>) or OSIS (<osis>) XML bible.',
    )
  }
  let doc: any
  try {
    doc = makeParser().parse(xml)
  } catch (err) {
    throw new ImportError(`The XML could not be parsed: ${err instanceof Error ? err.message : err}`)
  }
  switch (format) {
    case 'zefania':
      return parseZefania(doc)
    case 'opensong':
      return parseOpenSong(doc, filename)
    case 'osis':
      return parseOsis(doc, xml)
  }
}

// ---------- Zefania: <XMLBIBLE><BIBLEBOOK bnumber bname><CHAPTER cnumber><VERS vnumber> ----------

function parseZefania(doc: any): ParsedBible {
  const root = doc.XMLBIBLE
  if (!root) throw new ImportError('Zefania file has no <XMLBIBLE> root element.')
  const verses: RawVerse[] = []
  const notes: string[] = []
  const books = asArray(root.BIBLEBOOK)
  if (!books.length) throw new ImportError('Zefania file contains no <BIBLEBOOK> elements.')

  for (const b of books) {
    const bnumber = parseInt(b['@_bnumber'], 10)
    const bname = b['@_bname'] ?? `book ${b['@_bnumber']}`
    let book: number | null = bnumber >= 1 && bnumber <= 66 ? bnumber : null
    book ??= bookByName(String(bname))
    if (!book) {
      if (bnumber > 66) {
        notes.push(`Skipped non-canonical book "${bname}" (bnumber ${bnumber})`)
        continue
      }
      throw new ImportError(`Unknown book in Zefania file: "${bname}" (bnumber ${b['@_bnumber']})`)
    }
    for (const c of asArray(b.CHAPTER)) {
      const chapter = parseInt(c['@_cnumber'], 10)
      if (!chapter) continue
      for (const v of asArray(c.VERS)) {
        const verse = parseInt(typeof v === 'object' ? v['@_vnumber'] : NaN, 10)
        const text = clean(nodeText(v))
        if (!verse || !text) continue
        verses.push({ book, chapter, verse, text })
      }
    }
  }

  const name = nodeText(root.INFORMATION?.title) || null
  const abbrev = nodeText(root.INFORMATION?.identifier) || null
  return { format: 'zefania', name, abbrev, verses, notes }
}

// ---------- OpenSong: <bible><b n="Genesis"><c n="1"><v n="1"> ----------

function parseOpenSong(doc: any, filename: string): ParsedBible {
  const root = doc.bible
  if (!root) throw new ImportError('OpenSong file has no <bible> root element.')
  const verses: RawVerse[] = []
  const notes: string[] = []
  const books = asArray(root.b)
  if (!books.length) throw new ImportError('OpenSong file contains no <b> (book) elements.')

  for (const b of books) {
    const bname = String(b['@_n'] ?? '')
    const book = bookByName(bname)
    if (!book) throw new ImportError(`Unknown book in OpenSong file: "${bname}"`)
    for (const c of asArray(b.c)) {
      const chapter = parseInt(c['@_n'], 10)
      if (!chapter) continue
      for (const v of asArray(c.v)) {
        const rawN = typeof v === 'object' ? v['@_n'] : undefined
        const text = clean(nodeText(v))
        if (!rawN || !text) continue
        // OpenSong allows ranged verse numbers n="24-25"
        const range = String(rawN).match(/^(\d+)(?:-(\d+))?$/)
        if (!range) continue
        const verse = parseInt(range[1], 10)
        if (range[2]) notes.push(`${bname} ${chapter}:${rawN} is a joined verse — stored as verse ${verse}`)
        verses.push({ book, chapter, verse, text })
      }
    }
  }

  const name = String(root['@_n'] ?? '') || filename.replace(/\.[^.]+$/, '')
  return { format: 'opensong', name, abbrev: null, verses, notes }
}

// ---------- OSIS: <osis><osisText><div type="book" osisID="Gen"><chapter><verse osisID="Gen.1.1"> ----------

function parseOsis(doc: any, xml: string): ParsedBible {
  const osisText = doc.osis?.osisText
  if (!osisText) throw new ImportError('OSIS file has no <osisText> element.')

  // Milestone-form OSIS (<verse sID=.../>text<verse eID=.../>) flattens text outside
  // verse elements; detect and reject with a clear reason rather than import garbage.
  // (\s before sID matters: "osisID" must not match.)
  if (/<verse[^>]*\ssID\s*=/.test(xml)) {
    throw new ImportError(
      'This OSIS file uses milestone verse markers (sID/eID), which VerseCast cannot import yet. Export the bible in Zefania or OpenSong format instead.',
    )
  }

  const verses: RawVerse[] = []
  const notes: string[] = []

  const walkDivs = (node: any): void => {
    for (const div of asArray(node?.div)) {
      if (div['@_type'] === 'book') {
        importOsisBook(div)
      } else {
        walkDivs(div) // book groups nest divs
      }
    }
  }

  const importOsisBook = (div: any): void => {
    const osisId = String(div['@_osisID'] ?? '')
    const book = OSIS_TO_BOOK[osisId] ?? bookByName(osisId)
    if (!book) {
      if (osisId) {
        notes.push(`Skipped non-canonical OSIS book "${osisId}"`)
        return
      }
      throw new ImportError(`OSIS book <div> without an osisID attribute.`)
    }
    for (const ch of asArray(div.chapter)) {
      for (const v of asArray(ch.verse)) {
        const vid = String(v['@_osisID'] ?? '')
        const m = vid.match(/^[^.]+\.(\d+)\.(\d+)$/)
        if (!m) continue
        const text = clean(nodeText(v))
        if (!text) continue
        verses.push({ book, chapter: parseInt(m[1], 10), verse: parseInt(m[2], 10), text })
      }
    }
  }

  walkDivs(osisText)
  if (!verses.length) throw new ImportError('No verses found in the OSIS file.')

  const work = asArray(osisText.header?.work)[0]
  const name = work ? nodeText(work.title) || null : null
  return { format: 'osis', name, abbrev: null, verses, notes }
}

function asArray(x: unknown): any[] {
  if (x == null) return []
  return Array.isArray(x) ? x : [x]
}
