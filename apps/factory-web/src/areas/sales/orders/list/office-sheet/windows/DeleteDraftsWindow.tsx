'use client'

import { useState } from 'react'
import { Button } from '@nexus/ui/primitives'
import { Banner, Modal } from '@nexus/ui/components'
import { useOfficeApi } from '../../../../../../lib/session/context'
import { useT } from '../../../../../../lib/i18n/provider'
import { discardDraft, type SheetRowRead } from '../api'
import { NS } from '../map'
import { refusalWordsOf } from '../use-office-sheet'

/**
 * owb-of3 step 3 — Delete this draft / Delete the drafts: it asks first (a draft was never sent, so no record is lost; a sent order is
 * never deleted), then today's office discard for each, at the version read; what was refused is said with its count.
 */
export function DeleteDraftsWindow({ rows, onClose, onDone }: { rows: readonly SheetRowRead[]; onClose: () => void; onDone: (words: string | null) => void }) {
  const api = useOfficeApi()
  const t = useT(NS)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setProblem(null)
    let done = 0
    let last: unknown = null
    for (const row of rows) {
      try {
        await discardDraft(api, row.id, row.version)
        done++
      } catch (error) {
        last = error
      }
    }
    if (done === rows.length) onDone(t('office.delete.done', { count: done }))
    else if (done > 0) onDone(`${t('office.delete.done', { count: done })} · ${t('office.bulk.refused', { count: rows.length - done })}`)
    else {
      setProblem(refusalWordsOf(last, t))
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('office.delete.title', { count: rows.length })}
      subtitle={t('office.delete.subtitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('office.cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void run()}>
            {t('office.delete.go', { count: rows.length })}
          </Button>
        </>
      }
    >
      {problem && <Banner tone="danger" title={problem} />}
      <ul className="fw-osp-list">
        {rows.map((row) => (
          <li key={row.id}>
            <span className="fw-osp-strong">{row.subject ?? t('part.noSubject')}</span> <span className="fw-osp-muted">· {row.party.name}</span>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
