import booksData from './books-data.json' with { type: 'json' }

export interface Book {
  /** Canonical index 1–66 */
  n: number
  name: string
  osis: string
  /** Verses per chapter (KJV versification) */
  vpc: number[]
}

export const BOOKS: Book[] = booksData as Book[]

export function bookByNumber(n: number): Book | undefined {
  return BOOKS[n - 1]
}

export function chapterCount(book: number): number {
  return BOOKS[book - 1]?.vpc.length ?? 0
}

export function verseCount(book: number, chapter: number): number {
  return BOOKS[book - 1]?.vpc[chapter - 1] ?? 0
}

/** Display name with singular Psalm for single-chapter refs ("Psalm 23:1"). */
export function displayBookName(book: number, _chapter?: number): string {
  const b = BOOKS[book - 1]
  if (!b) return `Book ${book}`
  return b.name === 'Psalms' ? 'Psalm' : b.name
}

const ORDINAL_PREFIX: Record<string, string[]> = {
  '1': ['1', '1st', 'first', 'one', 'i'],
  '2': ['2', '2nd', 'second', 'two', 'ii'],
  '3': ['3', '3rd', 'third', 'three', 'iii'],
}

/** Extra spoken/written aliases beyond the canonical name, keyed by book number. */
const EXTRA_ALIASES: Record<number, string[]> = {
  1: ['gen'],
  2: ['exo', 'ex'],
  3: ['lev'],
  4: ['num'],
  5: ['deut', 'deu'],
  6: ['josh'],
  7: ['judg'],
  9: ['samuel', 'sam'],
  10: ['sam'],
  11: ['kings', 'kgs'],
  12: ['kgs'],
  13: ['chronicles', 'chr'],
  14: ['chr'],
  16: ['nehemia'],
  18: [],
  19: ['psalm', 'psa', 'ps'],
  20: ['prov'],
  21: ['ecc', 'eccles'],
  22: ['song of songs', 'songs', 'songs of solomon', 'canticles'],
  23: ['isa'],
  24: ['jer'],
  25: ['lam'],
  26: ['ezek', 'eze'],
  27: ['dan'],
  40: ['matt', 'mat'],
  41: ['mk'],
  42: ['luk', 'lk'],
  43: ['jn'],
  44: ['acts of the apostles', 'act'],
  45: ['rom'],
  46: ['corinthians', 'cor'],
  47: ['cor'],
  48: ['gal'],
  49: ['eph'],
  50: ['phil', 'philippians'],
  51: ['col'],
  52: ['thessalonians', 'thess'],
  53: ['thess'],
  54: ['timothy', 'tim'],
  55: ['tim'],
  56: ['tit'],
  57: ['philemon'],
  58: ['heb'],
  59: ['jas'],
  60: ['peter', 'pet'],
  61: ['pet'],
  62: ['john', 'jn'],
  63: ['jn'],
  64: ['jn'],
  65: ['jud'],
  66: ['revelations', 'rev', 'the revelation'],
}

export interface BookAlias {
  alias: string
  book: number
  /**
   * Weak aliases are common words whisper substitutes for book names in
   * accented speech (M2 finding: "Psalm 94" → "some 94"). They only count
   * when followed by an explicit chapter/verse marker shape, never bare.
   */
  weak?: boolean
}

/**
 * Flat alias list (lowercase) → book number, longest aliases first so a
 * greedy matcher prefers "song of solomon" over "song".
 * Numbered books expand to every spoken prefix form:
 * "1 john" / "first john" / "one john" / "1st john".
 */
export function buildAliasTable(): BookAlias[] {
  const out: BookAlias[] = []
  const add = (alias: string, book: number) => out.push({ alias: alias.toLowerCase(), book })

  for (const b of BOOKS) {
    const m = b.name.match(/^([123]) (.+)$/)
    if (m) {
      const [, num, base] = m
      const baseForms = [base.toLowerCase()]
      // "1 Corinthians" should also match spoken "first corinthians"
      for (const extra of EXTRA_ALIASES[b.n] ?? []) baseForms.push(extra)
      for (const baseForm of baseForms) {
        for (const prefix of ORDINAL_PREFIX[num]) add(`${prefix} ${baseForm}`, b.n)
      }
    } else {
      add(b.name, b.n)
      for (const extra of EXTRA_ALIASES[b.n] ?? []) add(extra, b.n)
    }
  }

  // Ambiguous bases default to the most-quoted book when spoken without a number
  add('john', 43)
  add('samuel', 9)
  add('kings', 11)
  add('chronicles', 13)
  add('corinthians', 46)
  add('thessalonians', 52)
  add('timothy', 54)
  add('peter', 60)

  // Whisper mishearings observed in real sermon audio (weak: marker-gated)
  out.push({ alias: 'some', book: 19, weak: true })

  // Dedupe (keep first occurrence) then sort longest-first for greedy matching
  const seen = new Set<string>()
  const deduped = out.filter((a) => {
    if (seen.has(a.alias)) return false
    seen.add(a.alias)
    return true
  })
  deduped.sort((a, b) => b.alias.split(' ').length - a.alias.split(' ').length || b.alias.length - a.alias.length)
  return deduped
}

/** OSIS id (e.g. "1Cor") → book number, for OSIS imports. */
export const OSIS_TO_BOOK: Record<string, number> = Object.fromEntries(
  BOOKS.map((b) => [b.osis, b.n]),
)
