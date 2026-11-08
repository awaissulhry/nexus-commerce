'use client'

import { useEffect, useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { usePortalT } from './parts'

export interface ConfirmBoxProps {
  open: boolean
  title: string
  /** The consequence in words, then who it reaches. */
  lines: readonly string[]
  confirmLabel: string
  tone?: 'danger' | 'primary'
  /** Ask for an optional reason (kept in the audit log). */
  reason?: boolean
  busy?: boolean
  /** A refusal (a key of `portal-access`), said inside the box. */
  problem?: string | null
  onConfirm?: (reason: string) => void
  onClose?: () => void
}

/** One confirm for an action over one or many partner people (DS Modal): what happens, to whom, an optional reason. */
export function ConfirmBox({ open, title, lines, confirmLabel, tone = 'danger', reason: askReason = false, busy = false, problem, onConfirm, onClose }: ConfirmBoxProps) {
  const t = usePortalT()
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  return (
    <Modal
      open={open}
      onClose={() => onClose?.()}
      title={title}
      footer={
        <span className="fw-pa-actions">
          <Button onClick={() => onClose?.()}>{t('common.cancel')}</Button>
          <Button variant={tone} heldReason={busy ? t('common.saving') : null} onClick={() => onConfirm?.(reason.trim())}>
            {confirmLabel}
          </Button>
        </span>
      }
    >
      <div className="fw-pa-form">
        {problem && <Banner tone="danger" title={t(problem)} />}
        {lines.map((line, index) => (
          <p key={index} className={index === 1 ? 'fw-pa-text fw-pa-strong' : 'fw-pa-text'}>
            {line}
          </p>
        ))}
        {askReason && (
          <Field label={t('confirm.reason')} hint={t('confirm.reasonHint')}>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
