'use client'

/**
 * ER1 — the ONE eBay modal shell on the console's native idiom
 * (.h10-modal-backdrop/.h10-modal/.h10-am-btn), plus the per-item write
 * results list. Consolidated from _write-modals.tsx (C1: one file per modal;
 * the shell + result atoms live here — spec deviation §11.3, one shared
 * shell instead of per-modal chrome).
 */
import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { WriteItemOutcome } from './types'

export function H10Modal(props: { open: boolean; onClose: () => void; title: string; subtitle?: string; footer: ReactNode; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])
  if (!props.open) return null
  return (
    <div className="h10-modal-backdrop" onClick={props.onClose}>
      <div className={`h10-modal${props.wide ? ' wide' : ''}`} style={props.wide ? { width: 760 } : undefined} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={props.title}>
        <div className="h10-modal-h"><b>{props.title}</b><button type="button" className="h10-modal-x" onClick={props.onClose} aria-label="Close"><X size={16} /></button></div>
        {props.subtitle && <div className="h10-modal-sub">{props.subtitle}</div>}
        <div className="h10-modal-b"><div className="eb-form">{props.children}</div></div>
        <div className="eb-modal-f">{props.footer}</div>
      </div>
    </div>
  )
}

export function ResultsList({ results }: { results: WriteItemOutcome[] }) {
  return (
    <ul className="eb-results">
      {results.map((r, i) => (
        <li key={`${r.key}-${i}`} className={r.blocked ? 'blocked' : r.ok ? (r.warning ? 'warn' : 'ok') : 'err'}>
          <code>{r.key}</code> — {r.blocked ?? r.error ?? r.warning ?? (r.ok ? `done (${r.mode})` : 'failed')}
        </li>
      ))}
    </ul>
  )
}

export const Err = ({ msg }: { msg: string | null }) => (msg ? <ul className="eb-results"><li className="err">{msg}</li></ul> : null)
