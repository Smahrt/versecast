import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OutputState, ServerToOutput } from '@versecast/shared'

interface ThemeMeta {
  layout: 'centered' | 'lower-third'
  transitionMs: number
}

const FALLBACK_THEME: ThemeMeta = { layout: 'centered', transitionMs: 450 }

/** WS client with exponential backoff reconnect (0.5 s → 5 s cap, TDD §6.3). */
function useOutputState(): OutputState | null {
  const [output, setOutput] = useState<OutputState | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false
    let delay = 500
    let timer: ReturnType<typeof setTimeout>

    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws-output`)
      ws.onopen = () => {
        delay = 500
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as ServerToOutput
          if (msg.type === 'output.state') setOutput(msg.output)
        } catch {
          /* not for us */
        }
      }
      ws.onclose = () => {
        if (closed) return
        timer = setTimeout(connect, delay)
        delay = Math.min(delay * 1.6, 5000)
      }
      ws.onerror = () => ws?.close()
    }

    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [])

  return output
}

/** Load /themes/<id>/theme.css via a swapped <link>, and the theme meta. */
function useTheme(themeId: string): ThemeMeta {
  const [meta, setMeta] = useState<ThemeMeta>(FALLBACK_THEME)

  useEffect(() => {
    let link = document.getElementById('theme-css') as HTMLLinkElement | null
    if (!link) {
      link = document.createElement('link')
      link.id = 'theme-css'
      link.rel = 'stylesheet'
      document.head.appendChild(link)
    }
    link.href = `/themes/${themeId}/theme.css`

    let cancelled = false
    fetch(`/themes/${themeId}/theme.json`)
      .then((r) => r.json())
      .then((cfg) => {
        if (cancelled) return
        setMeta({
          layout: cfg.layout === 'lower-third' ? 'lower-third' : 'centered',
          transitionMs: cfg.transition?.ms ?? 450,
        })
      })
      .catch(() => setMeta(FALLBACK_THEME))
    return () => {
      cancelled = true
    }
  }, [themeId])

  return meta
}

/**
 * Auto-fit (TDD §9): scale verse text between min/max so it fills the safe
 * area; pagination is handled server-side, this only sizes the current slide.
 */
function useAutoFit(
  ref: React.RefObject<HTMLDivElement | null>,
  text: string,
  layout: ThemeMeta['layout'],
) {
  const [tick, setTick] = useState(0)

  // refit when the window resizes or fonts finish loading — the theme CSS
  // applies Lora late, so measurements with the fallback font must be redone
  useEffect(() => {
    const container = ref.current?.parentElement
    if (!container) return
    const refit = () => setTick((t) => t + 1)
    const ro = new ResizeObserver(refit)
    ro.observe(container)
    document.fonts?.ready.then(refit).catch(() => {})
    document.fonts?.addEventListener?.('loadingdone', refit)
    return () => {
      ro.disconnect()
      document.fonts?.removeEventListener?.('loadingdone', refit)
    }
  }, [ref])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const container = el.parentElement
    if (!container) return

    const [min, max] = layout === 'lower-third' ? [20, 44] : [26, 84]
    // leave breathing room below the reference line
    const limitH =
      layout === 'lower-third' ? window.innerHeight * 0.4 : container.clientHeight * 0.72
    const fits = (size: number): boolean => {
      el.style.fontSize = `${size}px`
      return el.scrollHeight <= limitH && el.scrollWidth <= container.clientWidth + 1
    }

    let lo = min
    let hi = max
    while (hi - lo > 1) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fits(mid)) lo = mid
      else hi = mid - 1
    }
    const final = fits(hi) ? hi : lo
    el.style.fontSize = `${final}px`
  }, [ref, text, layout, tick])
}

interface MountedSlide {
  key: string
  verse: NonNullable<OutputState['verse']>
  exiting: boolean
}

function SlideContent({
  verse,
  layout,
}: {
  verse: NonNullable<OutputState['verse']>
  layout: ThemeMeta['layout']
}) {
  const textRef = useRef<HTMLDivElement | null>(null)
  const text = verse.slides[verse.slideIndex] ?? ''
  useAutoFit(textRef, text, layout)

  if (layout === 'lower-third') {
    return (
      <div className="slide-content">
        <div className="lower-third">
          <div className="verse-ref">
            {verse.refString} · {verse.translationAbbrev}
          </div>
          <div className="verse-body">
            <div className="verse-text" ref={textRef}>
              {text}
            </div>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="slide-content">
      <div className="verse-text" ref={textRef}>
        {text}
      </div>
      <div className="verse-ref">
        <span>
          {verse.refString} · {verse.translationAbbrev}
        </span>
      </div>
    </div>
  )
}

export default function App() {
  const output = useOutputState()
  const themeId = output?.themeId ?? 'dark-elegant'
  const theme = useTheme(themeId)
  const [slides, setSlides] = useState<MountedSlide[]>([])
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const verse = output && !output.blanked ? output.verse : null
  const slideKey = verse ? `${verse.refString}|${verse.slideIndex}|${verse.translationAbbrev}` : null

  useEffect(() => {
    setSlides((prev) => {
      const current = prev.filter((s) => !s.exiting)
      if (slideKey && current.some((s) => s.key === slideKey)) return prev
      const next: MountedSlide[] = prev.map((s) => ({ ...s, exiting: true }))
      if (verse && slideKey) next.push({ key: slideKey, verse, exiting: false })
      return next
    })
    const t = setTimeout(() => {
      setSlides((prev) => prev.filter((s) => !s.exiting))
    }, theme.transitionMs + 60)
    timersRef.current.push(t)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideKey, theme.transitionMs])

  const slideCount = verse?.slides.length ?? 0

  return (
    <div
      className={`stage theme-${themeId} layout-${theme.layout} ${output ? '' : 'disconnected'}`}
      style={{ ['--transition-ms' as string]: `${theme.transitionMs}ms` }}
    >
      {slides.map((s) => (
        <div key={s.key} className={`slide ${s.exiting ? 'slide-exit' : 'slide-enter'}`}>
          <SlideContent verse={s.verse} layout={theme.layout} />
        </div>
      ))}
      {slideCount > 1 && (
        <div className="dots">
          {Array.from({ length: slideCount }, (_, i) => (
            <span key={i} className={i === (verse?.slideIndex ?? 0) ? 'active' : ''} />
          ))}
        </div>
      )}
    </div>
  )
}
