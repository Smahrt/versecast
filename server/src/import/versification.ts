/**
 * KJV versification normalization (TDD §8 phase 3).
 * The mapping table is data, not code — gaps found in the field are a JSON fix.
 * Verses that cannot map cleanly are recorded in the report, never silently dropped.
 */
import { verseCount, chapterCount, formatRef, displayBookName } from '@versecast/shared'
import type { VersificationReport } from '@versecast/shared'
import type { RawVerse } from './formats.js'

interface Mapping {
  from: { book: number; chapter: number; verse: number }
  to: { book: number; chapter: number; verse: number }
  note: string
}

/**
 * Known divergence spots between common translations and the canonical map.
 * The bundled canonical table already carries the modern splits
 * (3 John 14/15, Revelation 12:18), so those import 1:1; sources with the
 * traditional shorter numbering surface through the missing-verse sweep.
 * Entries here are for sources with MORE verses than the canonical table
 * at known spots — the source verse text appends to the target verse.
 * This table is data, not code: field-found gaps are a one-line fix.
 */
const MAPPINGS: Mapping[] = []

export interface VersifyResult {
  verses: RawVerse[]
  report: VersificationReport
}

export function versify(input: RawVerse[], parseNotes: string[]): VersifyResult {
  const issues: VersificationReport['issues'] = parseNotes.map((note) => ({ ref: '—', note }))
  const byKey = new Map<string, RawVerse>()
  const key = (b: number, c: number, v: number) => `${b}:${c}:${v}`

  for (const raw of input) {
    let { book, chapter, verse, text } = raw

    // Psalm titles occasionally arrive as verse 0 — prefix to verse 1, flagged.
    if (verse === 0) {
      issues.push({
        ref: `${displayBookName(book, chapter)} ${chapter}:0`,
        note: 'Verse 0 (title) merged into verse 1',
      })
      verse = 1
      const existing = byKey.get(key(book, chapter, 1))
      if (existing) {
        existing.text = `${text} ${existing.text}`
        continue
      }
    }

    if (chapter < 1 || chapter > chapterCount(book)) {
      issues.push({
        ref: `${displayBookName(book, chapter)} ${chapter}:${verse}`,
        note: `Chapter ${chapter} does not exist in KJV versification — verse not imported`,
      })
      continue
    }

    const kjvMax = verseCount(book, chapter)
    if (verse > kjvMax) {
      const mapping = MAPPINGS.find(
        (m) => m.from.book === book && m.from.chapter === chapter && m.from.verse === verse,
      )
      if (mapping) {
        const target = byKey.get(key(mapping.to.book, mapping.to.chapter, mapping.to.verse))
        if (target) {
          target.text = `${target.text} ${text}`
          issues.push({ ref: formatRef({ ...mapping.to }), note: mapping.note })
          continue
        }
      }
      // Last verse overflow (joined-verse translations): append to the chapter's final KJV verse
      const target = byKey.get(key(book, chapter, kjvMax))
      if (verse === kjvMax + 1 && target) {
        target.text = `${target.text} ${text}`
        issues.push({
          ref: `${displayBookName(book, chapter)} ${chapter}:${kjvMax}`,
          note: `Verse ${verse} exceeds KJV chapter length — merged into verse ${kjvMax}`,
        })
        continue
      }
      issues.push({
        ref: `${displayBookName(book, chapter)} ${chapter}:${verse}`,
        note: `Verse ${verse} exceeds KJV chapter length (${kjvMax}) — verse not imported`,
      })
      continue
    }

    const k = key(book, chapter, verse)
    const existing = byKey.get(k)
    if (existing) {
      existing.text = `${existing.text} ${text}`
      issues.push({
        ref: `${displayBookName(book, chapter)} ${chapter}:${verse}`,
        note: 'Duplicate verse number — texts joined',
      })
    } else {
      byKey.set(k, { book, chapter, verse, text })
    }
  }

  // Missing-verse sweep: holes where KJV has text but the import does not
  const presentBooks = new Set([...byKey.values()].map((v) => v.book))
  for (const book of presentBooks) {
    for (let c = 1; c <= chapterCount(book); c++) {
      const chapterVerses = [...byKey.values()].filter((v) => v.book === book && v.chapter === c)
      if (!chapterVerses.length) continue // whole chapter absent → partial bible, counted below
      for (let v = 1; v <= verseCount(book, c); v++) {
        if (!byKey.has(key(book, c, v))) {
          issues.push({
            ref: `${displayBookName(book, c)} ${c}:${v}`,
            note: 'Verse missing from this translation (present in KJV)',
          })
        }
      }
    }
  }

  if (presentBooks.size < 66) {
    issues.push({ ref: '—', note: `Partial bible: ${presentBooks.size} of 66 books present` })
  }

  const verses = [...byKey.values()].sort(
    (a, b) => a.book - b.book || a.chapter - b.chapter || a.verse - b.verse,
  )
  return { verses, report: { issues } }
}
