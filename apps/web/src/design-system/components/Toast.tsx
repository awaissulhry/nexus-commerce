'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Tone } from '../primitives/tone'

interface ToastItem {
  id: number
  message: ReactNode
  tone: Tone
}

export interface ToastApi {
  /** `opts.duration` overrides the provider default for ONE toast — a toast carrying an
   *  interactive verb (an Undo) needs more time on screen than a plain receipt. */
  toast: (message: ReactNode, tone?: Tone, opts?: { duration?: number }) => void
}

const ToastCtx = createContext<ToastApi | null>(null)

let nextId = 1

/** Wrap the app (or a subtree) once; renders a bottom-center toast viewport. */
export function ToastProvider({ children, duration = 4000 }: { children: ReactNode; duration?: number }) {
  const [items, setItems] = useState<ToastItem[]>([])
  // render the portal only after mount so the first client render matches the
  // server (empty) — avoids a hydration mismatch on the always-present viewport.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const toast = useCallback(
    (message: ReactNode, tone: Tone = 'info', opts?: { duration?: number }) => {
      const id = nextId++
      setItems((xs) => [...xs, { id, message, tone }])
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), opts?.duration ?? duration)
    },
    [duration],
  )

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      {mounted &&
        createPortal(
          <div className="nds-toasts">
            {items.map((t) => (
              <div key={t.id} className={`nds-toast ${t.tone}`} role="status">
                <span className="dot" />
                <span>{t.message}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastCtx.Provider>
  )
}

/** `const { toast } = useToast()` — must be under a `<ToastProvider>`. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}
