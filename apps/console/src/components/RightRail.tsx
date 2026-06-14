import {useLayoutEffect, useRef, useState} from 'react'
import {formatRef, stepVerse, type AppState, type QueueItem} from '@versecast/shared'
import {clock, useNow} from '../lib/format.ts'

/** Render width for the embedded output before scaling down to the panel. */
const MONITOR_W = 1280
const MONITOR_H = 720

const IS_MAC =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent))
const MOD = IS_MAC ? '⌘' : 'Ctrl'

/**
 * A true monitor: the actual :3001 output page in a scaled-down iframe,
 * so every theme (incl. the green-screen lower third) mirrors exactly.
 */
function OutputMonitor({outputPort}: { outputPort: number }) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(396)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const ro = new ResizeObserver(() => setWidth(box.clientWidth))
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={boxRef}
      className="relative mx-3.5 aspect-video overflow-hidden rounded-xl border border-white/[0.05] bg-black"
    >
      <iframe
        src={`http://${location.hostname}:${outputPort}/`}
        title="Live output"
        className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
        style={{width: MONITOR_W, height: MONITOR_H, transform: `scale(${width / MONITOR_W})`}}
      />
    </div>
  )
}

export function OnScreenNow({
                              state,
                              onBlank,
                              onSlide,
                              onStep,
                            }: {
  state: AppState
  onBlank: () => void
  onSlide: (dir: 1 | -1) => void
  onStep: (dir: 1 | -1) => void
}) {
  const now = useNow()
  const {live} = state
  const hasVerse = live.ref !== null && !live.blanked
  const prevRef = live.ref ? stepVerse(live.ref, -1) : null
  const nextRef = live.ref ? stepVerse(live.ref, 1) : null

  return (
    <div className="flex-none overflow-hidden rounded-[20px] border border-live/30 bg-panel">
      <div className="flex items-center justify-between px-5 pt-4 pb-2.5">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full bg-live ${hasVerse ? 'vc-pulse' : ''}`}/>
          <div className="text-[12px] font-bold tracking-[1.6px] text-live-soft uppercase">Live</div>
        </div>
        <div className="text-[12px] text-faint tabular-nums">
          {live.presentedAt && hasVerse ? `${clock(now - live.presentedAt)} · ` : ''}
          {live.blanked ? 'blanked · ' : !live.ref ? 'nothing presented · ' : ''} Port :{state.outputPort}
        </div>
      </div>
      <OutputMonitor outputPort={state.outputPort}/>

      {/* Verse navigation — present the previous/next verse (⌘/Ctrl + ←/→) */}
      <div className="flex gap-2 px-3.5 pt-3">
        <button
          onClick={() => onStep(-1)}
          disabled={!live.ref || !prevRef}
          title={prevRef ? formatRef(prevRef) : undefined}
          className={`flex h-10 flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-white/10 text-[13px] font-semibold text-soft ${
            live.ref && prevRef ? 'cursor-pointer hover:border-white/22' : 'opacity-40'
          }`}
        >
          <span className="text-faint">←</span>
          {live.ref && prevRef ? formatRef(prevRef) : 'Prev verse'}
        </button>
        <button
          onClick={() => onStep(1)}
          disabled={!live.ref || !nextRef}
          title={nextRef ? formatRef(nextRef) : undefined}
          className={`flex h-10 flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-white/10 text-[13px] font-semibold text-soft ${
            live.ref && nextRef ? 'cursor-pointer hover:border-white/22' : 'opacity-40'
          }`}
        >
          {live.ref && nextRef ? formatRef(nextRef) : 'Next verse'}
          <span className="text-faint">→</span>
        </button>
      </div>
      <div className="px-3.5 pt-1 text-center text-[11px] text-faint">{MOD} + ← / → to change verse</div>

      <div className="flex gap-2 p-3.5 pt-3">
        <button
          onClick={onBlank}
          className="flex h-10 flex-1 cursor-pointer items-center justify-between pl-2 pr-1.5 rounded-[11px] border border-live/35 text-[13.5px] font-semibold text-live-soft hover:bg-live/10"
        >
          {live.blanked ? 'Show' : 'Blank'}
          <span className="rounded-[7px] border border-white/9 px-2.5 py-1 text-[12px] text-ghost">B</span>
        </button>
        <button
          onClick={() => onSlide(1)}
          disabled={live.slides.length <= 1}
          className={`flex h-10 flex-1 items-center justify-center rounded-[11px] border border-white/10 text-[13.5px] font-semibold text-mut ${
            live.slides.length > 1 ? 'cursor-pointer hover:border-white/22' : 'opacity-60'
          }`}
        >
          Slide {live.slides.length ? live.slideIndex + 1 : 1} / {Math.max(1, live.slides.length)}
          {live.slides.length > 1 && <span className="ml-1.5 text-faint">→</span>}
        </button>
      </div>
    </div>
  )
}

export function UpNext({
                         queue,
                         onPresent,
                         onRemove,
                         onReorder,
                         onClear,
                       }: {
  queue: QueueItem[]
  onPresent: (item: QueueItem) => void
  onRemove: (id: string) => void
  onReorder: (id: string, toIndex: number) => void
  onClear: () => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-white/[0.06] bg-panel">
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="text-[12px] font-semibold tracking-[1.6px] text-label uppercase">
          Up next · {queue.length}
        </div>
        {queue.length > 0 && (
          <button onClick={onClear} className="cursor-pointer text-[12.5px] text-faint hover:text-mut">
            Clear all
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pt-1 pb-3">
        {queue.length === 0 && (
          <div className="px-3 py-6 text-[12.5px] leading-relaxed text-faint">
            Queue verses from detections or search, then present them in order with ▶.
          </div>
        )}
        {queue.map((item, i) => (
          <div
            key={item.id}
            draggable
            onDragStart={() => setDragId(item.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId && dragId !== item.id) onReorder(dragId, i)
            }}
            className={`flex cursor-grab items-center gap-3 rounded-xl px-3 py-3 ${
              i === 0 ? 'bg-white/[0.025]' : ''
            } ${dragId === item.id ? 'opacity-40' : ''}`}
          >
            <div
              className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[7px] text-[11.5px] font-bold ${
                i === 0 ? 'bg-sage/[0.12] text-sage' : 'bg-white/[0.05] text-[#84837B]'
              }`}
            >
              {i + 1}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="text-[15px] font-semibold">{item.refString}</div>
              <div className="truncate text-[11.5px] text-dim">{item.snippet}</div>
            </div>
            <div className="ml-auto flex flex-none gap-1.5">
              <button
                onClick={() => onPresent(item)}
                title="Present"
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[10px] bg-sage/[0.12] text-[13px] text-sage hover:bg-sage/[0.22]"
              >
                ▶
              </button>
              <button
                onClick={() => onRemove(item.id)}
                title="Remove"
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[10px] border border-white/[0.07] text-[13px] text-faint hover:border-white/20"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
