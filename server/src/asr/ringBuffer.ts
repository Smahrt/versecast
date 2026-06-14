/**
 * Fixed-size PCM16 ring buffer holding the last ~30s of mic audio (TDD §4.2).
 */
export class PcmRingBuffer {
  private buf: Int16Array
  private writePos = 0
  /** Total samples ever written — monotonic clock in samples */
  private total = 0

  constructor(
    public readonly sampleRate: number,
    seconds: number,
  ) {
    this.buf = new Int16Array(sampleRate * seconds)
  }

  write(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.writePos] = samples[i]
      this.writePos = (this.writePos + 1) % this.buf.length
    }
    this.total += samples.length
  }

  get totalSamples(): number {
    return this.total
  }

  /**
   * Read [fromSample, toSample) in absolute sample positions.
   * Returns silence-padded data for any portion that has been overwritten.
   */
  read(fromSample: number, toSample: number): Int16Array {
    const len = toSample - fromSample
    const out = new Int16Array(len)
    const oldest = Math.max(0, this.total - this.buf.length)
    for (let i = 0; i < len; i++) {
      const abs = fromSample + i
      if (abs < oldest || abs >= this.total) continue // stays 0
      out[i] = this.buf[abs % this.buf.length]
    }
    return out
  }

  reset(): void {
    this.writePos = 0
    this.total = 0
    this.buf.fill(0)
  }
}
