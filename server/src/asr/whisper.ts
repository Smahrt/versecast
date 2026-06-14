/**
 * whisper.cpp supervisor (TDD §4.3). Runs whisper-server as a long-lived
 * child process (loads the model once), transcribes via local HTTP.
 * Crash or >10 s hang → kill, respawn, resume. All on 127.0.0.1.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import type { AsrStatus, ModelTier } from '@versecast/shared'
import { findWhisperServer, modelPath, PORTS } from '../config.js'

const INFERENCE_TIMEOUT_MS = 10_000
const RESPAWN_DELAY_MS = 1_000
const ALL_TIERS: ModelTier[] = ['tiny.en', 'base.en', 'small.en']

export class WhisperSupervisor {
  private child: ChildProcess | null = null
  private desired = false
  private tier: ModelTier
  private health: AsrStatus['health'] = 'stopped'
  private message: string | undefined
  private respawnTimer: NodeJS.Timeout | null = null
  private startPromise: Promise<void> | null = null
  /** Transcriptions that took longer than their window, for auto-tier fallback */
  private slowCount = 0

  constructor(
    tier: ModelTier,
    private onStatus: (status: AsrStatus) => void,
  ) {
    this.tier = tier
  }

  status(): AsrStatus {
    return {
      running: this.desired,
      modelTier: this.tier,
      health: this.health,
      message: this.message,
      tiersAvailable: ALL_TIERS.filter((t) => existsSync(modelPath(t))),
    }
  }

  private setHealth(health: AsrStatus['health'], message?: string): void {
    this.health = health
    this.message = message
    this.onStatus(this.status())
  }

  async start(): Promise<void> {
    this.desired = true
    if (this.child) return
    this.startPromise ??= this.spawnChild()
    await this.startPromise
  }

  stop(): void {
    this.desired = false
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    this.respawnTimer = null
    this.killChild()
    this.setHealth('stopped')
  }

  async setTier(tier: ModelTier): Promise<void> {
    if (tier === this.tier) return
    this.tier = tier
    if (this.desired) {
      // Changing the model restarts only the child process (TDD §4.3)
      this.killChild()
      this.startPromise = this.spawnChild()
      await this.startPromise
    } else {
      this.onStatus(this.status())
    }
  }

  private killChild(): void {
    if (this.child) {
      this.child.removeAllListeners()
      this.child.kill('SIGKILL')
      this.child = null
    }
    this.startPromise = null
  }

  private async spawnChild(): Promise<void> {
    const bin = findWhisperServer()
    if (!bin) {
      this.setHealth(
        'unavailable',
        'whisper-server binary not found. Install whisper.cpp (e.g. `brew install whisper-cpp`) or set VERSECAST_WHISPER_BIN.',
      )
      this.startPromise = null
      return
    }
    const model = modelPath(this.tier)
    if (!existsSync(model)) {
      this.setHealth(
        'unavailable',
        `Speech model not found at ${model}. Place ggml-${this.tier}.bin in resources/models.`,
      )
      this.startPromise = null
      return
    }

    this.setHealth('starting')
    const threads = Math.max(2, Math.min(4, os.cpus().length - 2))
    const child = spawn(
      bin,
      ['-m', model, '--host', '127.0.0.1', '--port', String(PORTS.whisper), '-t', String(threads)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    this.child = child

    let stderrTail = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000)
    })

    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      this.startPromise = null
      if (this.desired) {
        this.setHealth('restarting', `recognizer exited (code ${code}) — restarting`)
        this.respawnTimer = setTimeout(() => {
          this.startPromise = this.spawnChild()
        }, RESPAWN_DELAY_MS)
      }
    })

    // Wait for the HTTP endpoint to come up (model load can take a few seconds)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (this.child !== child) return // killed meanwhile
      try {
        await fetch(`http://127.0.0.1:${PORTS.whisper}/`, { signal: AbortSignal.timeout(1000) })
        this.setHealth('ok')
        return
      } catch {
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    this.setHealth('restarting', `recognizer did not come up: ${stderrTail.slice(-200)}`)
    this.killChild()
    if (this.desired) this.startPromise = this.spawnChild()
  }

  /**
   * Transcribe a 16 kHz mono PCM16 window. Returns trimmed text.
   * On timeout, restarts the child (supervision rule) and returns ''.
   */
  async transcribe(pcm: Int16Array): Promise<string> {
    if (!this.child || this.health !== 'ok') return ''
    const windowMs = (pcm.length / 16000) * 1000
    const started = Date.now()
    try {
      const form = new FormData()
      form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'audio.wav')
      form.append('response_format', 'json')
      form.append('temperature', '0')
      const res = await fetch(`http://127.0.0.1:${PORTS.whisper}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`whisper-server ${res.status}`)
      const data = (await res.json()) as { text?: string }

      // Auto-fallback: transcription slower than realtime twice in a row → drop a tier (TDD §14)
      if (Date.now() - started > windowMs) {
        this.slowCount++
        if (this.slowCount >= 2 && this.tier !== 'tiny.en' && existsSync(modelPath('tiny.en'))) {
          this.slowCount = 0
          this.setTier('tiny.en')
          this.message = 'recognizer fell behind — switched to tiny.en'
        }
      } else {
        this.slowCount = 0
      }

      return cleanWhisperText(data.text ?? '')
    } catch {
      this.setHealth('restarting', 'recognizer stalled — restarting')
      this.killChild()
      if (this.desired) this.startPromise = this.spawnChild()
      return ''
    }
  }
}

/** Strip whisper artifacts: bracketed events, repeated blank tokens. */
function cleanWhisperText(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [BLANK_AUDIO], (music)
    .replace(/\s+/g, ' ')
    .trim()
}

function pcmToWav(pcm: Int16Array): ArrayBuffer {
  const sampleRate = 16000
  const dataLen = pcm.length * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)
  new Int16Array(buf, 44).set(pcm)
  return buf
}
