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

/* ── B1: what happens when there is no DS provider ──────────────────────────────────────────── */

/**
 * 🔴 `useToast()` used to THROW here, and that made it a landmine for every surface.
 *
 * Two toast providers exist in this app and they are unrelated contexts: the root layout mounts the
 * legacy `@/components/ui/Toast`, while this hook reads the DS's own. A route was fine until some
 * sibling lane dropped in the first DS component that reports an outcome — a `GridViewsMenu`, say —
 * and then the whole surface was replaced by *"Something went wrong"* inside otherwise-correct
 * chrome. **The failure fired on code nobody had written that day**, and the symptom sent people
 * looking for a blank page rather than an error boundary.
 *
 * It no longer throws. But it must not go quiet either: an outcome an operator never sees is the
 * silent-failure class this design system spends most of its rules on. So the fallback **renders
 * the toast anyway**, through the same markup and the same classes as the provider, and tells the
 * developer once, loudly, where the provider belongs.
 */
const FALLBACK_HOST_CLASS = 'nds-toasts nds-toasts-fallback'
let warned = false

function emitFallbackToast(message: ReactNode, tone: Tone, duration: number): void {
  if (!warned) {
    warned = true
    // Named once per page, not per toast: a message repeated on every outcome trains people to
    // filter it, and this one needs to be read.
    console.error(
      '[nds] useToast() was called with no <ToastProvider> above it. The toast still rendered, ' +
        "but through a fallback that no one owns. Mount the DS ToastProvider at this surface's " +
        'composition root (see ProductsNextClient.tsx / _studio/StudioClient.tsx) — the root ' +
        "layout's provider is the old library's and does not satisfy this hook.",
    )
  }
  if (typeof document === 'undefined') return
  let host = document.querySelector<HTMLDivElement>('.nds-toasts-fallback')
  if (!host) {
    host = document.createElement('div')
    host.className = FALLBACK_HOST_CLASS
    document.body.appendChild(host)
  }
  const el = document.createElement('div')
  el.className = `nds-toast ${tone}`
  el.setAttribute('role', 'status')
  // Only a string can be rendered without React. A node is described rather than dropped, because
  // "an outcome happened and we cannot show it" is still worth more than nothing.
  el.textContent = typeof message === 'string' || typeof message === 'number' ? String(message) : 'Done'
  host.appendChild(el)
  setTimeout(() => el.remove(), duration)
}

/**
 * `const { toast } = useToast()`.
 *
 * Works with or without a `<ToastProvider>` — but mount one. See the note above for why the
 * fallback exists and why it complains.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx)
  const fallback = useCallback<ToastApi['toast']>(
    (message, tone = 'info', opts) => emitFallbackToast(message, tone, opts?.duration ?? 4000),
    [],
  )
  // 🔴 The hook is called unconditionally above, before this branch — a `useCallback` after an early
  // return would break the rules of hooks the first time a provider appeared mid-tree.
  return ctx ?? { toast: fallback }
}
