/**
 * Audio path (TDD §2): WS binary frames → ring buffer → VAD windows →
 * whisper.cpp → transcript segments → detector.
 */
import { randomUUID } from 'node:crypto'
import type { AsrStatus, ModelTier, TranscriptSegment } from '@versecast/shared'
import { PcmRingBuffer } from './ringBuffer.js'
import { Vad, type VadWindow } from './vad.js'
import { WhisperSupervisor } from './whisper.js'

const SAMPLE_RATE = 16000
const RING_SECONDS = 30
const TRANSCRIPT_KEEP_MS = 90_000

export interface AsrPipelineOptions {
  modelTier: ModelTier
  onSegment: (segment: TranscriptSegment) => void
  onStatus: (status: AsrStatus) => void
}

export class AsrPipeline {
  private ring = new PcmRingBuffer(SAMPLE_RATE, RING_SECONDS)
  private vad = new Vad(SAMPLE_RATE)
  private whisper: WhisperSupervisor
  private queue: VadWindow[] = []
  private draining = false
  private listening = false
  private startedAt = 0
  private transcript: TranscriptSegment[] = []

  constructor(private opts: AsrPipelineOptions) {
    this.whisper = new WhisperSupervisor(opts.modelTier, opts.onStatus)
  }

  status(): AsrStatus {
    return this.whisper.status()
  }

  get rollingTranscript(): TranscriptSegment[] {
    return this.transcript
  }

  async start(): Promise<void> {
    if (this.listening) return
    this.listening = true
    this.startedAt = Date.now()
    this.ring.reset()
    this.vad.reset()
    this.queue = []
    await this.whisper.start()
  }

  stop(): void {
    this.listening = false
    this.queue = []
    this.whisper.stop()
  }

  setTier(tier: ModelTier): Promise<void> {
    return this.whisper.setTier(tier)
  }

  /** Binary WS frame of 16 kHz mono PCM16 from the console. */
  pushAudio(chunk: Buffer): void {
    if (!this.listening) return
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
    this.ring.write(samples)
    const windows = this.vad.push(samples)
    if (windows.length) {
      this.queue.push(...windows)
      // If transcription fell behind, keep only the freshest windows
      if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3)
      void this.drain()
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && this.listening) {
        const w = this.queue.shift()!
        const pcm = this.ring.read(w.fromSample, w.toSample)
        const text = await this.whisper.transcribe(pcm)
        if (!text) continue
        const segment: TranscriptSegment = {
          id: randomUUID(),
          text,
          t0: w.fromSample / SAMPLE_RATE,
          t1: w.toSample / SAMPLE_RATE,
        }
        this.transcript.push(segment)
        const cutoff = (Date.now() - this.startedAt - TRANSCRIPT_KEEP_MS) / 1000
        while (this.transcript.length && this.transcript[0].t1 < cutoff) this.transcript.shift()
        this.opts.onSegment(segment)
      }
    } finally {
      this.draining = false
    }
  }
}
