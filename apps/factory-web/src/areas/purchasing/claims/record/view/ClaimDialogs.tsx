'use client'

import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Radio, Spinner, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money, quantity } from '../../../../_shared/buying/model'
import type { Claim } from '../../api'
import { answerHeld, goodsHeld, linesLeft, say, sendHeld, simpleHeld, type AnswerDraft, type ClaimDialog, type ClaimRecordActions, type ClaimRecordModel, type GoodsDraft, type SendDraft } from '../../model'
import { DdtFields } from '../../parts/DdtFields'

interface Props {
  claim: Claim
  model: ClaimRecordModel
  actions?: ClaimRecordActions
}

/**
 * The claim's dialogs (Esc closes each and the focus goes back to its opener; ⌘↵ confirms where it may): Send to the
 * supplier (the mail on the claim's thread to the contacts ticked, in the supplier's language, no price — or sent
 * without a mail), Record the supplier's answer, Send the goods back (the lines still here and the return DDT), Close
 * (how it was settled), Cancel a draft (why), Remove lines of a draft, and what the goods' return made. Each refusal is
 * said inside its dialog, in this app's words.
 */
export function ClaimDialogs(props: Props) {
  const dialog = props.model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'send':
      return <SendDialog {...props} draft={dialog.draft} />
    case 'answer':
      return <AnswerDialog {...props} draft={dialog.draft} />
    case 'returnGoods':
      return <GoodsDialog {...props} draft={dialog.draft} />
    case 'returned':
      return <ReturnedDialog {...props} dialog={dialog} />
    default:
      return <SimpleDialog {...props} dialog={dialog} />
  }
}

function Frame({ model, actions, title, held, label, tone, size = 'md', children }: Pick<Props, 'model' | 'actions'> & { title: string; held: string | null; label: string; tone?: 'danger'; size?: 'sm' | 'md' | 'lg'; children: ReactNode }) {
  const t = useT('purchasing-claims')
  const blocked = model.busy ? t('held.busy') : held
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={title}
      size={size}
      busy={model.busy}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)} heldReason={model.busy ? t('held.busy') : null}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" tone={tone} heldReason={blocked} onClick={() => actions?.onConfirm?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy && <Spinner size={12} />} {label}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        {children}
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
      </div>
    </Modal>
  )
}

function SendDialog({ claim, model, actions, draft }: Props & { draft: SendDraft }) {
  const t = useT('purchasing-claims')
  const held = sendHeld(draft, claim, model.can)
  const set = (next: Partial<SendDraft>) => actions?.onDialog?.({ kind: 'send', draft: { ...draft, ...next } })
  const check = draft.check.value
  return (
    <Frame model={model} actions={actions} size="lg" title={t(claim.status === 'REJECTED' ? 'send.titleAgain' : 'send.title', { number: claim.number, supplier: claim.supplier.name })} held={held ? say(t, held) : null} label={t(draft.withMail ? 'send.confirmMail' : 'send.confirmNoMail')}>
      <p className="fw-by-hint">{t('send.body')}</p>
      {claim.remedy === null && (
        <Field label={t('field.remedy')} required hint={t('send.remedyHint')}>
          <span className="fw-by-inline" role="radiogroup" aria-label={t('field.remedy')}>
            <Radio name="send-remedy" checked={draft.remedy === 'CREDIT'} onChange={() => set({ remedy: 'CREDIT' })} label={t('remedy.CREDIT')} />
            <Radio name="send-remedy" checked={draft.remedy === 'REPLACEMENT'} onChange={() => set({ remedy: 'REPLACEMENT' })} label={t('remedy.REPLACEMENT')} />
          </span>
        </Field>
      )}
      <div className="fw-by-card-head">
        <h3 className="fw-by-h3">{t('send.mailTitle')}</h3>
        <span className="fw-by-inline">
          <Toggle checked={draft.withMail} onChange={(withMail) => set({ withMail })} aria-label={t('send.withMail')} />
          <span>{t('send.withMail')}</span>
        </span>
      </div>
      {!draft.withMail ? (
        <p className="fw-by-hint">{t('send.noMail')}</p>
      ) : draft.check.problem ? (
        <Banner tone="danger" title={t(draft.check.problem)} />
      ) : !check ? (
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <div className="fw-by-stack">
          {check.recipients.length === 0 ? (
            <Banner tone="warning" title={t('send.noContacts', { supplier: claim.supplier.name })} />
          ) : (
            <ul className="fw-by-list" aria-label={t('send.recipients')}>
              {check.recipients.map((entry) => (
                <li key={entry.contactId}>
                  <Checkbox
                    checked={draft.contactIds.includes(entry.contactId)}
                    onChange={(event) => set({ contactIds: event.target.checked ? [...draft.contactIds, entry.contactId] : draft.contactIds.filter((id) => id !== entry.contactId) })}
                    label={`${entry.name} · ${entry.email}${entry.roles.length > 0 ? ` (${entry.roles.map((role) => t(`contactRole.${role}`)).join(', ')})` : ''}`}
                  />
                </li>
              ))}
            </ul>
          )}
          <Field label={t('send.cc')} hint={t('send.ccHint')}>
            <Input size="sm" value={draft.cc} onChange={(event) => set({ cc: event.target.value })} />
          </Field>
          <Field label={t('send.subject')}>
            <Input size="sm" maxLength={200} value={draft.subject} onChange={(event) => set({ subject: event.target.value })} />
          </Field>
          <Field label={t('send.message', { language: t(`language.${check.language}`) })} hint={t('send.messageHint')}>
            <Textarea rows={7} maxLength={4000} value={draft.message} onChange={(event) => set({ message: event.target.value })} />
          </Field>
          {/* B-W2b-14 (Z1:08): the claim letter (PDF, no price) goes with the mail, or why not. */}
          {check.letter.attached ? (
            <p className="fw-by-hint">{t('send.letterAttached', { photos: claim.photos.length })}</p>
          ) : (
            <Banner tone="info" title={t(check.letter.problems.some((problem) => problem.path.includes('filesRead')) ? 'send.letterNoFiles' : 'send.letterNoLetterhead')} />
          )}
          <p className="fw-by-hint">{t('send.noPrice')}</p>
        </div>
      )}
      <ul className="fw-by-list">
        <li>{t('send.does.state')}</li>
        {claim.lines.some((line) => line.discrepancy) && <li>{t('send.does.discrepancies')}</li>}
        <li>{t('send.does.fixed')}</li>
      </ul>
    </Frame>
  )
}

function AnswerDialog({ claim, model, actions, draft }: Props & { draft: AnswerDraft }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const held = answerHeld(draft, claim, model.can)
  const set = (next: Partial<AnswerDraft>) => actions?.onDialog?.({ kind: 'answer', draft: { ...draft, ...next } })
  return (
    <Frame model={model} actions={actions} title={t('answer.title', { number: claim.number })} held={held ? say(t, held) : null} label={t('answer.confirm')}>
      <Field label={t('answer.outcome')} required>
        <span className="fw-by-inline" role="radiogroup" aria-label={t('answer.outcome')}>
          <Radio name="answer-outcome" checked={draft.outcome === 'ACCEPTED'} onChange={() => set({ outcome: 'ACCEPTED' })} label={t('answer.accepted')} />
          <Radio name="answer-outcome" checked={draft.outcome === 'REJECTED'} onChange={() => set({ outcome: 'REJECTED' })} label={t('answer.rejected')} />
        </span>
      </Field>
      <Field label={t('answer.words')} required hint={t('answer.wordsHint')}>
        <Textarea rows={3} maxLength={2000} value={draft.answer} onChange={(event) => set({ answer: event.target.value })} autoFocus />
      </Field>
      {draft.outcome === 'ACCEPTED' && (
        <div className="fw-by-fields">
          <Field label={t('field.remedy')}>
            <span className="fw-by-inline" role="radiogroup" aria-label={t('field.remedy')}>
              <Radio name="answer-remedy" checked={draft.remedy === 'CREDIT'} onChange={() => set({ remedy: 'CREDIT' })} label={t('remedy.CREDIT')} />
              <Radio name="answer-remedy" checked={draft.remedy === 'REPLACEMENT'} onChange={() => set({ remedy: 'REPLACEMENT' })} label={t('remedy.REPLACEMENT')} />
            </span>
          </Field>
          {model.can.cost && draft.remedy !== 'REPLACEMENT' && (
            <Field label={t('field.agreed', { currency: claim.currency })} hint={claim.value != null ? t('answer.agreedHint', { value: money(claim.value, claim.currency, locale) }) : t('field.agreedHint')}>
              <Input size="sm" inputMode="decimal" value={draft.agreed} onChange={(event) => set({ agreed: event.target.value })} suffix={claim.currency} />
            </Field>
          )}
        </div>
      )}
      <ul className="fw-by-list">
        <li>{t(draft.outcome === 'REJECTED' ? 'answer.does.rejected' : 'answer.does.accepted')}</li>
      </ul>
    </Frame>
  )
}

function GoodsDialog({ claim, model, actions, draft }: Props & { draft: GoodsDraft }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const held = goodsHeld(draft, claim, model.can)
  const set = (next: Partial<GoodsDraft>) => actions?.onDialog?.({ kind: 'returnGoods', draft: { ...draft, ...next } })
  const left = linesLeft(claim)
  return (
    <Frame model={model} actions={actions} size="lg" title={t('goodsBack.title', { number: claim.number, supplier: claim.supplier.name })} held={held ? say(t, held) : null} label={t('goodsBack.confirm', { count: draft.lineIds.length })}>
      <p className="fw-by-hint">{t('goodsBack.body')}</p>
      <ul className="fw-by-list" aria-label={t('goodsBack.lines')}>
        {left.map((line) => (
          <li key={line.id}>
            <Checkbox
              checked={draft.lineIds.includes(line.id)}
              onChange={(event) => set({ lineIds: event.target.checked ? [...draft.lineIds, line.id] : draft.lineIds.filter((id) => id !== line.id) })}
              label={t('goodsBack.line', { seq: line.seq, what: [line.lot?.code, line.hide?.code, line.item.code].filter(Boolean).join(' · '), quantity: quantity(line.quantity, locale, 4), unit: t(`uom.${line.uom}`) })}
            />
          </li>
        ))}
      </ul>
      <h3 className="fw-by-h3">{t('ret.ddtTitle')}</h3>
      <DdtFields draft={draft.ddt} onChange={(ddt) => set({ ddt })} />
    </Frame>
  )
}

function ReturnedDialog({ model, actions, dialog }: Props & { dialog: Extract<ClaimDialog, { kind: 'returned' }> }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const answer = dialog.answer
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('goodsBack.doneTitle', { ddt: answer.ddt.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.(null)}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        <Banner tone="success" title={t('goodsBack.done', { count: answer.moveIds.length, ddt: answer.ddt.number })} />
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            {
              label: t('ret.done.ddt'),
              value: (
                <span className="fw-by-inline">
                  {answer.ddt.number}
                  <Button size="sm" variant="quiet" heldReason={!model.can.files ? t('held.permissionPlain', { permission: 'files.read' }) : answer.ddt.pdfProblem ? t('ret.done.pdfLater') : null} onClick={() => actions?.onOpenDdt?.(answer.ddt.id)}>
                    <ExternalLink size={13} aria-hidden /> {t('goods.openPdf')}
                  </Button>
                </span>
              ),
            },
            ...(model.can.cost ? [{ label: t('credit.expected'), value: answer.claim.expectedCreditAmount != null ? money(answer.claim.expectedCreditAmount, answer.claim.currency, locale) : t('credit.none') }] : []),
          ]}
        />
        {answer.overReserved.length > 0 && <Banner tone="warning" title={t('ret.done.overReserved', { count: answer.overReserved.length })}>{t('ret.done.overReservedBody')}</Banner>}
      </div>
    </Modal>
  )
}

function SimpleDialog({ claim, model, actions, dialog }: Props & { dialog: Extract<ClaimDialog, { kind: 'close' | 'cancel' | 'removeLines' | 'removePhoto' }> }) {
  const t = useT('purchasing-claims')
  const held = simpleHeld(dialog, claim, model.can)
  const heldWords = held ? say(t, held) : null
  if (dialog.kind === 'removePhoto') {
    // B-W2b-14: a draft's photo taken by mistake.
    const index = claim.photos.findIndex((photo) => photo.id === dialog.fileId)
    return (
      <Frame model={model} actions={actions} tone="danger" title={t('evidence.removeTitle', { n: index + 1 })} held={heldWords} label={t('evidence.removeConfirm')}>
        <p className="fw-by-text">{t('evidence.removeBody', { name: claim.photos[index]?.originalName ?? '—' })}</p>
      </Frame>
    )
  }
  if (dialog.kind === 'close') {
    return (
      <Frame model={model} actions={actions} title={t('close.title', { number: claim.number })} held={heldWords} label={t('close.confirm')}>
        <ul className="fw-by-list">
          <li>{t('close.does')}</li>
          {claim.lines.some((line) => line.discrepancy) && <li>{t('close.discrepancies')}</li>}
          {claim.kind === 'RETURN' && linesLeft(claim).length > 0 && <li>{t('close.goodsHere', { count: linesLeft(claim).length })}</li>}
        </ul>
        <Field label={t('close.note')} required hint={t('close.noteHint')}>
          <Textarea rows={3} maxLength={1000} value={dialog.note} onChange={(event) => actions?.onDialog?.({ kind: 'close', note: event.target.value })} autoFocus />
        </Field>
      </Frame>
    )
  }
  if (dialog.kind === 'cancel') {
    return (
      <Frame model={model} actions={actions} tone="danger" title={t('cancel.title', { number: claim.number })} held={heldWords} label={t('cancel.confirm')}>
        <ul className="fw-by-list">
          <li>{t('cancel.does')}</li>
          <li>{t('cancel.kept')}</li>
        </ul>
        <Field label={t('cancel.reason')} required>
          <Textarea rows={3} maxLength={500} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ kind: 'cancel', reason: event.target.value })} autoFocus />
        </Field>
      </Frame>
    )
  }
  const lines = claim.lines.filter((line) => dialog.lineIds.includes(line.id))
  return (
    <Frame model={model} actions={actions} tone="danger" title={t('lines.removeTitle', { count: lines.length })} held={heldWords} label={t('lines.remove', { count: lines.length })}>
      <ul className="fw-by-list">
        {lines.map((line) => (
          <li key={line.id}>{t('lines.removeLine', { seq: line.seq, what: [line.item.code, line.lot?.code, line.hide?.code].filter(Boolean).join(' · ') })}</li>
        ))}
      </ul>
      <p className="fw-by-hint">{t('lines.removeReach')}</p>
    </Frame>
  )
}
