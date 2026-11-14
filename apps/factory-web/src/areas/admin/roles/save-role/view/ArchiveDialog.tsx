'use client'

import { useEffect, useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'

export interface ArchiveDialogModel {
  name: string
  /** People holding it now: their assignments end with the archive. */
  holders: number
  busy: boolean
  /** A refusal (a message key of `admin-security-depth`). */
  problem: string | null
}

/**
 * Archive a custom role (B-W2b-413 on B-W2b-404's API): who loses it now, that it changes no more and is given to nobody until
 * restored, and the reason (3 to 500 characters, kept in its history). Ending assignments asks a fresh code (the host asks it
 * first). Fetches nothing.
 */
export function ArchiveDialog({ model, onConfirm, onClose }: { model: ArchiveDialogModel; onConfirm?: (reason: string) => void; onClose?: () => void }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <Dialog model={model} onConfirm={onConfirm} onClose={onClose} />
    </WithMessages>
  )
}

function Dialog({ model, onConfirm, onClose }: { model: ArchiveDialogModel; onConfirm?: (reason: string) => void; onClose?: () => void }) {
  const t = useT('admin-security-depth')
  const ta = useT('admin')
  const [reason, setReason] = useState('')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    setReason('')
    setTried(false)
  }, [model.name])
  const short = reason.trim().length < 3
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('archive.title', { name: model.name })}
      size="sm"
      busy={model.busy}
      footer={
        <>
          <Button onClick={() => onClose?.()}>{ta('common.cancel')}</Button>
          <Button
            variant="danger"
            heldReason={model.busy ? t('archive.busy') : tried && short ? t('archive.reasonNeeded') : null}
            onClick={() => {
              setTried(true)
              if (!short) onConfirm?.(reason.trim())
            }}
          >
            {t('archive.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
        <p className="fw-adm-intro">{model.holders > 0 ? t('archive.ends', { count: model.holders }) : t('archive.nobody')}</p>
        <p className="fw-adm-hint">{t('archive.frozen')}</p>
        <Field label={t('archive.reason')} required error={tried && short ? t('archive.reasonNeeded') : undefined}>
          <Textarea value={reason} maxLength={500} rows={3} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
