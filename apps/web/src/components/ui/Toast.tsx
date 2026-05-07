'use client'

// App-wide toast/notification system. Mounted once at the app layout
// (<ToastProvider>) and consumed via the useToast() hook anywhere.
//
// Design: Linear/Vercel-style. Top-right viewport, slide-in animation,
// 4-second auto-dismiss (configurable per toast), click-to-dismiss,
// 4 tones (success / error / warning / info).
//
// Why this exists: pre-this, mutations across the app failed silently
// or logged to console. Operators couldn't tell if an action landed.
// One existing inline pushToast in ReplenishmentWorkspace was the
// only feedback channel; every other page was opaque.
//
// Usage:
//   const { toast } = useToast()
//   toast.success('Saved')
//   toast.error('Save failed: ' + err.message)
//   toast({ title: 'Info', description: '...', tone: 'info', durationMs: 8000 })

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AlertCircle, CheckCircle2, Info, X, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ToastTone = 'success' | 'error' | 'warning' | 'info'

export interface ToastOptions {
  /** Headline. Either title or description must be set. */
  title?: string
  /** Sub-text under the title. */
  description?: string
  /** Severity. Drives icon + color. Default 'info'. */
  tone?: ToastTone
  /** Auto-dismiss after this many ms. Default 4000. Set 0 to disable. */
  durationMs?: number
  /** Optional action button shown alongside the dismiss icon. */
  action?: { label: string; onClick: () => void }
}

interface InternalToast extends ToastOptions {
  id: string
  createdAt: number
}

interface ToastContextValue {
  toast: ToastFn
  dismiss: (id: string) => void
  dismissAll: () => void
}

interface ToastFn {
  (options: ToastOptions | string): string
  success: (msg: string, extra?: Partial<ToastOptions>) => string
  error: (msg: string, extra?: Partial<ToastOptions>) => string
  warning: (msg: string, extra?: Partial<ToastOptions>) => string
  info: (msg: string, extra?: Partial<ToastOptions>) => string
}

const ToastContext = createContext<ToastContextValue | null>(null)

const DEFAULT_DURATION_MS = 4000
const MAX_VISIBLE = 5

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<InternalToast[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const dismissAll = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t))
    timers.current.clear()
    setToasts([])
  }, [])

  const push = useCallback(
    (raw: ToastOptions | string): string => {
      const opts: ToastOptions =
        typeof raw === 'string' ? { description: raw } : raw
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const tone: ToastTone = opts.tone ?? 'info'
      const durationMs =
        opts.durationMs === undefined ? DEFAULT_DURATION_MS : opts.durationMs
      const next: InternalToast = {
        ...opts,
        tone,
        durationMs,
        id,
        createdAt: Date.now(),
      }
      setToasts((prev) => {
        // Cap visible toasts: drop oldest if we're at the limit.
        const trimmed = prev.length >= MAX_VISIBLE ? prev.slice(1) : prev
        return [...trimmed, next]
      })
      if (durationMs > 0) {
        const timer = setTimeout(() => dismiss(id), durationMs)
        timers.current.set(id, timer)
      }
      return id
    },
    [dismiss],
  )

  // Cleanup timers on unmount
  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((t) => clearTimeout(t))
      map.clear()
    }
  }, [])

  // Build the typed toast function with tone shorthands
  const toast: ToastFn = useCallback(
    ((raw: ToastOptions | string) => push(raw)) as ToastFn,
    [push],
  )
  toast.success = (msg, extra) =>
    push({ ...extra, description: msg, tone: 'success' })
  toast.error = (msg, extra) =>
    push({ ...extra, description: msg, tone: 'error' })
  toast.warning = (msg, extra) =>
    push({ ...extra, description: msg, tone: 'warning' })
  toast.info = (msg, extra) =>
    push({ ...extra, description: msg, tone: 'info' })

  return (
    <ToastContext.Provider value={{ toast, dismiss, dismissAll }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // SSR/standalone-render fallback: returns no-op functions so calls
    // don't crash if the provider hasn't mounted yet (e.g. during a
    // server render of a nested component).
    return {
      toast: Object.assign(() => '', {
        success: () => '',
        error: () => '',
        warning: () => '',
        info: () => '',
      }) as ToastFn,
      dismiss: () => {},
      dismissAll: () => {},
    }
  }
  return ctx
}

// ── Viewport ────────────────────────────────────────────────────────

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: InternalToast[]
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div
      className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] sm:w-96 pointer-events-none"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  )
}

const TONE_STYLE: Record<ToastTone, { bg: string; border: string; text: string; iconCls: string }> = {
  success: {
    bg: 'bg-white',
    border: 'border-green-200',
    text: 'text-slate-900',
    iconCls: 'text-green-600',
  },
  error: {
    bg: 'bg-white',
    border: 'border-red-200',
    text: 'text-slate-900',
    iconCls: 'text-red-600',
  },
  warning: {
    bg: 'bg-white',
    border: 'border-amber-200',
    text: 'text-slate-900',
    iconCls: 'text-amber-600',
  },
  info: {
    bg: 'bg-white',
    border: 'border-slate-200',
    text: 'text-slate-900',
    iconCls: 'text-blue-600',
  },
}

function ToneIcon({ tone, className }: { tone: ToastTone; className?: string }) {
  const cls = cn('w-4 h-4 flex-shrink-0', className)
  switch (tone) {
    case 'success':
      return <CheckCircle2 className={cls} />
    case 'error':
      return <AlertCircle className={cls} />
    case 'warning':
      return <AlertTriangle className={cls} />
    case 'info':
    default:
      return <Info className={cls} />
  }
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: InternalToast
  onDismiss: () => void
}) {
  const tone = toast.tone ?? 'info'
  const style = TONE_STYLE[tone]
  return (
    <div
      className={cn(
        'pointer-events-auto rounded-lg border shadow-md px-3.5 py-3 flex items-start gap-2.5',
        // U.16 — slide in from the right edge. The previous arbitrary
        // value (`animate-[slide-in-right_…]`) referenced a keyframe
        // that was never defined in tailwind.config, so it silently
        // no-op'd. Now points at the keyframe added in tailwind config.
        'animate-slide-from-right motion-reduce:animate-none',
        style.bg,
        style.border,
        style.text,
      )}
      role="status"
    >
      <ToneIcon tone={tone} className={cn('mt-0.5', style.iconCls)} />
      <div className="min-w-0 flex-1">
        {toast.title && (
          <div className="text-md font-semibold leading-tight mb-0.5">
            {toast.title}
          </div>
        )}
        {toast.description && (
          <div className="text-base text-slate-700 leading-snug break-words">
            {toast.description}
          </div>
        )}
      </div>
      <div className="flex items-start gap-1.5 flex-shrink-0">
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick()
              onDismiss()
            }}
            className="text-sm font-medium text-blue-700 hover:text-blue-900 px-1.5 py-0.5 rounded hover:bg-blue-50"
          >
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-slate-400 hover:text-slate-700 mt-0.5"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
