'use client'

/**
 * ER1 — the ONE eBay modal shell. Now a thin wrapper over the Nexus DS <Modal>
 * (it adds only the .eb-form column layout), plus the per-item write
 * results list. Consolidated from _write-modals.tsx (C1: one file per modal;
 * the shell + result atoms live here — spec deviation §11.3, one shared
 * shell instead of per-modal chrome).
 */
import { type ReactNode } from 'react'
import { Modal } from '@/design-system/components'
import type { WriteItemOutcome } from './types'

export function H10Modal(props: { open: boolean; onClose: () => void; title: string; subtitle?: string; footer: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      size={props.wide ? 'xl' : 'sm'}
      title={props.title}
      subtitle={props.subtitle}
      footer={props.footer}
    >
      <div className="eb-form">{props.children}</div>
    </Modal>
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
