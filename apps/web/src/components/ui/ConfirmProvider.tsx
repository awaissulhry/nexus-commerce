'use client'

/**
 * U.3 — Imperative confirm dialog API.
 *
 * Replaces synchronous `if (!confirm('Delete?')) return` patterns
 * with `if (!await confirm({ title: 'Delete?', tone: 'danger' })) return`.
 *
 * The synchronous-to-async conversion is the catch: any handler that
 * called confirm() must become async. ESLint will help — most
 * handlers are already async because they wrap fetch() calls.
 *
 * Companion to <ConfirmDialog> primitive (U.2). The provider mounts
 * a single dialog instance at the app root; the hook returns an
 * imperative function that opens it and resolves to true/false when
 * the user clicks confirm/cancel.
 *
 * Usage:
 *
 *   // 1. Mount once near the root (already done in app/layout.tsx)
 *   <ConfirmProvider>{children}</ConfirmProvider>
 *
 *   // 2. Use anywhere via the hook
 *   const confirm = useConfirm()
 *
 *   const onDelete = async () => {
 *     const ok = await confirm({
 *       title: 'Delete view?',
 *       description: `"${name}" will be removed permanently.`,
 *       confirmLabel: 'Delete',
 *       tone: 'danger',
 *     })
 *     if (!ok) return
 *     await doDelete()
 *   }
 *
 * For destructive actions, default tone is 'danger' so callers can
 * just pass the title:
 *
 *   if (!await confirm('Delete this alert?')) return
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ConfirmDialog } from './ConfirmDialog'

interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'warning' | 'info'
}

type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [busy, setBusy] = useState(false)
  // Track the current resolver in a ref so close() doesn't double-resolve
  // if React batches state updates oddly during cleanup.
  const resolverRef = useRef<((v: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((arg) => {
    return new Promise<boolean>((resolve) => {
      const opts: ConfirmOptions =
        typeof arg === 'string'
          ? { title: arg, tone: 'danger' }
          : { tone: 'danger', ...arg }
      resolverRef.current = resolve
      setPending({ ...opts, resolve })
    })
  }, [])

  const onConfirm = useCallback(async () => {
    setBusy(true)
    try {
      // Resolve true. Caller's await unblocks; they kick off the
      // actual mutation. Modal closes via the close() handler when
      // pending state clears below.
      resolverRef.current?.(true)
      resolverRef.current = null
      setPending(null)
    } finally {
      setBusy(false)
    }
  }, [])

  const onClose = useCallback(() => {
    if (busy) return
    resolverRef.current?.(false)
    resolverRef.current = null
    setPending(null)
  }, [busy])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={pending != null}
        title={pending?.title ?? ''}
        description={pending?.description}
        confirmLabel={pending?.confirmLabel}
        cancelLabel={pending?.cancelLabel}
        tone={pending?.tone}
        busy={busy}
        onConfirm={onConfirm}
        onClose={onClose}
      />
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error(
      'useConfirm() must be used inside <ConfirmProvider>. ' +
        'It is mounted in app/layout.tsx — ensure your component is a ' +
        'descendant of the root layout.',
    )
  }
  return ctx
}
