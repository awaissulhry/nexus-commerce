'use client'

/**
 * Settings rebuild — Phase A.3
 *
 * Sticky save bar used by every settings page that has a form.
 *
 * Pattern:
 *   1. <SettingsSaveBarProvider> wraps the shell, owns the bar state
 *      (idle / dirty / saving / saved / error).
 *   2. A page calls registerSettingsForm({ onSave, onDiscard, isDirty })
 *      via the useSettingsForm() hook on every render. The provider
 *      reflects that in the bar.
 *   3. The bar at the bottom of the viewport shows Save + Discard
 *      whenever isDirty === true. Ctrl/Cmd+S triggers Save.
 *   4. A beforeunload listener warns on tab close when the form is
 *      dirty — same trick Stripe + Shopify use.
 *
 * Phase A leaves existing pages alone (they keep their own Save
 * buttons). Pages migrate one-by-one in later phases. The bar
 * stays hidden until at least one page registers, so during the
 * migration nothing changes visually for pages that don't opt in.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Check, Loader2, AlertCircle, RotateCcw } from 'lucide-react'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface RegisteredForm {
  /** Stable id — usually the page route. Used to detect ownership. */
  id: string
  /** Called when the operator clicks Save (or hits Cmd+S). */
  onSave: () => Promise<void> | void
  /** Called when the operator clicks Discard. */
  onDiscard: () => void
  /** True when at least one field differs from the persisted value. */
  isDirty: boolean
}

interface SaveBarContextValue {
  /**
   * Pages call this on every render with their current state.
   * The provider stores the last registration; rendering the bar
   * is driven by that.
   */
  register: (form: RegisteredForm | null) => void
}

const SaveBarContext = createContext<SaveBarContextValue | null>(null)

export function SettingsSaveBarProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [registered, setRegistered] = useState<RegisteredForm | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const registeredRef = useRef<RegisteredForm | null>(null)
  registeredRef.current = registered

  // Pages may re-register on every render — collapse to a single
  // setState call when the relevant fields actually change. Without
  // this we'd reset the bar's saved/error state on every parent
  // re-render, which would dismiss "✓ Saved" before the user reads it.
  const register = useCallback((form: RegisteredForm | null) => {
    setRegistered((prev) => {
      if (form === null && prev === null) return prev
      if (
        prev &&
        form &&
        prev.id === form.id &&
        prev.isDirty === form.isDirty &&
        prev.onSave === form.onSave &&
        prev.onDiscard === form.onDiscard
      ) {
        return prev
      }
      return form
    })
  }, [])

  const value = useMemo<SaveBarContextValue>(() => ({ register }), [register])

  const runSave = useCallback(async () => {
    const current = registeredRef.current
    if (!current || !current.isDirty) return
    setStatus('saving')
    setError(null)
    try {
      await current.onSave()
      setStatus('saved')
      // Auto-clear the "Saved" pill after ~2s so the bar disappears
      // (it only stays visible while dirty OR while it has feedback
      // to display).
      setTimeout(() => {
        setStatus((s) => (s === 'saved' ? 'idle' : s))
      }, 2000)
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const runDiscard = useCallback(() => {
    registeredRef.current?.onDiscard()
    setStatus('idle')
    setError(null)
  }, [])

  // Ctrl/Cmd+S = Save. Only active when a dirty form is registered.
  useEffect(() => {
    if (!registered?.isDirty) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void runSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [registered?.isDirty, runSave])

  // beforeunload guard while dirty — browsers will show the native
  // "leave site?" prompt. Standard pattern; works in every major
  // browser without per-browser quirks.
  useEffect(() => {
    if (!registered?.isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Most browsers ignore the returnValue string and show their
      // own message, but the property has to be set for the prompt
      // to fire at all.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [registered?.isDirty])

  // The bar renders only when there's something to show — saving
  // dirty form, in-flight save, success pill, or error.
  const showBar =
    !!registered &&
    (registered.isDirty || status !== 'idle' || error !== null)

  return (
    <SaveBarContext.Provider value={value}>
      {children}
      {showBar && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:right-4 sm:left-auto z-30 flex justify-center sm:justify-end pointer-events-none"
        >
          <div className="pointer-events-auto inline-flex items-center gap-3 px-4 py-2.5 rounded-lg bg-slate-900 dark:bg-slate-800 text-white shadow-xl border border-slate-700">
            {status === 'saving' && (
              <span className="inline-flex items-center gap-2 text-sm">
                <Loader2 size={14} className="animate-spin" />
                Saving…
              </span>
            )}
            {status === 'saved' && (
              <span className="inline-flex items-center gap-2 text-sm text-emerald-300">
                <Check size={14} />
                Saved
              </span>
            )}
            {status === 'error' && error && (
              <span className="inline-flex items-center gap-2 text-sm text-rose-300 max-w-xs truncate">
                <AlertCircle size={14} />
                {error}
              </span>
            )}
            {(status === 'idle' || status === 'error') &&
              registered?.isDirty && (
                <span className="text-sm text-slate-300">
                  You have unsaved changes
                </span>
              )}
            {registered?.isDirty && (
              <>
                <button
                  type="button"
                  onClick={runDiscard}
                  disabled={status === 'saving'}
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                >
                  <RotateCcw size={12} />
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => void runSave()}
                  disabled={status === 'saving'}
                  className="inline-flex items-center gap-1.5 h-7 px-3 rounded text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
                >
                  Save changes
                  <kbd className="hidden sm:inline-flex items-center h-4 px-1 rounded bg-blue-700/60 text-[10px] font-mono">
                    ⌘S
                  </kbd>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </SaveBarContext.Provider>
  )
}

/**
 * Pages register themselves on every render via this hook. Pass
 * stable callbacks (useCallback) so the provider doesn't churn.
 *
 * Typical usage:
 *
 *   const [draft, setDraft] = useState(initial)
 *   const isDirty = !shallowEqual(draft, initial)
 *   useSettingsForm({
 *     id: 'settings/profile',
 *     isDirty,
 *     onSave: useCallback(async () => { await save(draft); refresh() }, [draft]),
 *     onDiscard: useCallback(() => setDraft(initial), [initial]),
 *   })
 *
 * Pages are NOT required to use this — pre-migration pages can
 * keep their own inline save buttons and the bar simply stays
 * hidden for them.
 */
export function useSettingsForm(form: RegisteredForm): void {
  const ctx = useContext(SaveBarContext)
  if (!ctx) {
    throw new Error(
      'useSettingsForm must be called within <SettingsSaveBarProvider>',
    )
  }
  useEffect(() => {
    ctx.register(form)
    return () => ctx.register(null)
  }, [ctx, form])
}
