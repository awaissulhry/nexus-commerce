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
  toast: (message: ReactNode, tone?: Tone) => void
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
    (message: ReactNode, tone: Tone = 'info') => {
      const id = nextId++
      setItems((xs) => [...xs, { id, message, tone }])
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), duration)
    },
    [duration],
  )

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      {mounted &&
        createPortal(
          <div className="h10-ds-toasts">
            {items.map((t) => (
              <div key={t.id} className={`h10-ds-toast ${t.tone}`} role="status">
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
