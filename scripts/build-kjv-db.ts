/**
 * Build resources/kjv.db from resources/data/en_kjv.json (one-time, at build).
 * Schema per TDD §7.1.
 */
import Database from 'better-sqlite3'
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcPath = path.join(root, 'resources/data/en_kjv.json')
const dbPath = path.join(root, 'resources/kjv.db')

interface SourceBook {
  abbrev: string
  name: string
  chapters: string[][]
}

const raw = readFileSync(srcPath, 'utf8').replace(/^﻿/, '')
const books: SourceBook[] = JSON.parse(raw)
if (books.length !== 66) throw new Error(`Expected 66 books, got ${books.length}`)

/**
 * The source wraps two kinds of content in braces:
 *  - supplied/italicized words: "{it was}"  → keep the words
 *  - marginal notes: "{the light from...: Heb. ...}" → drop entirely
 */
function cleanVerse(text: string): string {
  return text
    .replace(/^\[[^\]]*\]\s*/, '') // Psalm titles ride in verse 1 as a [bracketed] prefix
    .replace(/\{[^}]*:[^}]*\}/g, '') // marginal notes contain a colon
    .replace(/\{([^}]*)\}/g, '$1') // supplied words: unwrap
    .replace(/\s+/g, ' ')
    .trim()
}

mkdirSync(path.dirname(dbPath), { recursive: true })
if (existsSync(dbPath)) rmSync(dbPath)

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE translations (
    id TEXT PRIMARY KEY,
    name TEXT, abbrev TEXT,
    source TEXT,
    imported_at INTEGER,
    versification_report TEXT
  );
  CREATE TABLE verses (
    translation_id TEXT,
    book INTEGER,
    chapter INTEGER,
    verse INTEGER,
    text TEXT,
    PRIMARY KEY (translation_id, book, chapter, verse)
  );
`)

db.prepare(
  `INSERT INTO translations (id, name, abbrev, source, imported_at, versification_report)
   VALUES ('kjv', 'King James Version', 'KJV', 'bundled', ?, '{"issues":[]}')`,
).run(Date.now())

const insert = db.prepare(
  'INSERT INTO verses (translation_id, book, chapter, verse, text) VALUES (?, ?, ?, ?, ?)',
)
let count = 0
db.transaction(() => {
  books.forEach((book, bi) => {
    book.chapters.forEach((chapter, ci) => {
      chapter.forEach((text, vi) => {
        insert.run('kjv', bi + 1, ci + 1, vi + 1, cleanVerse(text))
        count++
      })
    })
  })
})()

db.close()
console.log(`kjv.db built: ${count} verses`)
