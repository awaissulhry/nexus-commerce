'use client'

import { useEffect, useState } from 'react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Textarea } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'

export interface BulkConfirmProps {
  open: boolean
  /** The question with its count ("Suspend 2 people?"). */
  title: string
  /** What happens, in the page's words: the consequence first, then who is left out and who it reaches. */
  lines: readonly string[]
  /** The confirm button's words ("Suspend 2"). */
  confirmLabel: string
  tone?: 'danger' | 'primary'
  /** Ask for an optional reason (kept in each row's history). */
  reason?: boolean
  busy?: boolean
  /** The run could not start or stopped (a message key of `admin`). */
  problem?: string | null
  onConfirm?: (reason: string) => void
  onClose?: () => void
}

/**
 * The ONE confirm of a bulk action on an Admin list (DS Modal): its count, its consequence, the optional reason, and
 * the button that runs it (danger for what takes access away). The run's result is the page's one notice. Fetches
 * nothing.
 */
export function BulkConfirm({ open, title, lines, confirmLabel, tone = 'danger', reason: askReason = false, busy = false, problem, onConfirm, onClose }: BulkConfirmProps) {
  const t = useT('admin')
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  if (!open) return null
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={title}
      size="sm"
      busy={busy}
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t('common.cancel')}</Button>
          <Button variant={tone} heldReason={busy ? t('common.saving') : null} onClick={() => onConfirm?.(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {problem && <Banner tone="danger" title={t(problem)} />}
        {lines.map((line, index) => (
          <p key={index} className={index === 0 ? 'fw-adm-intro' : 'fw-adm-hint'}>
            {line}
          </p>
        ))}
        {askReason && (
          <Field label={t('common.reason')} hint={t('common.reasonHint')}>
            <Textarea rows={2} limit={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
