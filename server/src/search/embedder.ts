/**
 * Main-thread client for the embedding worker.
 */
import { Worker } from 'node:worker_threads'
import { EMBEDDING_MODEL, PATHS } from '../config.js'

interface Pending {
  resolve: (vectors: Float32Array) => void
  reject: (err: Error) => void
}

export class Embedder {
  private worker: Worker
  private pending = new Map<number, Pending>()
  private nextId = 1
  private readyPromise: Promise<void>

  constructor() {
    // Dev runs the TS source via tsx; the Electron bundle ships a compiled
    // embedWorker.mjs next to the server bundle.
    const fromTsSource = import.meta.url.endsWith('.ts')
    const workerUrl = fromTsSource
      ? new URL('./embedWorker.ts', import.meta.url)
      : new URL('./embedWorker.mjs', import.meta.url)
    this.worker = new Worker(workerUrl, {
      workerData: { cacheDir: PATHS.hfCache, modelId: EMBEDDING_MODEL },
      ...(fromTsSource ? { execArgv: ['--import', 'tsx'] } : {}),
    })

    let readyResolve: () => void, readyReject: (e: Error) => void
    this.readyPromise = new Promise<void>((res, rej) => {
      readyResolve = res
      readyReject = rej
    })

    this.worker.on('message', (msg: any) => {
      if ('ready' in msg) {
        if (msg.ready) readyResolve()
        else readyReject(new Error(msg.error ?? 'embedding model failed to load'))
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(new Float32Array(msg.buffer))
    })

    this.worker.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
  }

  /** Resolves once the model is loaded (first call may download to local cache). */
  ready(): Promise<void> {
    return this.readyPromise
  }

  /** Embed texts; returns row-major [texts.length × dims] normalized vectors. */
  embed(texts: string[]): Promise<Float32Array> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, texts })
    })
  }

  async embedOne(text: string): Promise<Float32Array> {
    return this.embed([text])
  }

  terminate(): Promise<number> {
    return this.worker.terminate()
  }
}

let shared: Embedder | null = null
export function getEmbedder(): Embedder {
  shared ??= new Embedder()
  return shared
}
