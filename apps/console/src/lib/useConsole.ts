/**
 * The console's connection to the server: typed messages over /ws-console,
 * binary audio frames, reconnect with state recovery (TDD §6.3).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppState,
  AsrStatus,
  ConsoleToServer,
  ImportProgress,
  SearchResult,
  ServerToConsole,
  TranscriptSegment,
  VersificationReport,
} from '@versecast/shared'

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

export interface ConsoleConnection {
  connected: boolean
  state: AppState | null
  asr: AsrStatus | null
  transcript: TranscriptSegment[]
  latestMatchText: string | null
  searchResults: { query: string; items: SearchResult[]; reference: SearchResult | null } | null
  importProgress: ImportProgress | null
  toasts: Toast[]
  send: (msg: ConsoleToServer) => void
  sendAudio: (pcm: ArrayBuffer) => void
  runSearch: (text: string) => void
  clearSearch: () => void
  dismissToast: (id: number) => void
  importFile: (file: File) => Promise<void>
}

let toastSeq = 1

export function useConsole(): ConsoleConnection {
  const [connected, setConnected] = useState(false)
  const [state, setState] = useState<AppState | null>(null)
  const [asr, setAsr] = useState<AsrStatus | null>(null)
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([])
  const [latestMatchText, setLatestMatchText] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<ConsoleConnection['searchResults']>(null)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const searchIdRef = useRef(0)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = toastSeq++
    setToasts((t) => [...t, { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 5000)
  }, [])

  useEffect(() => {
    let closed = false
    let delay = 500
    let timer: ReturnType<typeof setTimeout>
    let ws: WebSocket

    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws-console`)
      wsRef.current = ws
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        setConnected(true)
        delay = 500
      }
      ws.onmessage = (e) => {
        let msg: ServerToConsole
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        switch (msg.type) {
          case 'state.snapshot':
            setState(msg.state)
            break
          case 'transcript.segment':
            setTranscript((t) => [...t.slice(-19), msg.segment])
            break
          case 'detection.new':
            setLatestMatchText(msg.detection.matchText)
            break
          case 'asr.status':
            setAsr(msg.status)
            break
          case 'search.results':
            if (msg.id === searchIdRef.current) {
              setSearchResults({ query: msg.query, items: msg.items, reference: msg.reference })
            }
            break
          case 'import.progress':
            setImportProgress(msg.progress.phase === 'done' ? null : msg.progress)
            break
          case 'import.complete': {
            setImportProgress(null)
            const issues = (msg.report as VersificationReport).issues.length
            pushToast(
              'success',
              issues
                ? `Bible imported. ${issues} versification note${issues === 1 ? '' : 's'} — see the translation menu.`
                : 'Bible imported and indexed.',
            )
            break
          }
          case 'import.error':
            setImportProgress(null)
            pushToast('error', msg.message)
            break
        }
      }
      ws.onclose = () => {
        setConnected(false)
        wsRef.current = null
        if (closed) return
        timer = setTimeout(connect, delay)
        delay = Math.min(delay * 1.6, 5000)
      }
      ws.onerror = () => ws.close()
    }

    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [pushToast])

  const send = useCallback((msg: ConsoleToServer) => {
    const ws = wsRef.current
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  const sendAudio = useCallback((pcm: ArrayBuffer) => {
    const ws = wsRef.current
    if (ws && ws.readyState === ws.OPEN) ws.send(pcm)
  }, [])

  const runSearch = useCallback(
    (text: string) => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
      if (!text.trim()) {
        setSearchResults(null)
        return
      }
      searchDebounceRef.current = setTimeout(() => {
        const id = ++searchIdRef.current
        send({ type: 'search.query', id, text })
      }, 220)
    },
    [send],
  )

  const clearSearch = useCallback(() => {
    searchIdRef.current++
    setSearchResults(null)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const importFile = useCallback(
    async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      try {
        const res = await fetch('/api/import', { method: 'POST', body: form })
        if (!res.ok) throw new Error(`Upload failed (${res.status})`)
        pushToast('info', `Importing ${file.name}…`)
      } catch (err) {
        pushToast('error', err instanceof Error ? err.message : String(err))
      }
    },
    [pushToast],
  )

  return {
    connected,
    state,
    asr,
    transcript,
    latestMatchText,
    searchResults,
    importProgress,
    toasts,
    send,
    sendAudio,
    runSearch,
    clearSearch,
    dismissToast,
    importFile,
  }
}
