import {useRef} from 'react'
import type {AppState, AsrStatus, ImportProgress, Settings} from '@versecast/shared'
import {Dropdown} from './Dropdown.tsx'
import {SettingsPanel} from './SettingsPanel.tsx'

const IS_MAC =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent))

export function Header({
                         state,
                         asr,
                         importProgress,
                         onTranslation,
                         onTheme,
                         onBlank,
                         onImport,
                         onUpdateSettings,
                       }: {
  state: AppState
  asr: AsrStatus | null
  importProgress: ImportProgress | null
  onTranslation: (id: string) => void
  onTheme: (id: string) => void
  onBlank: () => void
  onImport: (file: File) => void
  onUpdateSettings: (settings: Partial<Settings>) => void
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const {live, settings, translations, themes} = state

  return (
    <header className="flex h-[68px] flex-none items-center gap-3.5 border-b border-white/[0.06] px-6">
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-gradient-to-br from-sage to-[#6E8F5E] font-serif text-[15px] font-bold text-sage-ink">
          V
        </div>
        <div className="text-[16.5px] font-semibold tracking-[-0.2px]">VerseCast</div>
      </div>

      <div className="h-6 w-px bg-white/[0.08]"/>

      <div className="flex gap-4 text-[12.5px] text-faint">
        <span>
          <b className="font-semibold text-[#84837B]">Enter</b> Present
        </span>
        <span>
          <b className="font-semibold text-[#84837B]">B</b> Blank
        </span>
        <span>
          <b className="font-semibold text-[#84837B]">→</b> Next slide
        </span>
        <span>
          <b className="font-semibold text-[#84837B]">{IS_MAC ? '⌘' : 'Ctrl'} →</b> Next verse
        </span>
      </div>

      <div className="flex-1"/>

      {importProgress && (
        <div
          className="flex h-10 items-center gap-2.5 rounded-full border border-sage/25 bg-sage/10 px-4 text-[13px] text-sage-soft">
          <span className="vc-pulse h-2 w-2 rounded-full bg-sage"/>
          Importing · {importProgress.phase} {importProgress.pct}%
        </div>
      )}

      <Dropdown
        value={settings.activeTranslationId}
        items={translations.map((t) => ({
          id: t.id,
          label: t.abbrev,
          hint: t.indexed ? undefined : 'semantic search pending',
        }))}
        onSelect={onTranslation}
        footer={
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full cursor-pointer px-4 py-2.5 text-left text-[13.5px] font-medium text-mut hover:bg-white/[0.05] hover:text-ink"
          >
            Import bible (XML)…
            <span className="mt-0.5 block text-[11px] text-faint">Zefania · OpenSong · OSIS</span>
          </button>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept=".xml,text/xml"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onImport(file)
          e.target.value = ''
        }}
      />

      <Dropdown
        value={live.themeId}
        items={themes.map((t) => ({id: t.id, label: t.name}))}
        onSelect={onTheme}
      />

      <SettingsPanel state={state} asr={asr} onUpdate={onUpdateSettings}/>

      <button
        onClick={onBlank}
        className={`flex h-10 cursor-pointer items-center justify-between rounded-full border px-5 pr-1 text-[14px] font-semibold ${
          live.blanked
            ? 'border-live/70 bg-live/15 text-live-soft'
            : 'border-live/40 text-live-soft hover:bg-live/10'
        }`}
      >
        {live.blanked ? 'Blanked' : 'Blank screen'}
        <span className={`rounded-full border border-white/9 px-2.5 py-1 text-[12px] text-ghost ml-2`}>B</span>
      </button>
    </header>
  )
}
