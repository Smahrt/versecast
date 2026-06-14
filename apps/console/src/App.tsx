import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueueItem, Ref } from '@versecast/shared'
import { useConsole } from './lib/useConsole.ts'
import { listMics, startCapture, type MicCapture } from './lib/audio.ts'
import { Header } from './components/Header.tsx'
import { Feed, SearchBar } from './components/Feed.tsx'
import { OnScreenNow, UpNext } from './components/RightRail.tsx'
import { Ticker } from './components/Ticker.tsx'
import { Toasts } from './components/Toasts.tsx'

export default function App() {
  const conn = useConsole()
  const { state, send } = conn

  const [searchText, setSearchText] = useState('')
  const [listening, setListening] = useState(false)
  const [level, setLevel] = useState(0)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [micPermission, setMicPermission] = useState<'granted' | 'prompt' | 'denied'>('prompt')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const captureRef = useRef<MicCapture | null>(null)
  const sendAudioRef = useRef(conn.sendAudio)
  sendAudioRef.current = conn.sendAudio

  // ---------- search ----------
  const onSearchChange = (v: string) => {
    setSearchText(v)
    conn.runSearch(v)
  }

  // Switching translations refreshes open search results in the new
  // translation (detections are re-resolved server-side; live is untouched).
  const activeTranslationId = state?.settings.activeTranslationId
  useEffect(() => {
    if (searchText.trim()) conn.runSearch(searchText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTranslationId])
  const clearSearch = useCallback(() => {
    setSearchText('')
    conn.clearSearch()
    searchInputRef.current?.blur()
  }, [conn])

  // ---------- presenting ----------
  const present = useCallback(
    (ref: Ref) => send({ type: 'present.verse', ref }),
    [send],
  )
  const queueAdd = useCallback((ref: Ref) => send({ type: 'queue.add', ref }), [send])
  const presentFromQueue = useCallback(
    (item: QueueItem) =>
      send({ type: 'present.verse', ref: item.ref, translationId: item.translationId, queueItemId: item.id }),
    [send],
  )
  const toggleBlank = useCallback(() => {
    if (state) send({ type: 'present.blank', on: !state.live.blanked })
  }, [send, state])

  // ---------- microphone ----------
  const stopListening = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    setListening(false)
    setLevel(0)
    send({ type: 'asr.stop' })
  }, [send])

  const startListening = useCallback(async () => {
    if (captureRef.current) return
    try {
      const capture = await startCapture(
        state?.settings.micDeviceId ?? null,
        (pcm) => sendAudioRef.current(pcm),
        (rms) => setLevel(rms),
      )
      captureRef.current = capture
      setListening(true)
      send({ type: 'asr.start' })
      // labels become available only after permission is granted
      setMics(await listMics())
    } catch (err) {
      console.error('mic failed', err)
      setListening(false)
    }
  }, [send, state?.settings.micDeviceId])

  const selectMic = useCallback(
    (deviceId: string) => {
      // Pre-permission, Chrome lists one placeholder device with an empty id —
      // never persist that as a selection.
      if (!deviceId) return
      send({ type: 'settings.update', settings: { micDeviceId: deviceId } })
      // restart capture on the new device if currently listening
      if (captureRef.current) {
        captureRef.current.stop()
        captureRef.current = null
        void startCapture(
          deviceId,
          (pcm) => sendAudioRef.current(pcm),
          (rms) => setLevel(rms),
        ).then((c) => {
          captureRef.current = c
        })
      }
    },
    [send],
  )

  useEffect(() => {
    const refresh = () => void listMics().then(setMics)
    refresh()
    // labels appear once permission is granted; devices come and go (USB mics)
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
      captureRef.current?.stop()
    }
  }, [])

  // Track mic permission so the ticker can offer a grant button before
  // any device list is meaningful (labels are blank until granted).
  useEffect(() => {
    let status: PermissionStatus | null = null
    let cancelled = false
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((s) => {
        if (cancelled) return
        status = s
        const sync = () => {
          setMicPermission(s.state === 'granted' ? 'granted' : s.state === 'denied' ? 'denied' : 'prompt')
          void listMics().then(setMics)
        }
        sync()
        s.onchange = sync
      })
      .catch(() => {
        // Permissions API unavailable — infer from whether labels are visible
        void listMics().then((m) => setMicPermission(m.some((d) => d.label) ? 'granted' : 'prompt'))
      })
    return () => {
      cancelled = true
      if (status) status.onchange = null
    }
  }, [])

  const requestMicAccess = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop()) // just the permission, no capture yet
      setMicPermission('granted')
      setMics(await listMics())
    } catch {
      setMicPermission('denied')
    }
  }, [])

  // ---------- keyboard (Enter present · B blank · →/← slides · ⌘/Ctrl+→/← verses) ----------
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent)
    const onKey = (e: KeyboardEvent) => {
      const inInput = (e.target as HTMLElement)?.tagName === 'INPUT'
      if (e.key === '/' && !inInput) {
        e.preventDefault()
        searchInputRef.current?.focus()
        return
      }
      const mod = isMac ? e.metaKey : e.ctrlKey
      // ⌘/Ctrl + arrows step to the previous/next verse (works even in the search box)
      if (mod && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault()
        send({ type: 'present.step', dir: e.key === 'ArrowRight' ? 1 : -1 })
        return
      }
      if (inInput) return
      if (e.key === 'Enter') {
        const top = conn.searchResults?.items[0] ?? state?.recentDetections[0]
        if (top) present(top.ref)
      } else if (e.key === 'b' || e.key === 'B') {
        toggleBlank()
      } else if (e.key === 'ArrowRight') {
        send({ type: 'present.slide', dir: 1 })
      } else if (e.key === 'ArrowLeft') {
        send({ type: 'present.slide', dir: -1 })
      } else if (e.key === 'Escape') {
        clearSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [conn.searchResults, state, present, toggleBlank, send, clearSearch])

  // Enter inside the search box presents the top result
  const onSearchEnter = () => {
    const top = conn.searchResults?.items[0]
    if (top) {
      present(top.ref)
      clearSearch()
    }
  }

  if (!state) {
    return (
      <div className="flex h-screen items-center justify-center text-[14px] text-dim">
        {conn.connected ? 'Loading…' : 'Connecting to the VerseCast server…'}
      </div>
    )
  }

  return (
    <div className="flex h-screen min-w-[1360px] flex-col overflow-hidden">
      <Header
        state={state}
        asr={conn.asr}
        importProgress={conn.importProgress}
        onTranslation={(id) => send({ type: 'settings.update', settings: { activeTranslationId: id } })}
        onTheme={(id) => send({ type: 'theme.set', themeId: id })}
        onBlank={toggleBlank}
        onImport={(file) => void conn.importFile(file)}
        onUpdateSettings={(settings) => send({ type: 'settings.update', settings })}
      />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_424px] gap-4 p-4 pb-0">
        <div className="flex min-h-0 min-w-0 flex-col gap-4">
          <SearchBar
            value={searchText}
            onChange={onSearchChange}
            onEnter={onSearchEnter}
            onEscape={clearSearch}
            inputRef={searchInputRef}
          />
          <Feed
            state={state}
            searchResults={conn.searchResults}
            onPresent={present}
            onQueue={queueAdd}
            onClearDetections={() => send({ type: 'detections.clear' })}
          />
        </div>

        <div className="flex min-h-0 flex-col gap-4">
          <OnScreenNow
            state={state}
            onBlank={toggleBlank}
            onSlide={(dir) => send({ type: 'present.slide', dir })}
            onStep={(dir) => send({ type: 'present.step', dir })}
          />
          <UpNext
            queue={state.queue}
            onPresent={presentFromQueue}
            onRemove={(id) => send({ type: 'queue.remove', id })}
            onReorder={(id, toIndex) => send({ type: 'queue.reorder', id, toIndex })}
            onClear={() => send({ type: 'queue.clear' })}
          />
        </div>
      </div>

      <Ticker
        asr={conn.asr}
        listening={listening}
        transcript={conn.transcript}
        matchText={conn.latestMatchText}
        level={level}
        mics={mics}
        selectedMic={state.settings.micDeviceId}
        micPermission={micPermission}
        onSelectMic={selectMic}
        onRequestAccess={() => void requestMicAccess()}
        onToggle={() => (listening ? stopListening() : void startListening())}
      />

      <Toasts toasts={conn.toasts} onDismiss={conn.dismissToast} />

      {!conn.connected && (
        <div className="fixed inset-x-0 top-0 z-50 flex justify-center">
          <div className="vc-pulse mt-2 rounded-full border border-live/40 bg-[#1d1412] px-4 py-1.5 text-[12.5px] font-semibold text-live-soft">
            Reconnecting…
          </div>
        </div>
      )}
    </div>
  )
}
