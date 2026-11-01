'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { QrCode } from '@nexus/ui/components/QrCode/index'
import { Banner } from '@nexus/ui/components'
import { Button, Checkbox } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'

export interface RevealModel {
  /** What is shown: a badge code, a PIN, an enrolment address. */
  kind: 'badge' | 'pin' | 'enrolment'
  /** The secret, once (null: a repeated request; the API kept no copy, so a new one is needed). */
  value: string | null
  /** The text form a person reads (a grouped badge code); default the value. */
  printed?: string | null
  /** Whose it is ("Rossi Marco"). */
  owner: string
}

/**
 * OneTimeReveal — the design's new DS part (02 "New DS parts": a secret shown once, with Copy and Print and an explicit
 * "I stored it" before it can close), built here from DS Modal, QrCode, Checkbox and Button until the DS adds it (DS
 * gap). The API keeps only a hash: once closed, the secret is gone; a lost one is replaced, never shown again.
 */
export function OneTimeReveal({ model, onClose, extra }: { model: RevealModel | null; onClose?: () => void; extra?: ReactNode }) {
  const t = useT('admin')
  const [stored, setStored] = useState(false)
  useEffect(() => setStored(false), [model?.value, model?.kind])
  if (!model) return null
  const text = model.printed ?? model.value
  return (
    <Modal
      open
      onClose={() => (stored || model.value === null ? onClose?.() : undefined)}
      title={t(`reveal.${model.kind}.title`, { name: model.owner })}
      size="sm"
      closeHeld={stored || model.value === null ? null : t('reveal.closeHeld')}
      footer={
        <>
          {model.value && (
            <Button onClick={() => window.print()}>
              {t('reveal.print')}
            </Button>
          )}
          <Button variant="primary" heldReason={stored || model.value === null ? null : t('reveal.closeHeld')} onClick={() => onClose?.()}>
            {t('reveal.done')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-reveal">
        {model.value === null ? (
          <Banner tone="warning" title={t('reveal.repeat')} />
        ) : (
          <>
            <p className="fw-adm-intro">{t(`reveal.${model.kind}.body`)}</p>
            {model.kind === 'pin' ? (
              <p className="fw-adm-secret" aria-label={t('reveal.pin.label')}>
                {text}
              </p>
            ) : (
              <QrCode
                value={model.value}
                code={text ?? undefined}
                label={t(`reveal.${model.kind}.qr`, { name: model.owner })}
                size={180}
                labels={{ copy: t('reveal.copy'), copied: t('reveal.copied'), copyFailed: t('reveal.copyFailed'), loading: t('reveal.drawing'), tooLong: t('reveal.tooLong') }}
              />
            )}
            {extra}
            <Checkbox checked={stored} onChange={(event) => setStored(event.target.checked)} label={t(`reveal.${model.kind}.stored`)} />
          </>
        )}
      </div>
    </Modal>
  )
}
