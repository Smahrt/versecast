/**
 * AudioWorklet processor (TDD §4.1): downsample the mic to 16 kHz mono
 * 16-bit PCM and post ~250 ms chunks, plus a level reading for the meter.
 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.targetRate = 16000
    this.chunkSamples = 4000 // 250 ms at 16 kHz
    this.buffer = new Int16Array(this.chunkSamples)
    this.filled = 0
    this.readPos = 0 // fractional read position into incoming stream
    this.levelAcc = 0
    this.levelCount = 0
    this.lastLevelPost = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const channel = input[0]
    const ratio = sampleRate / this.targetRate

    // linear-interpolation downsample
    while (this.readPos < channel.length - 1) {
      const i = Math.floor(this.readPos)
      const frac = this.readPos - i
      const sample = channel[i] * (1 - frac) + channel[i + 1] * frac
      const clamped = Math.max(-1, Math.min(1, sample))
      this.buffer[this.filled++] = (clamped * 0x7fff) | 0
      this.levelAcc += clamped * clamped
      this.levelCount++
      this.readPos += ratio

      if (this.filled === this.chunkSamples) {
        const out = this.buffer.slice()
        this.port.postMessage({ type: 'chunk', pcm: out.buffer }, [out.buffer])
        this.filled = 0
      }
    }
    this.readPos -= channel.length

    // level ~10×/s
    if (currentTime - this.lastLevelPost > 0.1 && this.levelCount > 0) {
      const rms = Math.sqrt(this.levelAcc / this.levelCount)
      this.port.postMessage({ type: 'level', rms })
      this.levelAcc = 0
      this.levelCount = 0
      this.lastLevelPost = currentTime
    }
    return true
  }
}

registerProcessor('pcm-processor', PcmProcessor)
