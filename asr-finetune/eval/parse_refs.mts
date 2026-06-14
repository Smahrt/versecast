/**
 * Bridge to VerseCast's production reference parser for the verse-detection
 * metric. Reads JSON lines {"text": ..., "sermon": ...} on stdin IN
 * CHRONOLOGICAL ORDER and emits {"refs": [...]} per line.
 *
 * Chapter context carries across lines within the same sermon — mirroring the
 * production detector, so bare "verse ten" clips resolve against the chapter
 * established by an earlier clip (e.g. "Isaiah chapter 41" … "verse ten").
 * Run from the versecast repo root:  npx tsx asr-finetune/eval/parse_refs.mts
 */
import { createInterface } from 'node:readline'
import { parseRefs, lastContext, type ChapterContext } from '../../server/src/search/refParser.js'
import { formatRef } from '@versecast/shared'

const contexts = new Map<string, ChapterContext | null>()

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const { text, sermon } = JSON.parse(line) as { text: string; sermon?: string }
  const key = sermon ?? '_'
  const parsed = parseRefs(text, contexts.get(key) ?? null)
  contexts.set(key, lastContext(parsed, contexts.get(key) ?? null))
  const refs = parsed.filter((r) => !r.chapterOnly).map((r) => formatRef(r.ref))
  process.stdout.write(JSON.stringify({ refs }) + '\n')
})
