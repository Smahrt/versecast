/**
 * Embed every verse of a translation into embeddings/<id>.bin.
 * Used by the build script (bundled KJV) and the import pipeline (phase 5).
 */
import path from 'node:path'
import { allVerses } from '../db/index.js'
import { getEmbedder } from './embedder.js'
import { VectorIndex } from './vectorIndex.js'
import { EMBEDDING_MODEL, EMBEDDING_DIMS, PATHS } from '../config.js'

const BATCH_SIZE = 64

export async function indexTranslation(
  translationId: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const verses = allVerses(translationId)
  if (!verses.length) throw new Error(`No verses for translation '${translationId}'`)

  const embedder = getEmbedder()
  await embedder.ready()

  const refs = new Uint16Array(verses.length * 3)
  const vectors = new Float32Array(verses.length * EMBEDDING_DIMS)

  for (let start = 0; start < verses.length; start += BATCH_SIZE) {
    if (signal?.aborted) throw new Error('Indexing cancelled')
    const batch = verses.slice(start, start + BATCH_SIZE)
    const out = await embedder.embed(batch.map((v) => v.text))
    vectors.set(out, start * EMBEDDING_DIMS)
    batch.forEach((v, i) => {
      const row = (start + i) * 3
      refs[row] = v.book
      refs[row + 1] = v.chapter
      refs[row + 2] = v.verse
    })
    onProgress?.(Math.min(99, Math.round(((start + batch.length) / verses.length) * 100)))
  }

  VectorIndex.save(
    indexPath(translationId),
    { count: verses.length, dims: EMBEDDING_DIMS, model: EMBEDDING_MODEL },
    refs,
    vectors,
  )
  onProgress?.(100)
}

export function indexPath(translationId: string): string {
  return path.join(PATHS.embeddings, `${translationId}.bin`)
}
