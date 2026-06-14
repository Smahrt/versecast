/**
 * Explicit reference parser (TDD §5.1). Cheap pattern matching, runs on
 * every transcript segment. Handles spoken forms:
 *   "John 3:16" · "John three sixteen" · "First Corinthians thirteen verse four"
 *   "John chapter three verse sixteen" · "Psalm one twenty one verses one to two"
 *   bare "verse five" when a chapter is already in context.
 */
import { buildAliasTable, verseCount, chapterCount, type Ref } from '@versecast/shared'
import { parseNumber, isOrdinalWord, ordinalValue } from './numbers.js'

export interface ParsedRef {
  ref: Ref
  /** The exact phrase in the input that produced this match */
  matchText: string
  /** Chapter-only mentions ("John chapter three") set context but are not detections */
  chapterOnly: boolean
}

export interface ChapterContext {
  book: number
  chapter: number
}

const ALIASES = buildAliasTable()
// alias word-token arrays for greedy matching
const ALIAS_TOKENS = ALIASES.map((a) => ({ tokens: a.alias.split(' '), book: a.book, weak: a.weak ?? false }))

interface Token {
  text: string
  /** offset of token start in original string */
  pos: number
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  const re = /[a-z0-9:.\-–]+/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(input.toLowerCase()))) {
    let text = m[0].replace(/\.+$/, '') // trailing periods
    if (!text) continue
    tokens.push({ text, pos: m.index })
  }
  return tokens
}

/** "3:16" / "3:16-18" → { chapter, verse, verseEnd } */
function parseColonRef(tok: string): { chapter: number; verse: number; verseEnd?: number } | null {
  const m = tok.match(/^(\d+):(\d+)(?:[-–](\d+))?$/)
  if (!m) return null
  return {
    chapter: parseInt(m[1], 10),
    verse: parseInt(m[2], 10),
    verseEnd: m[3] ? parseInt(m[3], 10) : undefined,
  }
}

function valid(book: number, chapter: number, verse?: number, verseEnd?: number): boolean {
  if (chapter < 1 || chapter > chapterCount(book)) return false
  if (verse !== undefined) {
    const max = verseCount(book, chapter)
    if (verse < 1 || verse > max) return false
    if (verseEnd !== undefined && (verseEnd <= verse - 1 || verseEnd > max)) return false
  }
  return true
}

/** Try to match a book alias starting at token index i. Returns book + tokens consumed. */
function matchBook(tokens: Token[], i: number): { book: number; consumed: number; weak: boolean } | null {
  for (const alias of ALIAS_TOKENS) {
    const n = alias.tokens.length
    if (i + n > tokens.length) continue
    let ok = true
    for (let k = 0; k < n; k++) {
      if (tokens[i + k].text !== alias.tokens[k]) {
        ok = false
        break
      }
    }
    if (ok) return { book: alias.book, consumed: n, weak: alias.weak }
  }
  return null
}

// 'ves' is how whisper renders spoken "verse" in accented speech (M2 finding)
const VERSE_MARKERS = new Set(['verse', 'verses', 'v', 'vs', 'ves'])
const RANGE_WORDS = new Set(['to', 'through', 'till', 'until'])
// connective filler between chapter and verse marker: "chapter 41 and in verse 10"
const FILLER_WORDS = new Set(['and', 'in', 'the', 'of'])

function skipFiller(tokens: Token[], i: number): number {
  let k = i
  while (k < tokens.length && FILLER_WORDS.has(tokens[k].text)) k++
  return k
}

/** Collect consecutive number groups after a position, stopping at non-number words. */
function collectNumbers(tokens: Token[], start: number, max = 3): { values: number[]; end: number } {
  const values: number[] = []
  let i = start
  while (i < tokens.length && values.length < max) {
    if (isOrdinalWord(tokens[i].text) && values.length === 0) {
      // "the third chapter" handled elsewhere; ordinal as verse number: "verse first" — rare, accept
      const v = ordinalValue(tokens[i].text)
      if (v === null) break
      values.push(v)
      i++
      continue
    }
    const parsed = parseNumber(tokens.map((t) => t.text), i)
    if (!parsed) break
    values.push(parsed.value)
    i += parsed.consumed
  }
  return { values, end: i }
}

/**
 * Compose candidate chapter numbers from leading spoken-number groups.
 * [1, 21] → candidates [121 ("one twenty one"), 1] — validated by caller.
 */
function chapterCandidates(values: number[]): { chapter: number; used: number }[] {
  const out: { chapter: number; used: number }[] = []
  if (values.length >= 2 && values[0] < 10 && values[1] >= 20 && values[1] <= 99) {
    out.push({ chapter: values[0] * 100 + values[1], used: 2 })
  }
  if (values.length >= 1) out.push({ chapter: values[0], used: 1 })
  return out
}

/**
 * Parse all references in a piece of transcript text.
 * `context` carries the last explicit book+chapter for bare "verse N".
 */
export function parseRefs(text: string, context?: ChapterContext | null): ParsedRef[] {
  const tokens = tokenize(text)
  const results: ParsedRef[] = []
  let localContext: ChapterContext | null = context ?? null
  let i = 0

  const slice = (from: number, to: number) =>
    text.slice(tokens[from].pos, tokens[to].pos + tokens[to].text.length)

  while (i < tokens.length) {
    const book = matchBook(tokens, i)
    if (book) {
      const startTok = i
      let j = i + book.consumed
      // optional filler: "chapter" or ordinal-chapter form "the third chapter of john" not supported; forward forms only
      let sawChapterWord = false
      if (j < tokens.length && tokens[j].text === 'chapter') {
        sawChapterWord = true
        j++
      }

      // Digit colon form: "3:16"
      const colon = j < tokens.length ? parseColonRef(tokens[j].text) : null
      if (colon && valid(book.book, colon.chapter, colon.verse, colon.verseEnd)) {
        const ref: Ref = { book: book.book, chapter: colon.chapter, verse: colon.verse }
        if (colon.verseEnd && colon.verseEnd > colon.verse) ref.verseEnd = colon.verseEnd
        results.push({ ref, matchText: slice(startTok, j), chapterOnly: false })
        localContext = { book: book.book, chapter: colon.chapter }
        i = j + 1
        continue
      }

      // Spoken numbers
      const lead = collectNumbers(tokens, j, 2)
      if (lead.values.length > 0) {
        let matched = false
        for (const cand of chapterCandidates(lead.values)) {
          if (!valid(book.book, cand.chapter)) continue
          let k = j
          // re-walk tokens consumed by the candidate's number groups
          let groupsToConsume = cand.used
          while (groupsToConsume > 0 && k < tokens.length) {
            const adv = collectNumbers(tokens, k, 1)
            k = adv.end
            groupsToConsume--
          }

          // "verse(s) N [to M]" — allowing connective filler ("and in verse 10")
          k = skipFiller(tokens, k)
          if (k < tokens.length && VERSE_MARKERS.has(tokens[k].text)) {
            const vNums = collectNumbers(tokens, k + 1, 1)
            if (vNums.values.length === 1) {
              let verseEnd: number | undefined
              let end = vNums.end
              if (end < tokens.length && RANGE_WORDS.has(tokens[end].text)) {
                const rangeNum = collectNumbers(tokens, end + 1, 1)
                if (rangeNum.values.length === 1) {
                  verseEnd = rangeNum.values[0]
                  end = rangeNum.end
                }
              }
              if (valid(book.book, cand.chapter, vNums.values[0], verseEnd)) {
                const ref: Ref = { book: book.book, chapter: cand.chapter, verse: vNums.values[0] }
                if (verseEnd && verseEnd > ref.verse) ref.verseEnd = verseEnd
                results.push({ ref, matchText: slice(startTok, end - 1), chapterOnly: false })
                localContext = { book: book.book, chapter: cand.chapter }
                i = end
                matched = true
                break
              }
            }
            // "John chapter three" followed by dangling verse marker — chapter context only
            if (valid(book.book, cand.chapter)) {
              localContext = { book: book.book, chapter: cand.chapter }
              results.push({
                ref: { book: book.book, chapter: cand.chapter, verse: 1 },
                matchText: slice(startTok, k - 1),
                chapterOnly: true,
              })
              i = k
              matched = true
              break
            }
          }

          // "Book C V" — bare chapter + verse numbers (e.g. "john three sixteen").
          // Weak aliases ("some" → Psalms) never match this shape: "some forty
          // people" must not become Psalm 40 — they need an explicit marker.
          const remaining = lead.values.slice(cand.used)
          if (!book.weak && remaining.length === 1 && valid(book.book, cand.chapter, remaining[0])) {
            results.push({
              ref: { book: book.book, chapter: cand.chapter, verse: remaining[0] },
              matchText: slice(startTok, lead.end - 1),
              chapterOnly: false,
            })
            localContext = { book: book.book, chapter: cand.chapter }
            i = lead.end
            matched = true
            break
          }

          // Chapter-only mention: "John chapter 3" / "Psalm 121" — context, not a full detection
          if (remaining.length === 0 && (sawChapterWord || cand.used === lead.values.length) && valid(book.book, cand.chapter)) {
            localContext = { book: book.book, chapter: cand.chapter }
            results.push({
              ref: { book: book.book, chapter: cand.chapter, verse: 1 },
              matchText: slice(startTok, lead.end - 1),
              chapterOnly: true,
            })
            i = lead.end
            matched = true
            break
          }
        }
        if (matched) continue
      }
      i += book.consumed
      continue
    }

    // Bare "verse N [to M]" with chapter context
    if (VERSE_MARKERS.has(tokens[i].text) && localContext) {
      const vNums = collectNumbers(tokens, i + 1, 1)
      if (vNums.values.length === 1) {
        let verseEnd: number | undefined
        let end = vNums.end
        if (end < tokens.length && RANGE_WORDS.has(tokens[end].text)) {
          const rangeNum = collectNumbers(tokens, end + 1, 1)
          if (rangeNum.values.length === 1) {
            verseEnd = rangeNum.values[0]
            end = rangeNum.end
          }
        }
        if (valid(localContext.book, localContext.chapter, vNums.values[0], verseEnd)) {
          const ref: Ref = {
            book: localContext.book,
            chapter: localContext.chapter,
            verse: vNums.values[0],
          }
          if (verseEnd && verseEnd > ref.verse) ref.verseEnd = verseEnd
          results.push({ ref, matchText: slice(i, end - 1), chapterOnly: false })
          i = end
          continue
        }
      }
    }

    i++
  }

  return results
}

/** Final chapter context after parsing (for the detector to carry forward). */
export function lastContext(parsed: ParsedRef[], prior: ChapterContext | null): ChapterContext | null {
  const last = parsed[parsed.length - 1]
  if (last) return { book: last.ref.book, chapter: last.ref.chapter }
  return prior
}

/**
 * Forgiving reference resolution for the search box (Feature: reference strip).
 * Unlike parseRefs, this accepts partial references and defaults what's missing,
 * so live-typed prefixes resolve as you go:
 *   "gen" → Genesis 1:1 · "gen 12" → Genesis 12:1 · "gen 12:3" → Genesis 12:3
 *   "first corinthians thirteen" → 1 Corinthians 13:1 · "psalm 23 verse 1" → Psalm 23:1
 * Returns null unless a book sits at the start AND the only trailing tokens are
 * numbers/markers/filler — so a phrase that merely contains a book word
 * ("the armor of God", "mark of the beast") does NOT resolve.
 */
export function resolveReferenceQuery(text: string): Ref | null {
  const tokens = tokenize(text)
  if (!tokens.length) return null
  const book = matchBook(tokens, 0)
  if (!book) return null

  let j = book.consumed
  if (j < tokens.length && tokens[j].text === 'chapter') j++

  let chapter = 1
  let verse: number | undefined
  let verseEnd: number | undefined
  let end = j

  const colon = j < tokens.length ? parseColonRef(tokens[j].text) : null
  if (colon) {
    chapter = colon.chapter
    verse = colon.verse
    verseEnd = colon.verseEnd
    end = j + 1
  } else {
    const lead = collectNumbers(tokens, j, 2)
    if (lead.values.length > 0) {
      const cands = chapterCandidates(lead.values)
      let chosen = cands[cands.length - 1]
      for (const c of cands) {
        if (c.chapter <= chapterCount(book.book)) {
          chosen = c
          break
        }
      }
      chapter = chosen.chapter
      const remaining = lead.values.slice(chosen.used)
      if (remaining.length >= 1) {
        verse = remaining[0]
        end = lead.end
      } else {
        // walk past the chapter number group(s) to look for a verse marker
        let k = j
        let groups = chosen.used
        while (groups > 0 && k < tokens.length) {
          k = collectNumbers(tokens, k, 1).end
          groups--
        }
        end = k
        k = skipFiller(tokens, k)
        if (k < tokens.length && VERSE_MARKERS.has(tokens[k].text)) {
          const v = collectNumbers(tokens, k + 1, 1)
          if (v.values.length === 1) {
            verse = v.values[0]
            end = v.end
            if (end < tokens.length && RANGE_WORDS.has(tokens[end].text)) {
              const r = collectNumbers(tokens, end + 1, 1)
              if (r.values.length === 1) {
                verseEnd = r.values[0]
                end = r.end
              }
            }
          }
        }
      }
    }
  }

  // Anything left over must be filler, else this wasn't a reference query
  for (let t = end; t < tokens.length; t++) {
    if (!FILLER_WORDS.has(tokens[t].text)) return null
  }

  chapter = Math.min(Math.max(chapter, 1), chapterCount(book.book))
  const maxV = verseCount(book.book, chapter)
  verse = Math.min(Math.max(verse ?? 1, 1), maxV)
  const ref: Ref = { book: book.book, chapter, verse }
  if (verseEnd !== undefined && verseEnd > verse && verseEnd <= maxV) ref.verseEnd = verseEnd
  return ref
}
