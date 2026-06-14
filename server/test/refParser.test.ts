import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRefs } from '../src/search/refParser.js'
import { formatRef } from '@versecast/shared'

function refs(text: string, ctx?: { book: number; chapter: number }) {
  return parseRefs(text, ctx ?? null)
    .filter((r) => !r.chapterOnly)
    .map((r) => formatRef(r.ref))
}

test('digit colon form', () => {
  assert.deepEqual(refs('Turn with me to John 3:16 this morning'), ['John 3:16'])
})

test('digit colon range', () => {
  assert.deepEqual(refs('Psalm 121:1-2 says'), ['Psalm 121:1–2'])
})

test('spoken chapter verse words', () => {
  assert.deepEqual(refs('turn to john chapter three verse sixteen'), ['John 3:16'])
})

test('bare spoken numbers', () => {
  assert.deepEqual(refs('john three sixteen'), ['John 3:16'])
})

test('ordinal book prefix', () => {
  assert.deepEqual(refs('first corinthians thirteen verse four'), ['1 Corinthians 13:4'])
})

test('one john variant', () => {
  assert.deepEqual(refs('one john four nineteen'), ['1 John 4:19'])
})

test('psalm one twenty one composition', () => {
  assert.deepEqual(refs('psalm one twenty one verse one'), ['Psalm 121:1'])
})

test('verses range words', () => {
  assert.deepEqual(refs('ephesians six verses eleven to thirteen'), ['Ephesians 6:11–13'])
})

test('revelations alias', () => {
  assert.deepEqual(refs('revelations twenty one verse four'), ['Revelation 21:4'])
})

test('songs alias', () => {
  assert.deepEqual(refs('song of solomon two verse one'), ['Song of Solomon 2:1'])
})

test('bare verse with context', () => {
  assert.deepEqual(refs('and verse five says', { book: 43, chapter: 3 }), ['John 3:5'])
})

test('chapter mention sets context for later verse', () => {
  assert.deepEqual(refs('turn to romans chapter eight... now look at verse twenty eight'), ['Romans 8:28'])
})

test('invalid verse rejected', () => {
  assert.deepEqual(refs('genesis one ninety nine'), [])
})

test('no false positives on plain speech', () => {
  assert.deepEqual(refs('the shepherd goes ahead of the sheep and leads them'), [])
})

test('john without number defaults to gospel', () => {
  assert.deepEqual(refs('john 14:6'), ['John 14:6'])
})

test('multiple refs in one segment', () => {
  assert.deepEqual(refs('john 3:16 and also romans 5:8'), ['John 3:16', 'Romans 5:8'])
})

test('second timothy', () => {
  assert.deepEqual(refs('second timothy one verse seven'), ['2 Timothy 1:7'])
})

test('matchText covers the phrase', () => {
  const out = parseRefs('turn with me to John chapter three, verse sixteen — this is it', null)
  const full = out.find((r) => !r.chapterOnly)
  assert.ok(full)
  assert.match(full.matchText, /John chapter three, verse sixteen/i)
})

// --- M2 tuning cases from the real sermon recording ---

test('filler words between chapter and verse marker', () => {
  assert.deepEqual(refs('Isaiah chapter 41 and in verse 10'), ['Isaiah 41:10'])
})

test('whisper "some" for Psalm, with verse marker', () => {
  assert.deepEqual(refs('some 94 verse 18'), ['Psalm 94:18'])
})

test('"some N" sets chapter context for a later bare verse', () => {
  assert.deepEqual(refs('in the name of Jesus, some 94. VES 18!'), ['Psalm 94:18'])
})

test('bare "some N M" never misfires as Psalm', () => {
  assert.deepEqual(refs('there were some forty people there'), [])
  assert.deepEqual(refs('some 40 5 of them'), [])
})

test('ves marker variant with existing context', () => {
  assert.deepEqual(refs('ves 18', { book: 19, chapter: 94 }), ['Psalm 94:18'])
})
