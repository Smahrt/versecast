import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface DropdownItem {
  id: string
  label: string
  hint?: string
}

export function Dropdown({
  value,
  items,
  onSelect,
  footer,
  align = 'right',
  direction = 'down',
}: {
  value: string
  items: DropdownItem[]
  onSelect: (id: string) => void
  footer?: ReactNode
  align?: 'left' | 'right'
  direction?: 'down' | 'up'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

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

  const current = items.find((i) => i.id === value) ?? items[0]

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/[0.07] bg-panel2 px-4 text-[14px] font-medium text-ink hover:border-white/[0.16]"
      >
        {current?.label ?? value}
        <span className="text-[11px] text-dim">▾</span>
      </button>
      {open && (
        <div
          className={`absolute z-50 min-w-56 overflow-hidden rounded-2xl border border-white/[0.08] bg-panel3 py-1.5 shadow-2xl shadow-black/60 ${direction === 'up' ? 'bottom-12' : 'top-12'} ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                onSelect(item.id)
                setOpen(false)
              }}
              className={`flex w-full cursor-pointer items-center justify-between gap-4 px-4 py-2.5 text-left text-[14px] hover:bg-white/[0.05] ${item.id === value ? 'text-sage' : 'text-soft'}`}
            >
              <span className="font-medium">{item.label}</span>
              {item.hint && <span className="text-[11px] text-faint">{item.hint}</span>}
            </button>
          ))}
          {footer && <div className="mt-1 border-t border-white/[0.07] pt-1">{footer}</div>}
        </div>
      )}
    </div>
  )
}
