/**
 * Flat-file embedding index per TDD §7.2.
 * Layout: magic "VCEM" · u32 header length · JSON header {count, dims, model}
 *         · refs (count × 3 × u16: book, chapter, verse)
 *         · vectors (count × dims × f32)
 * Brute-force cosine scan — vectors are normalized so cosine == dot product.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import type { Ref } from '@versecast/shared'

const MAGIC = 0x4d454356 // "VCEM" little-endian

export interface IndexHeader {
  count: number
  dims: number
  model: string
}

export class VectorIndex {
  constructor(
    public readonly header: IndexHeader,
    /** count × 3 (book, chapter, verse) */
    public readonly refs: Uint16Array,
    /** count × dims, normalized */
    public readonly vectors: Float32Array,
  ) {}

  refAt(i: number): Ref {
    return { book: this.refs[i * 3], chapter: this.refs[i * 3 + 1], verse: this.refs[i * 3 + 2] }
  }

  /** Top-k most similar rows to a normalized query vector. */
  scan(query: Float32Array, topK: number): { index: number; score: number }[] {
    const { count, dims } = this.header
    const v = this.vectors
    const results: { index: number; score: number }[] = []
    let minTop = -Infinity

    for (let i = 0; i < count; i++) {
      let dot = 0
      const base = i * dims
      for (let d = 0; d < dims; d++) dot += v[base + d] * query[d]
      if (dot <= minTop && results.length >= topK) continue
      results.push({ index: i, score: dot })
      if (results.length > topK * 4) {
        results.sort((a, b) => b.score - a.score)
        results.length = topK
        minTop = results[results.length - 1].score
      }
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  static load(filePath: string): VectorIndex {
    const buf = readFileSync(filePath)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    if (view.getUint32(0, true) !== MAGIC) throw new Error(`${filePath}: not a VerseCast index`)
    const headerLen = view.getUint32(4, true)
    const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8')) as IndexHeader
    const refsOffset = 8 + headerLen
    const refsBytes = header.count * 3 * 2
    // Copy out of the file buffer so alignment is guaranteed
    const refs = new Uint16Array(header.count * 3)
    const vectors = new Float32Array(header.count * header.dims)
    refs.set(new Uint16Array(buf.buffer.slice(buf.byteOffset + refsOffset, buf.byteOffset + refsOffset + refsBytes)))
    const vecOffset = refsOffset + refsBytes
    vectors.set(
      new Float32Array(
        buf.buffer.slice(buf.byteOffset + vecOffset, buf.byteOffset + vecOffset + header.count * header.dims * 4),
      ),
    )
    return new VectorIndex(header, refs, vectors)
  }

  static save(filePath: string, header: IndexHeader, refs: Uint16Array, vectors: Float32Array): void {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const headerJson = Buffer.from(JSON.stringify(header), 'utf8')
    const out = Buffer.alloc(8 + headerJson.length + refs.byteLength + vectors.byteLength)
    out.writeUInt32LE(MAGIC, 0)
    out.writeUInt32LE(headerJson.length, 4)
    headerJson.copy(out, 8)
    Buffer.from(refs.buffer, refs.byteOffset, refs.byteLength).copy(out, 8 + headerJson.length)
    Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength).copy(
      out,
      8 + headerJson.length + refs.byteLength,
    )
    // Write atomically so a crash mid-index never leaves a torn file
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, out)
    renameSync(tmp, filePath)
  }
}
