import {useEffect, useRef, useState} from 'react'
import type {AppState, AsrStatus, ModelTier, Settings} from '@versecast/shared'

const TIERS: { id: ModelTier; name: string; hint: string }[] = [
  {id: 'tiny.en', name: 'Tiny', hint: 'Fastest · for older laptops'},
  {id: 'base.en', name: 'Base', hint: 'Balanced — recommended'},
  {id: 'small.en', name: 'Small', hint: 'Most accurate · needs a strong CPU'},
]

function SectionLabel({children}: { children: React.ReactNode }) {
  return (
    <div className="px-1 text-[11px] font-semibold tracking-[1.6px] text-label uppercase">{children}</div>
  )
}

export function SettingsPanel({
                                state,
                                asr,
                                onUpdate,
                              }: {
  state: AppState
  asr: AsrStatus | null
  onUpdate: (settings: Partial<Settings>) => void
}) {
  const [open, setOpen] = useState(false)
  const [threshold, setThreshold] = useState(state.settings.semanticThreshold)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const thresholdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // keep local slider in sync when another console changes it
  useEffect(() => setThreshold(state.settings.semanticThreshold), [state.settings.semanticThreshold])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const {settings, lanAddress, outputPort} = state
  const tiersAvailable = asr?.tiersAvailable ?? []

  const commitThreshold = (value: number) => {
    setThreshold(value)
    if (thresholdTimer.current) clearTimeout(thresholdTimer.current)
    thresholdTimer.current = setTimeout(() => onUpdate({semanticThreshold: value}), 300)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Settings"
        aria-label="Settings"
        className={`flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border text-[32px] ${
          open
            ? 'border-white/[0.18] bg-panel3 text-ink'
            : 'border-white/[0.07] bg-panel2 text-mut hover:border-white/[0.16]'
        }`}
      >
        ⚙
      </button>

      {open && (
        <div
          className="absolute top-12 right-0 z-50 flex w-86 flex-col gap-5 rounded-2xl border border-white/[0.08] bg-panel3 p-5 shadow-2xl shadow-black/60">
          {/* Speech model */}
          <div className="flex flex-col gap-2">
            <SectionLabel>Speech model</SectionLabel>
            <div className="flex flex-col gap-1">
              {TIERS.map((tier) => {
                const installed = tiersAvailable.includes(tier.id)
                const active = settings.modelTier === tier.id
                return (
                  <button
                    key={tier.id}
                    disabled={!installed}
                    onClick={() => installed && !active && onUpdate({modelTier: tier.id})}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left ${
                      installed ? 'cursor-pointer hover:bg-white/[0.05]' : 'opacity-45'
                    }`}
                  >
                    <span
                      className={`h-3.5 w-3.5 flex-none rounded-full border ${
                        active ? 'border-sage bg-sage' : 'border-white/25'
                      }`}
                    />
                    <span className="flex flex-col">
                      <span className={`text-[14px] font-medium ${active ? 'text-sage-soft' : 'text-soft'}`}>
                        {tier.name} <span className="text-[11.5px] text-faint">({tier.id})</span>
                      </span>
                      <span className="text-[11.5px] text-dim">
                        {installed ? tier.hint : `not installed — add ggml-${tier.id}.bin to resources/models`}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="px-1 text-[11.5px] text-faint">
              Switching restarts the recognizer (a few seconds).
            </div>
          </div>

          {/* Detection sensitivity */}
          <div className="flex flex-col gap-2">
            <SectionLabel>Detection sensitivity</SectionLabel>
            <div className="flex items-center gap-3 px-1">
              <input
                type="range"
                min={0.5}
                max={0.8}
                step={0.01}
                value={threshold}
                onChange={(e) => commitThreshold(Number(e.target.value))}
                className="flex-1"
                style={{accentColor: '#A5C694'}}
              />
              <div className="w-10 text-right text-[13px] font-semibold text-soft tabular-nums">
                {threshold.toFixed(2)}
              </div>
            </div>
            <div className="flex justify-between px-1 text-[11px] text-faint">
              <span>more suggestions</span>
              <span>only strong matches</span>
            </div>
            <button
              onClick={() => onUpdate({autoPresent: !settings.autoPresent})}
              className="mt-1 flex cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/[0.05]"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[14px] font-medium text-soft">Auto-present spoken references</span>
                <span className="text-[11.5px] text-dim">
                  {settings.autoPresent
                    ? 'Explicit references go on screen automatically'
                    : 'You confirm every verse before it shows'}
                </span>
              </span>
              <span
                className={`relative h-6 w-11 flex-none rounded-full transition-colors ${
                  settings.autoPresent ? 'bg-sage' : 'bg-white/[0.12]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#0D0D0C] transition-all ${
                    settings.autoPresent ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </span>
            </button>
          </div>

          {/* Display */}
          <div className="flex flex-col gap-2">
            <SectionLabel>Display</SectionLabel>
            <button
              onClick={() => onUpdate({showContext: !settings.showContext})}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/[0.05]"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[14px] font-medium text-soft">
                  Show surrounding verses
                </span>
              </span>
              <span
                className={`relative h-6 w-11 flex-none rounded-full transition-colors ${
                  settings.showContext ? 'bg-sage' : 'bg-white/[0.12]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#0D0D0C] transition-all ${
                    settings.showContext ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </span>
            </button>
          </div>

          {/* Network */}
          <div className="flex flex-col gap-2">
            <SectionLabel>Network</SectionLabel>
            <button
              onClick={() => onUpdate({lanOutput: !settings.lanOutput})}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/[0.05]"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[14px] font-medium text-soft">
                  Enable remote output
                </span>
                <span className="text-[11.5px] text-dim">
                  {settings.lanOutput
                    ? lanAddress
                      ? `Output visible at http://${lanAddress}:${outputPort}`
                      : 'Output visible on this network'
                    : 'Output is on this computer only'}
                </span>
              </span>
              <span
                className={`relative h-6 w-11 flex-none rounded-full transition-colors ${
                  settings.lanOutput ? 'bg-sage' : 'bg-white/[0.12]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#0D0D0C] transition-all ${
                    settings.lanOutput ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
