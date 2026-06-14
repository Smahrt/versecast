import { useEffect, useState } from 'react'
import type { AsrStatus, TranscriptSegment } from '@versecast/shared'
import { Dropdown } from './Dropdown.tsx'

function LevelBars({ level, active }: { level: number; active: boolean }) {
  // five bars with different sensitivities, like the design's meter
  const heights = [7, 13, 16, 10, 6]
  const thresholds = [0.02, 0.05, 0.09, 0.14, 0.2]
  return (
    <div className="flex h-4 flex-none items-end gap-0.5">
      {heights.map((h, i) => {
        const lit = active && level > thresholds[i]
        return (
          <div
            key={i}
            className="w-[3px] rounded-[2px] transition-colors duration-100"
            style={{
              height: h,
              background: lit ? '#A5C694' : active ? 'rgba(165,198,148,0.25)' : 'rgba(255,255,255,0.10)',
            }}
          />
        )
      })}
    </div>
  )
}

function Highlighted({ text, match }: { text: string; match: string | null }) {
  if (!match) return <>{text}</>
  const idx = text.toLowerCase().indexOf(match.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span className="rounded bg-sage/[0.12] px-1 py-px text-sage-soft">
        {text.slice(idx, idx + match.length)}
      </span>
      {text.slice(idx + match.length)}
    </>
  )
}

export function Ticker({
  asr,
  listening,
  transcript,
  matchText,
  level,
  mics,
  selectedMic,
  micPermission,
  onSelectMic,
  onRequestAccess,
  onToggle,
}: {
  asr: AsrStatus | null
  listening: boolean
  transcript: TranscriptSegment[]
  matchText: string | null
  level: number
  mics: MediaDeviceInfo[]
  selectedMic: string | null
  micPermission: 'granted' | 'prompt' | 'denied'
  onSelectMic: (id: string) => void
  onRequestAccess: () => void
  onToggle: () => void
}) {
  const [decayed, setDecayed] = useState(0)
  useEffect(() => {
    setDecayed(level)
    const t = setTimeout(() => setDecayed(0), 220)
    return () => clearTimeout(t)
  }, [level])

  const last = transcript[transcript.length - 1]
  const restarting = asr?.health === 'restarting' || asr?.health === 'starting'
  const unavailable = asr?.health === 'unavailable'

  const micItems = mics.length
    ? mics.map((m, i) => ({ id: m.deviceId, label: m.label || `Microphone ${i + 1}` }))
    : [{ id: '', label: 'Default microphone' }]

  // A stored device may be gone (or be the pre-permission '' placeholder) —
  // fall back to the first real device so the trigger never renders empty.
  const selectedValid =
    selectedMic && micItems.some((m) => m.id === selectedMic) ? selectedMic : (micItems[0]?.id ?? '')

  return (
    <div className="m-4 flex h-[72px] flex-none items-center gap-4 rounded-[18px] border border-white/[0.06] bg-panel px-6">
      <div className="flex flex-none items-center gap-2.5">
        <span className={`h-2 w-2 rounded-full ${listening ? 'bg-sage vc-pulse' : 'bg-white/[0.15]'}`} />
        <LevelBars level={decayed} active={listening} />
      </div>

      <div className="min-w-0 flex-1 truncate text-[15px] text-[#B3B2A9]">
        {unavailable ? (
          <span className="text-live-soft">{asr?.message}</span>
        ) : restarting ? (
          <span className="vc-pulse text-dim">restarting recognizer…</span>
        ) : last ? (
          <>
            …<Highlighted text={last.text} match={matchText} />
            {listening && <span className="vc-cursor" />}
          </>
        ) : listening ? (
          <span className="text-dim">
            Listening — the live transcript appears here
            <span className="vc-cursor" />
          </span>
        ) : (
          <span className="text-dim">Press Start listening and the live transcript appears here</span>
        )}
      </div>

      <div className="flex flex-none items-center gap-2.5">
        {micPermission === 'granted' ? (
          <Dropdown
            value={selectedValid}
            items={micItems}
            onSelect={onSelectMic}
            align="right"
            direction="up"
          />
        ) : micPermission === 'denied' ? (
          <div className="flex h-10 items-center rounded-[11px] border border-live/35 px-4 text-[12.5px] text-live-soft">
            Mic blocked
          </div>
        ) : (
          <button
            onClick={onRequestAccess}
            className="flex h-10 cursor-pointer items-center gap-2 rounded-[11px] border border-sage/35 px-4 text-[13px] font-semibold text-sage-soft hover:bg-sage/10"
          >
            🎙 Allow mic access
          </button>
        )}
        <button
          onClick={onToggle}
          disabled={(unavailable || micPermission === 'denied') && !listening}
          className={`flex h-10 cursor-pointer items-center gap-2 rounded-[11px] border px-[18px] text-[13.5px] font-semibold ${
            listening
              ? 'border-live/35 text-live-soft hover:bg-live/10'
              : unavailable || micPermission === 'denied'
                ? 'cursor-not-allowed border-white/[0.08] text-faint'
                : 'border-sage/35 text-sage-soft hover:bg-sage/10'
          }`}
        >
          {listening ? (
            <>
              <span className="h-2 w-2 rounded-[2px] bg-live" />
              Stop listening
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-sage" />
              Start listening
            </>
          )}
        </button>
      </div>
    </div>
  )
}
