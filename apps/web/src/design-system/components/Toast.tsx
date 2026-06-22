'use client'

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type ToastVariant = 'info' | 'success' | 'error'

interface ToastItem {
  id: number
  message: ReactNode
  variant: ToastVariant
}

interface ToastApi {
  toast: (message: ReactNode, variant?: ToastVariant) => void
}

const ToastCtx = createContext<ToastApi | null>(null)

let nextId = 1

/** Wrap the app (or a subtree) once; renders a bottom-center toast viewport. */
export function ToastProvider({ children, duration = 4000 }: { children: ReactNode; duration?: number }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const toast = useCallback(
    (message: ReactNode, variant: ToastVariant = 'info') => {
      const id = nextId++
      setItems((xs) => [...xs, { id, message, variant }])
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), duration)
    },
    [duration],
  )

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <div className="h10-ds-toasts">
            {items.map((t) => (
              <div key={t.id} className={`h10-ds-toast ${t.variant}`} role="status">
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
