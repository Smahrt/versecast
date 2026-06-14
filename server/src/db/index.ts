import Database from 'better-sqlite3'
import { formatRef, type Ref, type TranslationInfo, type VerseContext, type VersificationReport } from '@versecast/shared'
import { PATHS } from '../config.js'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface VerseRow {
  book: number
  chapter: number
  verse: number
  text: string
}

let db: Database.Database | null = null

export function openDb(): Database.Database {
  if (db) return db
  if (!existsSync(PATHS.db)) {
    throw new Error(
      `Bible database not found at ${PATHS.db}. Run \`npm run data:db\` to build it from the bundled KJV.`,
    )
  }
  db = new Database(PATHS.db)
  db.pragma('journal_mode = WAL')
  return db
}

export function listTranslations(): TranslationInfo[] {
  const rows = openDb()
    .prepare('SELECT id, name, abbrev, source, versification_report FROM translations')
    .all() as { id: string; name: string; abbrev: string; source: string; versification_report: string }[]
  return rows.map((r) => {
    let issues = 0
    try {
      issues = (JSON.parse(r.versification_report ?? '{"issues":[]}') as VersificationReport).issues.length
    } catch {
      /* report unreadable — surface zero rather than crash */
    }
    return {
      id: r.id,
      name: r.name,
      abbrev: r.abbrev,
      source: r.source as TranslationInfo['source'],
      indexed: existsSync(path.join(PATHS.embeddings, `${r.id}.bin`)),
      versificationIssues: issues,
    }
  })
}

export function getTranslation(id: string): TranslationInfo | undefined {
  return listTranslations().find((t) => t.id === id)
}

export function getVersificationReport(id: string): VersificationReport {
  const row = openDb()
    .prepare('SELECT versification_report FROM translations WHERE id = ?')
    .get(id) as { versification_report: string } | undefined
  if (!row) return { issues: [] }
  try {
    return JSON.parse(row.versification_report)
  } catch {
    return { issues: [] }
  }
}

export function getVerse(translationId: string, book: number, chapter: number, verse: number): string | null {
  const row = openDb()
    .prepare('SELECT text FROM verses WHERE translation_id=? AND book=? AND chapter=? AND verse=?')
    .get(translationId, book, chapter, verse) as { text: string } | undefined
  return row?.text ?? null
}

/** Text for a ref (joins ranges with spaces). Returns null if entirely missing. */
export function getRefText(translationId: string, ref: Ref): string | null {
  const end = ref.verseEnd ?? ref.verse
  const rows = openDb()
    .prepare(
      'SELECT verse, text FROM verses WHERE translation_id=? AND book=? AND chapter=? AND verse BETWEEN ? AND ? ORDER BY verse',
    )
    .all(translationId, ref.book, ref.chapter, ref.verse, end) as { verse: number; text: string }[]
  if (!rows.length) return null
  return rows.map((r) => r.text).join(' ')
}

/** One verse before/after within the chapter — context for detections and search results. */
export function contextAround(
  translationId: string,
  ref: Ref,
): { before: VerseContext | null; after: VerseContext | null } {
  const end = ref.verseEnd ?? ref.verse
  let before: VerseContext | null = null
  let after: VerseContext | null = null
  if (ref.verse > 1) {
    const text = getVerse(translationId, ref.book, ref.chapter, ref.verse - 1)
    if (text) before = { refString: formatRef({ book: ref.book, chapter: ref.chapter, verse: ref.verse - 1 }), text }
  }
  if (end < maxVerse(translationId, ref.book, ref.chapter)) {
    const text = getVerse(translationId, ref.book, ref.chapter, end + 1)
    if (text) after = { refString: formatRef({ book: ref.book, chapter: ref.chapter, verse: end + 1 }), text }
  }
  return { before, after }
}

export function maxVerse(translationId: string, book: number, chapter: number): number {
  const row = openDb()
    .prepare('SELECT MAX(verse) as m FROM verses WHERE translation_id=? AND book=? AND chapter=?')
    .get(translationId, book, chapter) as { m: number | null }
  return row.m ?? 0
}

/** All verses of a translation in canonical order — for indexing. */
export function allVerses(translationId: string): VerseRow[] {
  return openDb()
    .prepare(
      'SELECT book, chapter, verse, text FROM verses WHERE translation_id=? ORDER BY book, chapter, verse',
    )
    .all(translationId) as VerseRow[]
}

export function deleteTranslation(id: string): void {
  const d = openDb()
  d.prepare('DELETE FROM verses WHERE translation_id=?').run(id)
  d.prepare('DELETE FROM translations WHERE id=?').run(id)
}

export function insertTranslation(
  info: { id: string; name: string; abbrev: string; source: string },
  verses: VerseRow[],
  report: VersificationReport,
): void {
  const d = openDb()
  const tx = d.transaction(() => {
    d.prepare(
      'INSERT INTO translations (id, name, abbrev, source, imported_at, versification_report) VALUES (?,?,?,?,?,?)',
    ).run(info.id, info.name, info.abbrev, info.source, Date.now(), JSON.stringify(report))
    const ins = d.prepare(
      'INSERT OR REPLACE INTO verses (translation_id, book, chapter, verse, text) VALUES (?,?,?,?,?)',
    )
    for (const v of verses) ins.run(info.id, v.book, v.chapter, v.verse, v.text)
  })
  tx()
}
