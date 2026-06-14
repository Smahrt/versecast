/**
 * The server owns the truth (TDD §1.2, §6.1). Single in-memory state object,
 * snapshot to disk on every mutation (debounced 500 ms).
 */
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  formatRef,
  splitIntoSlides,
  refsEqual,
  stepVerse,
  type AppState,
  type Detection,
  type OutputState,
  type Ref,
  type Settings,
} from '@versecast/shared'
import { PATHS } from '../config.js'
import { contextAround, getRefText, listTranslations } from '../db/index.js'
import { listThemes } from '../themes.js'

const SNAPSHOT_DEBOUNCE_MS = 500
const MAX_DETECTIONS = 25

const DEFAULT_SETTINGS: Settings = {
  micDeviceId: null,
  modelTier: 'base.en',
  lanOutput: false,
  activeTranslationId: 'kjv',
  semanticThreshold: 0.62,
  showContext: false,
  autoPresent: false,
}

function defaultState(): AppState {
  return {
    live: {
      ref: null,
      refString: null,
      slides: [],
      slideIndex: 0,
      translationId: 'kjv',
      translationAbbrev: 'KJV',
      themeId: 'dark-elegant',
      blanked: false,
      presentedAt: null,
    },
    queue: [],
    recentDetections: [],
    settings: { ...DEFAULT_SETTINGS },
    translations: [],
    themes: [],
    outputPort: 3001,
    lanAddress: null,
  }
}

export class Store extends EventEmitter {
  state: AppState
  private snapshotTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    this.state = this.loadSnapshot()
    this.refreshCatalogs()
  }

  /** Reload translations + themes lists (after imports or theme changes). */
  refreshCatalogs(): void {
    this.state.translations = listTranslations()
    this.state.themes = listThemes()
    this.changed()
  }

  private loadSnapshot(): AppState {
    const base = defaultState()
    try {
      if (existsSync(PATHS.stateFile)) {
        const saved = JSON.parse(readFileSync(PATHS.stateFile, 'utf8')) as Partial<AppState>
        const state: AppState = {
          ...base,
          ...saved,
          settings: { ...base.settings, ...saved.settings },
          // catalogs are rebuilt at boot; never trust them from disk
          translations: [],
          themes: [],
        }
        // '' is the browser's pre-permission placeholder device, not a selection
        if (!state.settings.micDeviceId) state.settings.micDeviceId = null
        return state
      }
    } catch {
      // torn snapshot — start clean rather than refuse to boot
    }
    return base
  }

  private changed(): void {
    this.emit('change', this.state)
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(() => this.writeSnapshot(), SNAPSHOT_DEBOUNCE_MS)
  }

  private writeSnapshot(): void {
    try {
      mkdirSync(path.dirname(PATHS.stateFile), { recursive: true })
      const tmp = `${PATHS.stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, PATHS.stateFile)
    } catch (err) {
      console.error('state snapshot failed:', err)
    }
  }

  outputState(): OutputState {
    const { live } = this.state
    return {
      blanked: live.blanked,
      themeId: live.themeId,
      verse:
        live.ref && live.refString
          ? {
              refString: live.refString,
              translationAbbrev: live.translationAbbrev,
              slides: live.slides,
              slideIndex: live.slideIndex,
            }
          : null,
    }
  }

  // ---------- mutations ----------

  addDetection(d: Detection): void {
    this.state.recentDetections.unshift(d)
    if (this.state.recentDetections.length > MAX_DETECTIONS) this.state.recentDetections.length = MAX_DETECTIONS
    this.changed()
  }

  present(ref: Ref, translationId?: string, queueItemId?: string): boolean {
    const tid = translationId ?? this.state.settings.activeTranslationId
    const text = getRefText(tid, ref)
    if (!text) return false
    const translation = this.state.translations.find((t) => t.id === tid)
    this.state.live = {
      ...this.state.live,
      ref,
      refString: formatRef(ref),
      slides: splitIntoSlides(text),
      slideIndex: 0,
      translationId: tid,
      translationAbbrev: translation?.abbrev ?? tid.toUpperCase(),
      blanked: false,
      presentedAt: Date.now(),
    }
    if (queueItemId) this.state.queue = this.state.queue.filter((q) => q.id !== queueItemId)
    this.changed()
    return true
  }

  blank(on: boolean): void {
    this.state.live.blanked = on
    this.changed()
  }

  slide(dir: 1 | -1): void {
    const { live } = this.state
    const next = live.slideIndex + dir
    if (next < 0 || next >= live.slides.length) return
    live.slideIndex = next
    this.changed()
  }

  /** Present the previous/next verse, skipping any the active translation lacks. */
  step(dir: 1 | -1): boolean {
    const { live } = this.state
    if (!live.ref) return false
    let target = stepVerse(live.ref, dir)
    for (let guard = 0; target && guard < 400; guard++) {
      if (getRefText(live.translationId, target)) {
        return this.present(target, live.translationId)
      }
      target = stepVerse(target, dir) // skip gaps (partial bibles)
    }
    return false
  }

  setTheme(themeId: string): void {
    if (!this.state.themes.some((t) => t.id === themeId)) return
    this.state.live.themeId = themeId
    this.changed()
  }

  queueAdd(ref: Ref, translationId?: string): void {
    const tid = translationId ?? this.state.settings.activeTranslationId
    const text = getRefText(tid, ref)
    if (!text) return
    // Don't double-queue the same ref
    if (this.state.queue.some((q) => refsEqual(q.ref, ref) && q.translationId === tid)) return
    this.state.queue.push({
      id: randomUUID(),
      ref,
      refString: formatRef(ref),
      snippet: text.length > 80 ? `${text.slice(0, 77)}…` : text,
      translationId: tid,
      addedAt: Date.now(),
    })
    this.changed()
  }

  queueRemove(id: string): void {
    this.state.queue = this.state.queue.filter((q) => q.id !== id)
    this.changed()
  }

  queueReorder(id: string, toIndex: number): void {
    const from = this.state.queue.findIndex((q) => q.id === id)
    if (from === -1) return
    const [item] = this.state.queue.splice(from, 1)
    this.state.queue.splice(Math.max(0, Math.min(toIndex, this.state.queue.length)), 0, item)
    this.changed()
  }

  queueClear(): void {
    this.state.queue = []
    this.changed()
  }

  clearDetections(): void {
    this.state.recentDetections = []
    this.changed()
  }

  updateSettings(patch: Partial<Settings>): void {
    if (patch.micDeviceId === '') patch = { ...patch, micDeviceId: null }
    const prevTranslation = this.state.settings.activeTranslationId
    this.state.settings = { ...this.state.settings, ...patch }
    const tid = this.state.settings.activeTranslationId
    if (tid !== prevTranslation) {
      // Re-resolve detections into the new translation. A verse missing there
      // (partial bible) keeps its original text and translation tag. The live
      // verse is deliberately untouched until something is presented again.
      this.state.recentDetections = this.state.recentDetections.map((d) => {
        const text = getRefText(tid, d.ref)
        return text ? { ...d, snippet: text, translationId: tid, ...contextAround(tid, d.ref) } : d
      })
    }
    this.changed()
  }
}
