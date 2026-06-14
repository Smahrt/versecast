import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Repo/app root. In a packaged build this is set by the Electron main process. */
export const ROOT = process.env.VERSECAST_ROOT ?? path.resolve(here, '../..')

export const PATHS = {
  root: ROOT,
  db: path.join(ROOT, 'resources/kjv.db'),
  models: path.join(ROOT, 'resources/models'),
  hfCache: path.join(ROOT, 'resources/models/hf-cache'),
  embeddings: path.join(ROOT, 'resources/embeddings'),
  themes: path.join(ROOT, 'themes'),
  consoleDist: path.join(ROOT, 'apps/console/dist'),
  outputDist: path.join(ROOT, 'apps/output/dist'),
  data: path.join(ROOT, 'data'),
  stateFile: path.join(ROOT, 'data/state.json'),
}

/**
 * Defaults per PRD: console :3000, output :3001.
 * A generic PORT env (dev preview harnesses) maps to the console port —
 * or to the output port when launched with --preview-output.
 */
function resolvePorts(): { console: number; output: number; whisper: number } {
  const whisper = Number(process.env.VERSECAST_WHISPER_PORT ?? 8178)
  if (process.env.VERSECAST_CONSOLE_PORT || process.env.VERSECAST_OUTPUT_PORT) {
    return {
      console: Number(process.env.VERSECAST_CONSOLE_PORT ?? 3000),
      output: Number(process.env.VERSECAST_OUTPUT_PORT ?? 3001),
      whisper,
    }
  }
  if (process.env.PORT) {
    const p = Number(process.env.PORT)
    return process.argv.includes('--preview-output')
      ? { console: p + 1, output: p, whisper }
      : { console: p, output: p + 1, whisper }
  }
  return { console: 3000, output: 3001, whisper }
}

export const PORTS = resolvePorts()

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIMS = 384

/** Locate the whisper-server binary (configurable, then PATH conventions). */
export function findWhisperServer(): string | null {
  const candidates = [
    process.env.VERSECAST_WHISPER_BIN,
    '/opt/homebrew/bin/whisper-server',
    '/usr/local/bin/whisper-server',
    path.join(ROOT, 'resources/bin/whisper-server'),
    path.join(ROOT, 'resources/bin/whisper-server.exe'),
  ].filter(Boolean) as string[]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

export function modelPath(tier: string): string {
  return path.join(PATHS.models, `ggml-${tier}.bin`)
}
