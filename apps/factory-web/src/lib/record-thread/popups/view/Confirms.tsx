'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Checkbox } from '@nexus/ui/primitives'
import { ActionConfirm, Modal } from '../../../i18n/ds-parts'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { POPUPS_NS } from './FileViewer'
import '../popups.css'

/**
 * "Leave with unsent text?" (B-TH-211, T-POP): asked by the composer when the person leaves the record (another record,
 * the list, a tab) with words or files still in the box. Stay keeps everything (and has the focus); Discard drops it.
 * The browser's own question covers closing the tab (use-leave-guard.ts).
 */
export function LeaveConfirm({ files = 0, onStay, onDiscard }: { files?: number; onStay: () => void; onDiscard: () => void }) {
  return (
    <WithMessages namespaces={[POPUPS_NS]}>
      <Leave files={files} onStay={onStay} onDiscard={onDiscard} />
    </WithMessages>
  )
}

function Leave({ files, onStay, onDiscard }: { files: number; onStay: () => void; onDiscard: () => void }) {
  const t = useT(POPUPS_NS)
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        title: t('leave.title'),
        confirmLabel: t('leave.discard'),
        consequences: files > 0 ? [t('leave.lost'), t('leave.files', { count: files })] : [t('leave.lost')],
      }}
      labels={{ cancel: t('leave.stay') }}
      onConfirm={onDiscard}
      onCancel={onStay}
    />
  )
}

/**
 * "Close thread?" (B-TH-211, T-POP-F05): only for threads.manage (Owner, Administrator), with the consequence in words
 * before the click. Closing is not "Done" and never means closing the pane (× and Esc do that); Reopen undoes it exactly.
 */
export function CloseThreadConfirm({ record, party, problem = null, onClose, onCancel }: { record: string; party: string | null; problem?: string | null; onClose: () => void; onCancel: () => void }) {
  return (
    <WithMessages namespaces={[POPUPS_NS]}>
      <CloseThread record={record} party={party} problem={problem} onClose={onClose} onCancel={onCancel} />
    </WithMessages>
  )
}

function CloseThread({ record, party, problem, onClose, onCancel }: { record: string; party: string | null; problem: string | null; onClose: () => void; onCancel: () => void }) {
  const t = useT(POPUPS_NS)
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        reach: 'local',
        title: t('close.title', { record }),
        confirmLabel: t('close.confirm'),
        consequences: party ? [t('close.party', { party }), t('close.mail'), t('close.office')] : [t('close.noParty'), t('close.office')],
        reversal: { verb: t('close.reopen'), fidelity: 'exact' },
        ...(problem ? { refusal: { reason: t(problem) } } : {}),
      }}
      onConfirm={onClose}
      onCancel={onCancel}
    />
  )
}

export interface SendCheckWindowModel {
  /** Who gets it, as the person wrote them. */
  to: readonly string[]
  cc: readonly string[]
  /** The record's customer or supplier (the only party a shared message may reach), or null. */
  party: string | null
  /** The checks' findings, already in words by the send-check helper (T7); danger ones hold Send. */
  warnings: readonly { id: string; text: string; tone: 'info' | 'warning' | 'danger' }[]
  /** An address outside this customer: the recorded tick "Send outside this customer" is needed (B-TH-004). */
  outside: { ticked: boolean } | null
  /** What Send says ("Send to Brand Alpha"). */
  sendLabel: string
  /** Why Send is held now (in words), or null. */
  held: string | null
}

/**
 * The send-check window's shell (B-TH-211; T7's warnings and the "Send outside this customer" tick): the recipients, what
 * the checks found, the recorded tick when an address is outside the record's customer, Back to the message and Send. The
 * send-check helper (TH-1b's `send-check`) fills it; extra rows go in `children`. Centred, focus trapped, Esc = Back.
 */
export function SendCheckWindow({ model, onTickOutside, onBack, onSend, children }: { model: SendCheckWindowModel; onTickOutside?: (ticked: boolean) => void; onBack: () => void; onSend: () => void; children?: ReactNode }) {
  return (
    <WithMessages namespaces={[POPUPS_NS]}>
      <SendCheck model={model} onTickOutside={onTickOutside} onBack={onBack} onSend={onSend}>
        {children}
      </SendCheck>
    </WithMessages>
  )
}

function SendCheck({ model, onTickOutside, onBack, onSend, children }: { model: SendCheckWindowModel; onTickOutside?: ((ticked: boolean) => void) | undefined; onBack: () => void; onSend: () => void; children?: ReactNode }) {
  const t = useT(POPUPS_NS)
  const blocking = model.warnings.some((warning) => warning.tone === 'danger')
  const held = model.held ?? (blocking ? t('send.heldDanger') : model.outside && !model.outside.ticked ? t('send.heldOutside') : null)
  return (
    <Modal
      open
      onClose={onBack}
      size="md"
      title={t('send.title')}
      subtitle={model.party ? t('send.party', { party: model.party }) : undefined}
      footer={
        <>
          <Button onClick={onBack}>{t('send.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={onSend}>
            {model.sendLabel}
          </Button>
        </>
      }
    >
      <div className="fw-rtp-send">
        <dl className="fw-rtp-meta">
          <dt>{t('send.to')}</dt>
          <dd>{model.to.length > 0 ? model.to.join(', ') : t('send.nobody')}</dd>
          {model.cc.length > 0 && (
            <>
              <dt>{t('send.cc')}</dt>
              <dd>{model.cc.join(', ')}</dd>
            </>
          )}
        </dl>
        {model.warnings.length === 0 ? (
          <p className="fw-rtp-muted">
            <Info size={14} aria-hidden /> {t('send.allClear')}
          </p>
        ) : (
          <ul className="fw-rtp-warnings" aria-label={t('send.found')}>
            {model.warnings.map((warning) => (
              <li key={warning.id} className={`fw-rtp-warning is-${warning.tone}`}>
                <AlertTriangle size={14} aria-hidden /> <span>{warning.text}</span>
              </li>
            ))}
          </ul>
        )}
        {model.outside && (
          <div className="fw-rtp-outside">
            <Banner tone="warning" title={t('send.outsideTitle')} />
            <Checkbox label={t('send.outsideTick')} checked={model.outside.ticked} onChange={(event) => onTickOutside?.(event.target.checked)} />
            <p className="fw-rtp-muted">{t('send.outsideRecorded')}</p>
          </div>
        )}
        {children}
      </div>
    </Modal>
  )
}
