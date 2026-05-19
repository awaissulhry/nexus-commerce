'use client'

import { useEffect, useRef, useState } from 'react'
import { Lock, Loader2 } from 'lucide-react'

export type StockSplitProps = {
  fba: number | null | undefined
  fbm: number | null | undefined
  /** Tiny variant — single line, separator-delimited. Use in dense cells. */
  inline?: boolean
  /** When true, both values render in muted slate (no traffic-light tone). */
  muted?: boolean
  /** Low-stock cutoff for the FBM tone. Defaults to undefined (no tone). */
  fbmLowThreshold?: number
  /**
   * When provided, FBM becomes click-to-edit: a small input replaces the
   * number and submits the new absolute value to the callback. The
   * callback returns the authoritative {fba, fbm} once the API settles.
   */
  onAdjustFbm?: (newValue: number) => Promise<{ fbaStock: number; fbmStock: number } | void>
}

function toneFor(n: number, threshold?: number): string {
  if (threshold === undefined) return 'text-slate-700 dark:text-slate-200'
  if (n === 0) return 'text-rose-600 dark:text-rose-400'
  if (n <= 5) return 'text-orange-600 dark:text-orange-400'
  if (n <= threshold) return 'text-amber-600 dark:text-amber-400'
  return 'text-slate-700 dark:text-slate-200'
}

export function StockSplit({ fba, fbm, inline, muted, fbmLowThreshold, onAdjustFbm }: StockSplitProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [localFba, setLocalFba] = useState<number | null>(null)
  const [localFbm, setLocalFbm] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset local overrides whenever the parent passes fresh numbers.
  useEffect(() => {
    setLocalFba(null)
    setLocalFbm(null)
  }, [fba, fbm])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const fbaQty = localFba ?? fba ?? 0
  const fbmQty = localFbm ?? fbm ?? 0
  const fbaTone = muted ? 'text-slate-400 dark:text-slate-500' : 'text-orange-700 dark:text-orange-400'
  const fbmTone = muted ? 'text-slate-400 dark:text-slate-500' : toneFor(fbmQty, fbmLowThreshold)
  const editable = !!onAdjustFbm

  const startEdit = (e: React.MouseEvent) => {
    if (!editable || busy) return
    e.stopPropagation()
    setDraft(String(fbmQty))
    setEditing(true)
  }

  const cancel = () => {
    setEditing(false)
    setDraft('')
  }

  const commit = async () => {
    const next = Math.max(0, Math.floor(Number(draft)))
    if (!Number.isFinite(next) || next === fbmQty) {
      cancel()
      return
    }
    setBusy(true)
    try {
      const previousFbm = fbmQty
      setLocalFbm(next) // optimistic
      const result = await onAdjustFbm!(next)
      if (result) {
        setLocalFba(result.fbaStock)
        setLocalFbm(result.fbmStock)
      }
      setEditing(false)
      setDraft('')
      // Re-emit invalidation so other open tabs refresh.
      window.dispatchEvent(new CustomEvent('nexus:stock-adjusted', {
        detail: { fbmDelta: next - previousFbm },
      }))
    } catch {
      // Roll back on error.
      setLocalFbm(null)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void commit() }
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
  }

  const fbmInput = editing ? (
    <input
      ref={inputRef}
      type="number"
      min={0}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => { void commit() }}
      onClick={(e) => e.stopPropagation()}
      disabled={busy}
      className="w-14 px-1 py-0.5 text-sm tabular-nums font-semibold bg-white dark:bg-slate-900 border border-blue-400 dark:border-blue-500 rounded outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-800"
    />
  ) : (
    <button
      type="button"
      onClick={startEdit}
      disabled={!editable || busy}
      className={`font-semibold ${fbmTone} ${editable ? 'cursor-pointer hover:underline decoration-dotted underline-offset-2' : 'cursor-default'}`}
      title={editable ? 'Click to edit FBM stock' : undefined}
    >
      {fbmQty}
    </button>
  )

  if (inline) {
    return (
      <span className="text-xs tabular-nums whitespace-nowrap inline-flex items-center">
        <span className={`font-semibold ${fbaTone}`}>{fbaQty}</span>
        <span className="text-[10px] uppercase tracking-wider ml-0.5 text-slate-400 dark:text-slate-500">FBA</span>
        <Lock size={9} className="ml-0.5 text-slate-300 dark:text-slate-600" />
        <span className="mx-1 text-slate-300 dark:text-slate-600">·</span>
        {fbmInput}
        <span className="text-[10px] uppercase tracking-wider ml-0.5 text-slate-400 dark:text-slate-500">FBM</span>
        {busy && <Loader2 size={10} className="ml-1 animate-spin text-slate-400" />}
      </span>
    )
  }

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-sm tabular-nums">
        <span className={`font-semibold ${fbaTone}`}>{fbaQty}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">FBA</span>
        <Lock size={10} className="text-slate-300 dark:text-slate-600" aria-label="Amazon-managed; read-only" />
      </div>
      <div className="flex items-center gap-1.5 text-sm tabular-nums">
        {fbmInput}
        <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">FBM</span>
        {busy && <Loader2 size={10} className="animate-spin text-slate-400" />}
      </div>
    </div>
  )
}
