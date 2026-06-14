/**
 * Unified search facade (TDD §5.3). Semantic results always come back; if the
 * query also resolves to a scripture reference, that's returned separately so
 * the console can show a reference strip alongside the semantic matches.
 */
import { existsSync } from 'node:fs'
import { formatRef, type Ref, type SearchResult } from '@versecast/shared'
import { resolveReferenceQuery } from './refParser.js'
import { getEmbedder } from './embedder.js'
import { VectorIndex } from './vectorIndex.js'
import { indexPath } from './indexer.js'
import { contextAround, getRefText } from '../db/index.js'

const indexCache = new Map<string, VectorIndex>()

export function loadIndex(translationId: string): VectorIndex | null {
  const cached = indexCache.get(translationId)
  if (cached) return cached
  const file = indexPath(translationId)
  if (!existsSync(file)) return null
  const idx = VectorIndex.load(file)
  indexCache.set(translationId, idx)
  return idx
}

export function invalidateIndex(translationId: string): void {
  indexCache.delete(translationId)
}

export function hasIndex(translationId: string): boolean {
  return loadIndex(translationId) !== null
}

export async function semanticScan(
  text: string,
  translationId: string,
  topK: number,
): Promise<{ ref: Ref; score: number }[]> {
  const index = loadIndex(translationId)
  if (!index) return []
  const embedder = getEmbedder()
  await embedder.ready()
  const query = await embedder.embedOne(text)
  return index.scan(query, topK).map((r) => ({ ref: index.refAt(r.index), score: r.score }))
}

function refResult(ref: Ref, translationId: string): SearchResult | null {
  const verseText = getRefText(translationId, ref)
  if (!verseText) return null
  return {
    ref,
    refString: formatRef(ref),
    text: verseText,
    score: null,
    source: 'reference',
    translationId,
    ...contextAround(translationId, ref),
  }
}

export interface SearchResponse {
  items: SearchResult[]
  reference: SearchResult | null
}

export async function search(text: string, translationId: string): Promise<SearchResponse> {
  const trimmed = text.trim()
  if (!trimmed) return { items: [], reference: null }

  // Reference strip — a forgiving resolution of the typed query, if any
  const resolved = resolveReferenceQuery(trimmed)
  const reference = resolved ? refResult(resolved, translationId) : null

  // Semantic matches — always returned, shown below the strip
  const matches = await semanticScan(trimmed, translationId, 8)
  const items = matches
    .map((m): SearchResult | null => {
      const r = refResult(m.ref, translationId)
      return r ? { ...r, score: m.score, source: 'semantic' } : null
    })
    .filter((r): r is SearchResult => r !== null)

  return { items, reference }
}
