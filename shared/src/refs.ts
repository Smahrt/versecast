import type { Ref } from './types.js'
import { displayBookName, chapterCount, verseCount } from './books.js'

/** "John 3:16" / "Psalm 121:1–2" */
export function formatRef(ref: Ref): string {
  const base = `${displayBookName(ref.book, ref.chapter)} ${ref.chapter}:${ref.verse}`
  return ref.verseEnd && ref.verseEnd > ref.verse ? `${base}–${ref.verseEnd}` : base
}

export function refsEqual(a: Ref | null, b: Ref | null): boolean {
  if (!a || !b) return a === b
  return (
    a.book === b.book &&
    a.chapter === b.chapter &&
    a.verse === b.verse &&
    (a.verseEnd ?? a.verse) === (b.verseEnd ?? b.verse)
  )
}

export function refKey(ref: Ref): string {
  return `${ref.book}:${ref.chapter}:${ref.verse}:${ref.verseEnd ?? ref.verse}`
}

/**
 * The adjacent single verse (KJV-normalized numbering), crossing chapter and
 * book boundaries. Steps from a range's far edge (next from verseEnd, prev
 * from verse). Returns null at the canon boundaries (before Genesis 1:1,
 * after Revelation 22:21). Always returns a single-verse ref.
 */
export function stepVerse(ref: Ref, dir: 1 | -1): Ref | null {
  let { book, chapter } = ref
  let verse = dir === 1 ? (ref.verseEnd ?? ref.verse) + 1 : ref.verse - 1

  if (dir === 1 && verse > verseCount(book, chapter)) {
    chapter += 1
    verse = 1
    if (chapter > chapterCount(book)) {
      book += 1
      chapter = 1
      if (book > 66) return null
    }
  } else if (dir === -1 && verse < 1) {
    chapter -= 1
    if (chapter < 1) {
      book -= 1
      if (book < 1) return null
      chapter = chapterCount(book)
    }
    verse = verseCount(book, chapter)
  }
  return { book, chapter, verse }
}

const SLIDE_MAX_WORDS = 80

/**
 * Split verse text into slides. Most verses fit one slide; beyond
 * ~80 words split into roughly equal chunks, breaking at sentence or
 * clause boundaries where possible.
 */
export function splitIntoSlides(text: string): string[] {
  const words = text.trim().split(/\s+/)
  if (words.length <= SLIDE_MAX_WORDS) return [text.trim()]

  const slideCount = Math.ceil(words.length / SLIDE_MAX_WORDS)
  const targetPerSlide = Math.ceil(words.length / slideCount)
  const slides: string[] = []
  let current: string[] = []

  for (const word of words) {
    current.push(word)
    const atTarget = current.length >= targetPerSlide
    const nearTarget = current.length >= targetPerSlide - 12
    const breaksWell = /[.;:!?]$/.test(word)
    if (atTarget || (nearTarget && breaksWell)) {
      slides.push(current.join(' '))
      current = []
    }
  }
  if (current.length) slides.push(current.join(' '))
  return slides
}
