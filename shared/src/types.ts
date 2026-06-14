/** A verse reference, optionally a range within one chapter. */
export interface Ref {
  book: number // 1–66 canonical index
  chapter: number
  verse: number
  verseEnd?: number // inclusive, same chapter
}

export type DetectionSource = 'reference' | 'semantic'

/** 3 = strong ●●●, 2 = likely ●●○, 1 = weak ●○○ */
export type ScoreBand = 1 | 2 | 3

export interface Detection {
  id: string
  ref: Ref
  refString: string
  snippet: string
  score: number
  band: ScoreBand
  source: DetectionSource
  /** The transcript phrase that triggered this detection */
  matchText: string
  detectedAt: number // epoch ms
  translationId: string
  /** Surrounding verses, shown when the "show context" setting is on */
  before?: VerseContext | null
  after?: VerseContext | null
}

export interface QueueItem {
  id: string
  ref: Ref
  refString: string
  snippet: string
  translationId: string
  addedAt: number
}

export interface TranscriptSegment {
  id: string
  text: string
  t0: number // seconds since listening started
  t1: number
}

export interface TranslationInfo {
  id: string
  name: string
  abbrev: string
  source: 'bundled' | 'zefania' | 'opensong' | 'osis'
  indexed: boolean // semantic search ready
  versificationIssues: number
}

export interface ThemeInfo {
  id: string
  name: string
  transitionMs: number
}

export type ModelTier = 'tiny.en' | 'base.en' | 'small.en'

export interface Settings {
  micDeviceId: string | null
  modelTier: ModelTier
  /** false = localhost only, true = expose ONLY :3001 on the LAN */
  lanOutput: boolean
  activeTranslationId: string
  semanticThreshold: number
  /** Show one verse before/after on detections and search results */
  showContext: boolean
  /** Auto-present explicit spoken references from the sermon (off by default, PRD §5.2) */
  autoPresent: boolean
}

export interface LiveState {
  ref: Ref | null
  refString: string | null
  /** Verse text split into slides (~80 words each); single slide for most verses */
  slides: string[]
  slideIndex: number
  translationId: string
  translationAbbrev: string
  themeId: string
  blanked: boolean
  presentedAt: number | null
}

export interface AppState {
  live: LiveState
  queue: QueueItem[]
  recentDetections: Detection[] // newest first, capped at 25
  settings: Settings
  translations: TranslationInfo[]
  themes: ThemeInfo[]
  /** Port the live output page is served on (the console embeds it as a true monitor) */
  outputPort: number
  /** This machine's LAN IPv4, for the "view output from another device" hint */
  lanAddress: string | null
}

export interface AsrStatus {
  running: boolean
  modelTier: ModelTier
  health: 'ok' | 'starting' | 'restarting' | 'unavailable' | 'stopped'
  message?: string
  /** Tiers whose model file is present on disk */
  tiersAvailable: ModelTier[]
}

export interface VerseContext {
  refString: string
  text: string
}

export interface SearchResult {
  ref: Ref
  refString: string
  text: string
  score: number | null // null for direct reference lookups
  source: 'reference' | 'semantic'
  translationId: string
  /** One verse of surrounding context, shown when the operator expands a result */
  before: VerseContext | null
  after: VerseContext | null
}

export interface ImportProgress {
  translationId: string
  phase: 'parse' | 'normalize' | 'versify' | 'write' | 'index' | 'done' | 'error'
  pct: number
  message?: string
}

export interface VersificationReport {
  issues: { ref: string; note: string }[]
}

// ---------- WebSocket messages ----------

export type ConsoleToServer =
  | { type: 'asr.start' }
  | { type: 'asr.stop' }
  | { type: 'search.query'; id: number; text: string }
  | { type: 'queue.add'; ref: Ref; translationId?: string }
  | { type: 'queue.remove'; id: string }
  | { type: 'queue.reorder'; id: string; toIndex: number }
  | { type: 'queue.clear' }
  | { type: 'detections.clear' }
  | { type: 'present.verse'; ref: Ref; translationId?: string; queueItemId?: string }
  | { type: 'present.blank'; on: boolean }
  | { type: 'present.slide'; dir: 1 | -1 }
  | { type: 'present.step'; dir: 1 | -1 } // previous/next verse
  | { type: 'theme.set'; themeId: string }
  | { type: 'settings.update'; settings: Partial<Settings> }

export type ServerToConsole =
  | { type: 'state.snapshot'; state: AppState }
  | { type: 'transcript.segment'; segment: TranscriptSegment }
  | { type: 'detection.new'; detection: Detection }
  | { type: 'asr.status'; status: AsrStatus }
  | {
      type: 'search.results'
      id: number
      query: string
      items: SearchResult[]
      /** Direct scripture-reference resolution of the query, shown in a strip (null if the query isn't a reference) */
      reference: SearchResult | null
    }
  | { type: 'import.progress'; progress: ImportProgress }
  | { type: 'import.complete'; translationId: string; report: VersificationReport }
  | { type: 'import.error'; message: string }

export interface OutputState {
  blanked: boolean
  themeId: string
  verse: {
    refString: string
    translationAbbrev: string
    slides: string[]
    slideIndex: number
  } | null
}

export type ServerToOutput = { type: 'output.state'; output: OutputState }
