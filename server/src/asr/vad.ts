/**
 * Energy-based voice activity detection (TDD §4.2).
 * Emits transcription windows on either:
 *  (a) ~0.6 s of silence after speech, or
 *  (b) a 7 s cap during continuous speech.
 */

const FRAME_MS = 20
const SILENCE_BOUNDARY_MS = 600
const MAX_WINDOW_MS = 7000
const PRE_ROLL_MS = 300 // context before speech onset
const MIN_SPEECH_MS = 350 // ignore blips shorter than this

export interface VadWindow {
  /** Absolute sample positions into the ring buffer's monotonic clock */
  fromSample: number
  toSample: number
}

export class Vad {
  private frameSize: number
  private pending: number[] = []
  private noiseFloor = 80 // adaptive RMS noise estimate, int16 scale
  private inSpeech = false
  private speechStartSample = 0
  private lastSpeechSample = 0
  private speechFrames = 0
  private processedSamples = 0

  constructor(private sampleRate: number) {
    this.frameSize = (sampleRate * FRAME_MS) / 1000
  }

  /** Feed PCM; returns zero or more completed speech windows. */
  push(samples: Int16Array): VadWindow[] {
    const windows: VadWindow[] = []
    for (let i = 0; i < samples.length; i++) {
      this.pending.push(samples[i])
      if (this.pending.length >= this.frameSize) {
        const w = this.processFrame()
        if (w) windows.push(w)
        this.pending = []
      }
    }
    return windows
  }

  private processFrame(): VadWindow | null {
    const frame = this.pending
    let sumSq = 0
    for (const s of frame) sumSq += s * s
    const rms = Math.sqrt(sumSq / frame.length)
    this.processedSamples += frame.length
    const now = this.processedSamples

    // Track the noise floor on quiet frames (slow rise, fast fall)
    if (rms < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05
    } else {
      this.noiseFloor = Math.min(this.noiseFloor * 1.002, 600)
    }
    this.noiseFloor = Math.max(this.noiseFloor, 40)

    const isSpeech = rms > Math.max(this.noiseFloor * 3, 250)
    const ms = (n: number) => (n / this.sampleRate) * 1000

    if (isSpeech) {
      if (!this.inSpeech) {
        this.inSpeech = true
        this.speechStartSample = Math.max(0, now - frame.length - (this.sampleRate * PRE_ROLL_MS) / 1000)
        this.speechFrames = 0
      }
      this.speechFrames++
      this.lastSpeechSample = now

      if (ms(now - this.speechStartSample) >= MAX_WINDOW_MS) {
        const w = { fromSample: this.speechStartSample, toSample: now }
        this.speechStartSample = now // continue listening seamlessly
        this.speechFrames = 0
        return w
      }
      return null
    }

    if (this.inSpeech && ms(now - this.lastSpeechSample) >= SILENCE_BOUNDARY_MS) {
      this.inSpeech = false
      const speechMs = this.speechFrames * FRAME_MS
      if (speechMs < MIN_SPEECH_MS) return null // a blip, not speech
      return { fromSample: this.speechStartSample, toSample: this.lastSpeechSample }
    }
    return null
  }

  reset(): void {
    this.pending = []
    this.inSpeech = false
    this.processedSamples = 0
    this.speechFrames = 0
  }

  /** Sample clock — equals total samples pushed through. */
  get clock(): number {
    return this.processedSamples
  }
}
