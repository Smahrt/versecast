/**
 * Import pipeline orchestration (TDD §8): parse → normalize → versify →
 * validate & write → index, each phase reporting progress to the console.
 */
import type { ServerToConsole } from '@versecast/shared'
import { parseBibleXml, ImportError } from './formats.js'
import { versify } from './versification.js'
import { insertTranslation, deleteTranslation, listTranslations } from '../db/index.js'
import { indexTranslation } from '../search/indexer.js'
import { invalidateIndex } from '../search/engine.js'
import type { Store } from '../state/store.js'

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'bible'
  )
}

function deriveAbbrev(name: string): string {
  const caps = name.match(/[A-Z]/g)
  if (caps && caps.length >= 2 && caps.length <= 6) return caps.join('')
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 5)
}

/** Runs async; progress and completion stream over the console WS. */
export function runImport(
  xml: string,
  filename: string,
  store: Store,
  broadcast: (msg: ServerToConsole) => void,
): void {
  void (async () => {
    let translationId = ''
    try {
      const progress = (phase: 'parse' | 'normalize' | 'versify' | 'write' | 'index' | 'done', pct: number, message?: string) =>
        broadcast({ type: 'import.progress', progress: { translationId, phase, pct, message } })

      progress('parse', 5, 'Reading file…')
      const parsed = parseBibleXml(xml, filename)
      if (!parsed.verses.length) throw new ImportError('The file parsed but contained no verses.')

      const name = parsed.name?.trim() || filename.replace(/\.[^.]+$/, '')
      const existing = new Set(listTranslations().map((t) => t.id))
      let id = `user-${slugify(name)}`
      for (let i = 2; existing.has(id); i++) id = `user-${slugify(name)}-${i}`
      translationId = id

      progress('versify', 40, 'Normalizing to KJV versification…')
      const { verses, report } = versify(parsed.verses, parsed.notes)
      if (!verses.length) throw new ImportError('No verses survived versification — the file may be malformed.')

      progress('write', 55, 'Writing to the library…')
      insertTranslation(
        {
          id,
          name,
          abbrev: (parsed.abbrev?.trim() || deriveAbbrev(name)).toUpperCase(),
          source: parsed.format,
        },
        verses,
        report,
      )
      store.refreshCatalogs()

      progress('index', 60, 'Building the semantic index…')
      try {
        await indexTranslation(id, (pct) => progress('index', 60 + Math.round(pct * 0.4)))
        invalidateIndex(id)
      } catch (err) {
        // Reference lookup still works; semantic search shows as pending (TDD §8.5)
        broadcast({
          type: 'import.progress',
          progress: {
            translationId: id,
            phase: 'index',
            pct: 100,
            message: `Indexing failed — semantic search pending. ${err instanceof Error ? err.message : err}`,
          },
        })
      }
      store.refreshCatalogs()

      progress('done', 100)
      broadcast({ type: 'import.complete', translationId: id, report })
    } catch (err) {
      // Never leave a half-imported bible behind (PRD §5.5)
      if (translationId) {
        try {
          deleteTranslation(translationId)
          store.refreshCatalogs()
        } catch {
          /* cleanup is best-effort */
        }
      }
      const message =
        err instanceof ImportError
          ? err.message
          : `Import failed unexpectedly: ${err instanceof Error ? err.message : err}`
      broadcast({ type: 'import.error', message })
    }
  })()
}
