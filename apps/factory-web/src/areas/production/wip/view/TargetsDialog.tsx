'use client'

import { useMemo, useState } from 'react'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { targetChanges, targetsHeld, targetsTotal, type TargetDraftRow } from '../model'
import type { BoardRefusal } from './HourlyPanel'

export interface TargetsDialogModel {
  readonly line: { readonly code: string; readonly name: string }
  /** The day's hours as read; null while they are read. */
  readonly rows: readonly TargetDraftRow[] | null
  readonly problem: string | null
}

/**
 * Set a line's hourly targets for today (B-W2b-66, PUT /production/boards/targets; MES-084): one row per working hour, the
 * pieces the whole line should make; an empty row has no target. Line targets, never per person. The design gives this
 * no page of its own: without it nothing could ever be "short", so it lives on Hour by hour, next to what it drives.
 */
export function TargetsDialog({ model, onClose, onSave }: { model: TargetsDialogModel; onClose: () => void; onSave: (changes: ReturnType<typeof targetChanges>) => Promise<BoardRefusal | null> }) {
  const t = useT('production-floor')
  const [edits, setEdits] = useState<Readonly<Record<number, string>>>({})
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<BoardRefusal | null>(null)
  const rows = useMemo(() => model.rows?.map((row) => ({ ...row, value: edits[row.hour] ?? row.value })) ?? null, [model.rows, edits])
  const held = rows ? targetsHeld(rows) : 'targets.held.nothing'
  const save = async () => {
    if (!rows) return
    setBusy(true)
    setRefused(null)
    const answer = await onSave(targetChanges(rows))
    setBusy(false)
    if (answer) setRefused(answer)
    else onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('targets.title', { line: `${model.line.code} · ${model.line.name}` })}
      subtitle={t('targets.subtitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} disabled={busy} onClick={() => void save()}>
            {busy ? t('saving') : t('targets.save')}
          </Button>
        </>
      }
    >
      {model.problem ? (
        <p className="fw-fn-refused" role="alert">
          {t(model.problem)}
        </p>
      ) : !rows ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('loading')}
        </p>
      ) : rows.length === 0 ? (
        <p className="fw-pr-hint">{t('targets.noHours')}</p>
      ) : (
        <div className="fw-fn-targets">
          {rows.map((row) => (
            <label key={row.hour} className="fw-fn-target">
              <span className="fw-fn-miss-hour">{row.label}</span>
              <Input size="sm" inputMode="numeric" value={row.value} disabled={busy} aria-label={t('targets.hour', { hour: row.label })} onChange={(event) => setEdits((current) => ({ ...current, [row.hour]: event.target.value }))} />
              <span className="fw-pr-hint">{row.workingMinutes > 0 ? t('targets.minutes', { count: row.workingMinutes }) : t('targets.noWork')}</span>
            </label>
          ))}
          <p className="fw-fn-target-total">{t('targets.total', { count: targetsTotal(rows) })}</p>
        </div>
      )}
      {refused && (
        <p className="fw-fn-refused" role="alert">
          {t(refused.key)}
          {refused.fix ? ` ${t(refused.fix)}` : ''}
        </p>
      )}
    </Modal>
  )
}
