import {forwardRef} from 'react'
import type {AppState, Detection, Ref, SearchResult, VerseContext} from '@versecast/shared'
import {refsEqual} from '@versecast/shared'
import {timeAgo, useNow} from '../lib/format.ts'

/** Verse with one verse of surrounding context (toggled in settings). */
function ContextBlock({
                        before,
                        text,
                        after,
                      }: {
  before?: VerseContext | null
  text: string
  after?: VerseContext | null
}) {
  return (
    <div className="flex w-full flex-col gap-2 pt-1">
      {before && (
        <div className="font-serif text-[14px] leading-[1.55] text-dim">
          <span className="mr-2 font-sans text-[10.5px] font-semibold text-faint">
            {before.refString.split(':').pop()}
          </span>
          {before.text}
        </div>
      )}
      <div className="rounded-lg bg-sage/[0.07] px-2.5 py-1.5 font-serif text-[15.5px] leading-[1.55] text-soft">
        {text}
      </div>
      {after && (
        <div className="font-serif text-[14px] leading-[1.55] text-dim">
          <span className="mr-2 font-sans text-[10.5px] font-semibold text-faint">
            {after.refString.split(':').pop()}
          </span>
          {after.text}
        </div>
      )}
    </div>
  )
}

function ScoreDots({band, size = 8}: { band: 1 | 2 | 3; size?: number }) {
  return (
    <div className="flex items-center gap-[3px]">
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className="rounded-full"
          style={{
            width: size,
            height: size,
            background: i <= band ? '#A5C694' : 'rgba(165,198,148,0.25)',
          }}
        />
      ))}
    </div>
  )
}

function sourceBadge(d: Detection): { label: string; cls: string } {
  if (d.source === 'reference')
    return {label: 'Spoken reference', cls: 'text-sage bg-sage/12'}
  if (d.band === 1) return {label: 'Weak match', cls: 'text-[#84837B] bg-white/[0.05]'}
  return {label: 'Heard as a paraphrase', cls: 'text-[#9C9B92] bg-white/[0.06]'}
}

function TranslationTag({abbrev}: { abbrev: string }) {
  return (
    <div
      className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[11px] font-semibold tracking-[0.5px] text-dim uppercase">
      {abbrev}
    </div>
  )
}

export function SearchBar(props: {
  value: string
  onChange: (v: string) => void
  onEnter: () => void
  onEscape: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  return (
    <div
      className="flex h-[60px] flex-none items-center gap-3.5 rounded-[18px] border border-white/[0.08] bg-panel px-6 focus-within:border-sage/30">
      <span className="text-[32px] text-dim">⌕</span>
      <input
        ref={props.inputRef}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            props.onEnter()
          } else if (e.key === 'Escape') {
            props.onEscape()
          }
          e.stopPropagation()
        }}
        placeholder="Type a reference or describe the verse"
        className="h-full flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-dim"
      />
      <span className="rounded-[7px] border border-white/[0.09] px-2.5 py-1 text-[12px] text-ghost">/</span>
    </div>
  )
}

function PresentButtons({
                          primary,
                          onPresent,
                          onQueue,
                          compact,
                        }: {
  primary: boolean
  onPresent: () => void
  onQueue: () => void
  compact?: boolean
}) {
  if (compact) {
    return (
      <div className="flex items-center gap-2.5">
        <button
          onClick={onPresent}
          className="flex h-10 cursor-pointer items-center rounded-[11px] bg-sage/10 px-5 text-[14px] font-semibold text-sage-mut hover:bg-sage/[0.18]"
        >
          Present
        </button>
        <button
          onClick={onQueue}
          className="flex h-10 cursor-pointer items-center rounded-[11px] border border-white/10 px-4 text-[14px] font-semibold text-mut hover:border-white/[0.22]"
        >
          Queue
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-none flex-col gap-2.5">
      <button
        onClick={onPresent}
        className={`flex h-14 cursor-pointer items-center justify-center gap-2.5 rounded-[14px] px-9 text-[16.5px] font-bold ${
          primary
            ? 'bg-sage text-sage-ink hover:bg-[#B5D2A5]'
            : 'bg-sage/[0.14] text-sage-soft hover:bg-sage/[0.22]'
        }`}
      >
        Present {primary && <span>↵</span>}
      </button>
      <button
        onClick={onQueue}
        className="flex h-11 cursor-pointer items-center justify-center rounded-xl border border-white/[0.12] px-4 text-[14.5px] font-semibold text-soft hover:border-white/25"
      >
        Add to queue
      </button>
    </div>
  )
}

function DetectionCard({
                         detection,
                         index,
                         live,
                         translationAbbrev,
                         showContext,
                         onPresent,
                         onQueue,
                       }: {
  detection: Detection
  index: number
  live: Ref | null
  translationAbbrev: string
  showContext: boolean
  onPresent: () => void
  onQueue: () => void
}) {
  const now = useNow()
  const badge = sourceBadge(detection)
  const onScreen = refsEqual(detection.ref, live)
  const big = index < 2

  if (!big || detection.band === 1) {
    // compact row (weak matches are de-emphasized, never hidden — the operator decides)
    return (
      <div
        className={`vc-card-in flex items-center gap-3.5 rounded-[18px] border border-white/[0.045] bg-card px-6 py-4 ${detection.band === 1 ? 'opacity-[0.72] hover:opacity-100' : ''}`}
      >
        <div className={`text-[17px] font-semibold ${detection.band === 1 ? 'text-mut' : 'text-soft'}`}>
          {detection.refString}
        </div>
        <TranslationTag abbrev={translationAbbrev}/>
        <div className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${badge.cls}`}>{badge.label}</div>
        <ScoreDots band={detection.band} size={7}/>
        {onScreen && (
          <div className="rounded-full bg-white/[0.04] px-2.5 py-1 text-[12px] text-ghost">Live</div>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          <div className="text-[13px] text-faint">{timeAgo(detection.detectedAt, now)}</div>
          <PresentButtons compact primary={false} onPresent={onPresent} onQueue={onQueue}/>
        </div>
      </div>
    )
  }

  const newest = index === 0
  return (
    <div
      className={`vc-card-in flex items-center gap-7 rounded-[22px] px-[30px] py-6 ${
        newest ? 'border border-sage/35 bg-card-hot' : 'border border-white/[0.06] bg-panel2'
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-center gap-3.5">
          <div
            className={`font-semibold tracking-[-0.3px] ${newest ? 'text-[26px] text-ink' : 'text-[23px] text-ink2'}`}>
            {detection.refString}
          </div>
          <TranslationTag abbrev={translationAbbrev}/>
          <div className={`rounded-full px-3 py-[5px] text-[12px] font-semibold ${badge.cls}`}>{badge.label}</div>
          <ScoreDots band={detection.band}/>
          <div className="text-[13px] text-faint">{timeAgo(detection.detectedAt, now)}</div>
          {onScreen && (
            <div className="rounded-full bg-white/[0.04] px-2.5 py-1 text-[12px] text-ghost">Live</div>
          )}
        </div>
        {showContext && (detection.before || detection.after) ? (
          <ContextBlock before={detection.before} text={detection.snippet} after={detection.after}/>
        ) : (
          <div
            className={`line-clamp-2 max-w-[780px] font-serif leading-[1.6] ${newest ? 'text-[18px] text-soft' : 'text-[17px] text-[#B3B2A9]'}`}
          >
            {detection.snippet}
          </div>
        )}
      </div>
      <PresentButtons primary={newest} onPresent={onPresent} onQueue={onQueue}/>
    </div>
  )
}

function SearchResultCard({
                            result,
                            index,
                            translationAbbrev,
                            showContext,
                            onPresent,
                            onQueue,
                          }: {
  result: SearchResult
  index: number
  translationAbbrev: string
  showContext: boolean
  onPresent: () => void
  onQueue: () => void
}) {
  const first = index === 0
  const hasContext = result.before !== null || result.after !== null
  return (
    <div
      className={`vc-card-in flex items-center gap-7 rounded-[18px] px-6 py-4 ${
        first ? 'border border-sage/35 bg-card-hot' : 'border border-white/[0.05] bg-card'
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex w-full items-center gap-3">
          <div className={`font-semibold ${first ? 'text-[20px] text-ink' : 'text-[17px] text-soft'}`}>
            {result.refString}
          </div>
          <TranslationTag abbrev={translationAbbrev}/>
          {result.source === 'reference' ? (
            <div className="rounded-full bg-sage/[0.12] px-2.5 py-1 text-[12px] font-semibold text-sage">
              Reference
            </div>
          ) : (
            <div className="text-[12px] text-faint">{Math.round((result.score ?? 0) * 100)}% match</div>
          )}
        </div>
        {showContext && hasContext ? (
          <ContextBlock before={result.before} text={result.text} after={result.after}/>
        ) : (
          <div className="line-clamp-2 font-serif text-[15.5px] leading-[1.55] text-[#B3B2A9]">{result.text}</div>
        )}
      </div>
      <PresentButtons compact={!first} primary={first} onPresent={onPresent} onQueue={onQueue}/>
    </div>
  )
}

function ReferenceStrip({
                          result,
                          translationAbbrev,
                          onPresent,
                          onQueue,
                        }: {
  result: SearchResult
  translationAbbrev: string
  onPresent: () => void
  onQueue: () => void
}) {
  return (
    <div className="vc-card-in flex flex-none items-center gap-3 rounded-[14px] border border-sage/30 bg-sage/[0.06] px-4 py-2.5">
      <span className="rounded-full bg-sage/[0.14] px-2 py-0.5 text-[10.5px] font-bold tracking-[0.5px] text-sage uppercase">
        Reference
      </span>
      <button
        onClick={onPresent}
        title="Present this verse"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
      >
        <span className="flex-none text-[15px] font-semibold text-ink">{result.refString}</span>
        <TranslationTag abbrev={translationAbbrev}/>
        <span className="min-w-0 truncate font-serif text-[14px] text-[#B3B2A9]">{result.text}</span>
      </button>
      <button
        onClick={onPresent}
        className="flex h-8 flex-none cursor-pointer items-center rounded-[9px] bg-sage px-4 text-[13px] font-bold text-sage-ink hover:bg-[#B5D2A5]"
      >
        Present
      </button>
      <button
        onClick={onQueue}
        title="Add to queue"
        className="flex h-8 flex-none cursor-pointer items-center rounded-[9px] border border-white/12 px-3 text-[13px] font-semibold text-mut hover:border-white/22"
      >
        Queue
      </button>
    </div>
  )
}

export const Feed = forwardRef<HTMLDivElement, {
  state: AppState
  searchResults: { query: string; items: SearchResult[]; reference: SearchResult | null } | null
  onPresent: (ref: Ref) => void
  onQueue: (ref: Ref) => void
  onClearDetections: () => void
}>(function Feed({state, searchResults, onPresent, onQueue, onClearDetections}, ref) {
  const live = state.live.ref
  const showContext = state.settings.showContext
  const abbrevFor = (translationId: string) =>
    state.translations.find((t) => t.id === translationId)?.abbrev ?? translationId.toUpperCase()

  if (searchResults) {
    const searchAbbrev = abbrevFor(
      searchResults.items[0]?.translationId ?? state.settings.activeTranslationId,
    )
    return (
      <div ref={ref} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex flex-none items-center justify-between px-2">
          <div className="text-[12px] font-semibold tracking-[1.8px] text-label uppercase">
            Search — “{searchResults.query}” · {searchAbbrev}
          </div>
          <div className="text-[12.5px] text-faint">Esc to go back to detections</div>
        </div>
        {searchResults.reference && (
          <ReferenceStrip
            result={searchResults.reference}
            translationAbbrev={abbrevFor(searchResults.reference.translationId)}
            onPresent={() => onPresent(searchResults.reference!.ref)}
            onQueue={() => onQueue(searchResults.reference!.ref)}
          />
        )}
        {searchResults.items.length === 0 && !searchResults.reference && (
          <div className="px-2 py-8 text-center text-[14px] text-dim">No matches.</div>
        )}
        {searchResults.items.map((r, i) => (
          <SearchResultCard
            key={`${r.refString}-${i}`}
            result={r}
            index={i}
            translationAbbrev={abbrevFor(r.translationId)}
            showContext={showContext}
            onPresent={() => onPresent(r.ref)}
            onQueue={() => onQueue(r.ref)}
          />
        ))}
      </div>
    )
  }

  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      <div className="flex flex-none items-center justify-between px-2">
        <div className="text-[12px] font-semibold tracking-[1.8px] text-label uppercase">
          Detected from the sermon
        </div>
        <div className="flex items-center gap-4">
          {state.recentDetections.length > 0 && (
            <button
              onClick={onClearDetections}
              className="cursor-pointer text-[12.5px] text-faint hover:text-mut"
            >
              Clear all
            </button>
          )}
        </div>
      </div>
      {state.recentDetections.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="text-[15px] text-dim">No detections yet.</div>
          <div className="max-w-90 text-[13px] leading-relaxed text-faint">
            Start listening below and verses will appear here as the preacher speaks.
          </div>
        </div>
      )}
      {state.recentDetections.map((d, i) => (
        <DetectionCard
          key={d.id}
          detection={d}
          index={i}
          live={live}
          translationAbbrev={abbrevFor(d.translationId)}
          showContext={showContext}
          onPresent={() => onPresent(d.ref)}
          onQueue={() => onQueue(d.ref)}
        />
      ))}
    </div>
  )
})
