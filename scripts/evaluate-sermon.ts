/**
 * M2 evaluation harness (TDD §13): run a real sermon recording through the
 * production VAD → whisper → detection pipeline, offline (no dropped
 * windows), and report everything needed to tune the semantic threshold.
 *
 *   npx tsx scripts/evaluate-sermon.ts <wav-16k-mono> [tier]
 *
 * Prints the transcript, every explicit-reference hit, and the top semantic
 * match per sentence boundary with its score — including matches below the
 * firing threshold, so the threshold can be chosen from real data.
 */
import { readFileSync } from 'node:fs'
import { Vad } from '../server/src/asr/vad.js'
import { WhisperSupervisor } from '../server/src/asr/whisper.js'
import { parseRefs, lastContext, type ChapterContext } from '../server/src/search/refParser.js'
import { semanticScan } from '../server/src/search/engine.js'
import { getEmbedder } from '../server/src/search/embedder.js'
import { openDb, getRefText } from '../server/src/db/index.js'
import { formatRef, refKey, type ModelTier } from '@versecast/shared'

const SAMPLE_RATE = 16000
const THRESHOLD = 0.62
const DEDUPE_MS = 3 * 60 * 1000
const MIN_SEMANTIC_WORDS = 6

const wavPath = process.argv[2]
const tier = (process.argv[3] ?? 'base.en') as ModelTier
if (!wavPath) {
  console.error('usage: npx tsx scripts/evaluate-sermon.ts <wav-16k-mono> [tier]')
  process.exit(1)
}

function readWavPcm(path: string): Int16Array {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV file')
  let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      const rate = buf.readUInt32LE(off + 12)
      const channels = buf.readUInt16LE(off + 10)
      if (rate !== SAMPLE_RATE || channels !== 1) {
        throw new Error(
          `expected 16 kHz mono, got ${rate} Hz ${channels}ch — convert first: afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav`,
        )
      }
    }
    if (id === 'data') {
      return new Int16Array(buf.buffer, buf.byteOffset + off + 8, size / 2)
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

openDb()
const pcm = readWavPcm(wavPath)
console.log(`audio: ${fmt(pcm.length / SAMPLE_RATE)} · model: ${tier} · threshold: ${THRESHOLD}\n`)

// 1. VAD over the whole recording
const vad = new Vad(SAMPLE_RATE)
const windows: { from: number; to: number }[] = []
const CHUNK = 4000
for (let i = 0; i < pcm.length; i += CHUNK) {
  for (const w of vad.push(pcm.subarray(i, i + CHUNK))) {
    windows.push({ from: w.fromSample, to: w.toSample })
  }
}
console.log(`VAD: ${windows.length} speech windows\n`)

// 2. Transcribe sequentially (offline — nothing is dropped)
const whisper = new WhisperSupervisor(tier, () => {})
await whisper.start()
const status = whisper.status()
if (status.health !== 'ok') {
  console.error(`whisper unavailable: ${status.message}`)
  process.exit(1)
}
await getEmbedder().ready()

interface Seg {
  t0: number
  t1: number
  text: string
}
const segments: Seg[] = []
interface SemanticProbe {
  t: number
  ref: string
  score: number
  fires: boolean
  snippet: string
}
const probes: SemanticProbe[] = []
const explicitHits: { t: number; ref: string; match: string }[] = []
let chapterCtx: ChapterContext | null = null
const seen = new Map<string, number>()

const started = Date.now()
for (let i = 0; i < windows.length; i++) {
  const w = windows[i]
  const text = await whisper.transcribe(pcm.subarray(w.from, w.to))
  if (!text) continue
  const t0 = w.from / SAMPLE_RATE
  const seg: Seg = { t0, t1: w.to / SAMPLE_RATE, text }
  segments.push(seg)
  console.log(`[${fmt(t0)}] ${text}`)

  // explicit references (production parser, carried chapter context)
  const parsed = parseRefs(text, chapterCtx)
  chapterCtx = lastContext(parsed, chapterCtx)
  for (const p of parsed) {
    if (p.chapterOnly) continue
    const key = refKey(p.ref)
    const wallT = t0 * 1000
    if ((seen.get(key) ?? -Infinity) > wallT - 30_000) continue
    seen.set(key, wallT)
    if (!getRefText('kjv', p.ref)) continue
    explicitHits.push({ t: t0, ref: formatRef(p.ref), match: p.matchText })
    console.log(`    ★ EXPLICIT ${formatRef(p.ref)}  ← "${p.matchText}"`)
  }

  // semantic probe on the 2-segment tail (production behavior, but reported at any score)
  const tail = segments
    .slice(-2)
    .map((s) => s.text)
    .join(' ')
  if (tail.split(/\s+/).length >= MIN_SEMANTIC_WORDS) {
    const top = (await semanticScan(tail, 'kjv', 1))[0]
    if (top) {
      const key = refKey(top.ref)
      const fires = top.score >= THRESHOLD && (seen.get(key) ?? -Infinity) <= t0 * 1000 - DEDUPE_MS
      if (fires) seen.set(key, t0 * 1000)
      probes.push({
        t: t0,
        ref: formatRef(top.ref),
        score: top.score,
        fires,
        snippet: tail.slice(-90),
      })
      if (top.score >= 0.5) {
        console.log(
          `    ${fires ? '★ SEMANTIC' : `· semantic ${top.score >= THRESHOLD ? '(deduped)' : 'below threshold'}`} ${formatRef(top.ref)} ${top.score.toFixed(3)}`,
        )
      }
    }
  }
}

whisper.stop()
const elapsed = (Date.now() - started) / 1000
const audioLen = pcm.length / SAMPLE_RATE

// 3. Tuning summary
console.log('\n========== SUMMARY ==========')
console.log(`processed ${fmt(audioLen)} of audio in ${fmt(elapsed)} (${(audioLen / elapsed).toFixed(1)}× realtime)`)
console.log(`transcript segments: ${segments.length}`)

console.log(`\nEXPLICIT REFERENCES (${explicitHits.length}):`)
for (const h of explicitHits) console.log(`  [${fmt(h.t)}] ${h.ref}  ← "${h.match}"`)

const fired = probes.filter((p) => p.fires)
console.log(`\nSEMANTIC DETECTIONS at ${THRESHOLD} (${fired.length}):`)
for (const p of fired) console.log(`  [${fmt(p.t)}] ${p.ref} ${p.score.toFixed(3)}`)

console.log('\nSCORE DISTRIBUTION (top semantic match per boundary):')
const buckets = [0.5, 0.55, 0.6, 0.62, 0.65, 0.7, 0.75]
for (let b = 0; b < buckets.length; b++) {
  const lo = buckets[b]
  const hi = buckets[b + 1] ?? 1
  const inBucket = probes.filter((p) => p.score >= lo && p.score < hi)
  console.log(`  ${lo.toFixed(2)}–${hi.toFixed(2)}: ${'█'.repeat(Math.min(60, inBucket.length))} ${inBucket.length}`)
}
console.log(`  <0.50: ${probes.filter((p) => p.score < 0.5).length}`)

console.log('\nSTRONGEST MATCHES (tuning candidates):')
for (const p of [...probes].sort((a, b) => b.score - a.score).slice(0, 12)) {
  console.log(`  ${p.score.toFixed(3)} [${fmt(p.t)}] ${p.ref}${p.fires ? ' (fired)' : ''}\n        …${p.snippet}`)
}

await getEmbedder().terminate()
process.exit(0)
