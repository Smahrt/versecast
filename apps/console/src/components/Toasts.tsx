import type { Toast } from '../lib/useConsole.ts'

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null
  return (
    <div className="fixed right-5 bottom-24 z-50 flex w-95 flex-col gap-2.5">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`vc-card-in cursor-pointer rounded-2xl border px-4.5 py-3.5 text-left text-[13.5px] leading-snug shadow-xl shadow-black/40 ${
            t.kind === 'error'
              ? 'border-live/40 bg-[#1d1412] text-live-soft'
              : t.kind === 'success'
                ? 'border-sage/35 bg-card-hot text-sage-soft'
                : 'border-white/10 bg-panel3 text-soft'
          }`}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}
