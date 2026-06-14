/**
 * Verse detection over the rolling transcript (TDD §5.1–5.2).
 * Explicit references parse on every segment; the semantic matcher runs
 * on VAD sentence boundaries against the active translation's vectors.
 */
import { randomUUID } from 'node:crypto'
import {
  formatRef,
  refKey,
  type Detection,
  type ScoreBand,
  type TranscriptSegment,
} from '@versecast/shared'
import { parseRefs, lastContext, type ChapterContext } from '../search/refParser.js'
import { semanticScan, hasIndex } from '../search/engine.js'
import { contextAround, getRefText } from '../db/index.js'

const DEDUPE_WINDOW_MS = 3 * 60 * 1000
const EXPLICIT_DEDUPE_MS = 30 * 1000
const MIN_SEMANTIC_WORDS = 6
const SEMANTIC_TAIL_SEGMENTS = 2

export interface DetectorOptions {
  translationId: () => string
  threshold: () => number
  onDetection: (d: Detection) => void
}

function band(score: number): ScoreBand {
  if (score >= 0.72) return 3
  if (score >= 0.66) return 2
  return 1
}

export class Detector {
  private context: ChapterContext | null = null
  private recentKeys = new Map<string, number>() // refKey → detectedAt
  private segments: TranscriptSegment[] = []
  private semanticBusy = false

  constructor(private opts: DetectorOptions) {}

  reset(): void {
    this.context = null
    this.segments = []
  }

  /** Feed a new transcript segment; fires detections via callback. */
  async onSegment(segment: TranscriptSegment): Promise<void> {
    this.segments.push(segment)
    if (this.segments.length > 20) this.segments.shift()

    this.runExplicit(segment)
    await this.runSemantic()
  }

  private dedupe(key: string, windowMs: number): boolean {
    const now = Date.now()
    for (const [k, t] of this.recentKeys) if (now - t > DEDUPE_WINDOW_MS) this.recentKeys.delete(k)
    const last = this.recentKeys.get(key)
    return last !== undefined && now - last < windowMs
  }

  private runExplicit(segment: TranscriptSegment): void {
    const translationId = this.opts.translationId()
    const parsed = parseRefs(segment.text, this.context)
    this.context = lastContext(parsed, this.context)

    for (const p of parsed) {
      if (p.chapterOnly) continue
      const key = refKey(p.ref)
      if (this.dedupe(key, EXPLICIT_DEDUPE_MS)) continue
      const text = getRefText(translationId, p.ref)
      if (!text) continue
      this.recentKeys.set(key, Date.now())
      this.opts.onDetection({
        id: randomUUID(),
        ref: p.ref,
        refString: formatRef(p.ref),
        snippet: text,
        score: 1,
        band: 3,
        source: 'reference',
        matchText: p.matchText,
        detectedAt: Date.now(),
        translationId,
        ...contextAround(translationId, p.ref),
      })
    }
  }

  private async runSemantic(): Promise<void> {
    if (this.semanticBusy) return // debounce: never queue scans behind each other
    const translationId = this.opts.translationId()
    if (!hasIndex(translationId)) return

    const tail = this.segments.slice(-SEMANTIC_TAIL_SEGMENTS)
    const text = tail
      .map((s) => s.text)
      .join(' ')
      .trim()
    if (text.split(/\s+/).length < MIN_SEMANTIC_WORDS) return

    this.semanticBusy = true
    try {
      const matches = await semanticScan(text, translationId, 1)
      const top = matches[0]
      if (!top || top.score < this.opts.threshold()) return
      const key = refKey(top.ref)
      if (this.dedupe(key, DEDUPE_WINDOW_MS)) return
      const verseText = getRefText(translationId, top.ref)
      if (!verseText) return
      this.recentKeys.set(key, Date.now())
      this.opts.onDetection({
        id: randomUUID(),
        ref: top.ref,
        refString: formatRef(top.ref),
        snippet: verseText,
        score: top.score,
        band: band(top.score),
        source: 'semantic',
        matchText: tail[tail.length - 1]?.text ?? text,
        detectedAt: Date.now(),
        translationId,
        ...contextAround(translationId, top.ref),
      })
    } finally {
      this.semanticBusy = false
    }
  }
}
