/**
 * worker_thread that owns the sentence-embedding model
 * (all-MiniLM-L6-v2, quantized ONNX). Heavy work stays off the main loop.
 *
 * In: { id, texts: string[] }
 * Out: { id, dims, buffer: ArrayBuffer } (transferred) | { id, error }
 */
import { parentPort, workerData } from 'node:worker_threads'
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'

const { cacheDir, modelId } = workerData as { cacheDir: string; modelId: string }

// Offline-only (PRD §10: zero network after install). The model is bundled at
// `<cacheDir>/<modelId>/...` and loaded as a local model — transformers never
// contacts HuggingFace, so a packaged app (and CI) needs no network for it.
env.cacheDir = cacheDir
env.localModelPath = cacheDir
env.allowLocalModels = true
env.allowRemoteModels = false

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

function getExtractor(): Promise<FeatureExtractionPipeline> {
  // cast: the pipeline() overload union is too complex for tsc to fold
  extractorPromise ??= (pipeline as any)('feature-extraction', modelId, {
    dtype: 'q8',
  }) as Promise<FeatureExtractionPipeline>
  return extractorPromise
}

parentPort!.on('message', async (msg: { id: number; texts: string[] }) => {
  try {
    const extractor = await getExtractor()
    const output = await extractor(msg.texts, { pooling: 'mean', normalize: true })
    const data = output.data as Float32Array
    const dims = output.dims[output.dims.length - 1]
    // Copy into a transferable buffer (tensor memory may be pooled)
    const buffer = data.slice().buffer
    parentPort!.postMessage({ id: msg.id, dims, buffer }, [buffer])
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: String(err) })
  }
})

// Begin loading the model immediately so the first query doesn't pay the cost.
getExtractor()
  .then(() => parentPort!.postMessage({ ready: true }))
  .catch((err) => parentPort!.postMessage({ ready: false, error: String(err) }))
