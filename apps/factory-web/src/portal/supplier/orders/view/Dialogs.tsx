'use client'

import type { KeyboardEvent } from 'react'
import { Banner, ChangeReview, Field } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { PORTAL_DECLINE_REASONS, type OrderChanges, type OrderLine, type PortalDeclineReason } from '../api'
import { lineTitle, quantityWords } from '../../../../lib/po-answer/lines'
import { changeItems, MAX_NOTE, MAX_REF, type AnswerProblem, type DeclineDraft } from '../model'
import { useOrderWords } from '../words'

/**
 * The pop-ups of the supplier's orders (design portal.supplier.home pop:confirm-all, portal.supplier.orders pop:decline and
 * pop:version-compare): each a DS Modal, a bottom sheet on a phone; Esc closes and the focus goes back to the opener.
 */

// ── "Confirm PO-2026-0101 as asked?" ─────────────────────────────────────────────────────────────────────────────────
export interface ConfirmAllModel {
  /** One order (Home, the record) or several (the list's bulk action). */
  orders: readonly { id: string; documentNumber: string; lines: readonly Pick<OrderLine, 'id' | 'seq' | 'code' | 'name' | 'description' | 'quantity' | 'uom' | 'needDate' | 'locked' | 'ended'>[] | null; lineCount: number }[]
  /** The order's lines are being read (one order). */
  loading?: boolean
  supplierRef: string
  /** Who confirms (the person signed in). */
  person: string
  busy: boolean
  heldReason: string | null
  problem: AnswerProblem | null
  /** Several orders: how many went through and how many were refused. */
  result?: { confirmed: number; refused: number } | null
}

export interface ConfirmAllActions {
  onRef?: (value: string) => void
  onConfirm?: () => void
  onClose?: () => void
}

export function ConfirmAllDialog({ model, actions }: { model: ConfirmAllModel; actions?: ConfirmAllActions }) {
  const words = useOrderWords()
  const { t, day } = words
  const one = model.orders.length === 1 ? model.orders[0]! : null
  const open = one?.lines?.filter((line) => !line.ended && !line.locked) ?? []
  const count = one ? (one.lines ? open.length : one.lineCount) : model.orders.length
  const title = one ? t('confirmAll.title', { number: one.documentNumber }) : t('confirmAll.titleMany', { count: model.orders.length })
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement) && !model.heldReason && !model.result) {
      event.preventDefault()
      actions?.onConfirm?.()
    }
  }
  return (
    <Modal
      open
      sheet
      size="md"
      onClose={() => actions?.onClose?.()}
      title={title}
      footer={
        model.result ? (
          <Button variant="primary" onClick={() => actions?.onClose?.()}>
            {t('confirmAll.close')}
          </Button>
        ) : (
          <>
            <Button onClick={() => actions?.onClose?.()}>{t('confirmAll.cancel')}</Button>
            <Button variant="primary" heldReason={model.heldReason} onClick={() => actions?.onConfirm?.()}>
              {model.busy ? <Spinner size={14} /> : null} {one ? t('confirmAll.go', { count }) : t('confirmAll.goMany', { count })}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pso-dialog" onKeyDown={onKey}>
        {model.result ? (
          <Banner tone={model.result.refused > 0 ? 'warning' : 'success'} title={t('confirmAll.result', { confirmed: model.result.confirmed, refused: model.result.refused })} />
        ) : (
          <>
            <p className="fw-pso-hint">{one ? t('confirmAll.body') : t('confirmAll.bodyMany')}</p>
            {one ? (
              model.loading || !one.lines ? (
                <div role="status" aria-label={t('state.loading')} className="fw-pso-stack">
                  <Skeleton height={20} />
                  <Skeleton height={20} />
                </div>
              ) : (
                <ul className="fw-pso-confirm-lines" aria-label={t('confirmAll.lines')}>
                  {open.map((line) => (
                    <li key={line.id}>
                      <span className="fw-pso-seq">{t('lines.line', { seq: line.seq })}</span>
                      <span className="fw-pso-confirm-what">{lineTitle(line)}</span>
                      <span className="fw-pso-confirm-ask">{t('lines.askedBy', { quantity: quantityWords(line.quantity, line.uom, words), date: day(line.needDate) })}</span>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <ul className="fw-pso-confirm-lines" aria-label={t('confirmAll.orders')}>
                {model.orders.map((order) => (
                  <li key={order.id}>
                    <span className="fw-pso-confirm-what">{order.documentNumber}</span>
                    <span className="fw-pso-confirm-ask">{t('list.lines', { count: order.lineCount })}</span>
                  </li>
                ))}
              </ul>
            )}
            {one ? (
              <Field label={t('answer.ref')} hint={t('answer.refHint')} error={model.supplierRef.trim().length > MAX_REF ? t('held.ref') : undefined}>
                <Input value={model.supplierRef} onChange={(event) => actions?.onRef?.(event.target.value)} maxLength={MAX_REF * 2} autoComplete="off" />
              </Field>
            ) : null}
            <p className="fw-pso-hint">{t('confirmAll.who', { name: model.person })}</p>
            <p className="fw-pso-hint">{t('answer.noPrices')}</p>
          </>
        )}
        {model.problem ? <Banner tone="danger" title={t(`problem.${model.problem}`)} /> : null}
      </div>
    </Modal>
  )
}

// ── "Decline PO-2026-0101" ───────────────────────────────────────────────────────────────────────────────────────────
export interface DeclineModel {
  documentNumber: string
  reasons: readonly PortalDeclineReason[]
  draft: DeclineDraft
  busy: boolean
  heldReason: string | null
  problem: AnswerProblem | null
}

export function DeclineDialog({ model, onDraft, onSend, onClose }: { model: DeclineModel; onDraft?: (reason: PortalDeclineReason, note: string) => void; onSend?: () => void; onClose?: () => void }) {
  const { t } = useOrderWords()
  const { draft } = model
  const reasons = model.reasons.length > 0 ? model.reasons : PORTAL_DECLINE_REASONS
  const noteHeld = draft.tried && (model.heldReason === 'decline.held.note' || model.heldReason === 'held.note') ? t(model.heldReason) : undefined
  return (
    <Modal
      open
      sheet
      size="sm"
      onClose={() => onClose?.()}
      title={t('decline.title', { number: model.documentNumber })}
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t('decline.back')}</Button>
          <Button variant="danger" heldReason={model.heldReason && model.heldReason !== 'decline.held.note' ? t(model.heldReason) : null} onClick={() => onSend?.()}>
            {model.busy ? <Spinner size={14} /> : null} {t('decline.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pso-dialog">
        <p className="fw-pso-hint">{t('decline.body')}</p>
        <Field label={t('decline.reason')}>
          <Select value={draft.reason} onChange={(event) => onDraft?.(event.target.value as PortalDeclineReason, draft.note)}>
            {reasons.map((reason) => (
              <option key={reason} value={reason}>
                {t(`decline.reasons.${reason}`)}
              </option>
            ))}
          </Select>
        </Field>
        {draft.reason === 'PRICE' ? <p className="fw-pso-hint">{t('decline.priceTalk')}</p> : null}
        <Field label={t(draft.reason === 'OTHER' ? 'decline.noteRequired' : 'decline.note')} required={draft.reason === 'OTHER'} error={noteHeld}>
          <Textarea value={draft.note} onChange={(event) => onDraft?.(draft.reason, event.target.value)} rows={3} honourRows maxLength={MAX_NOTE * 2} />
        </Field>
        <p className="fw-pso-hint">{t('decline.contact')}</p>
        {model.problem ? <Banner tone="danger" title={t(`problem.${model.problem}`)} /> : null}
      </div>
    </Modal>
  )
}

// ── "What changed in version 2" ──────────────────────────────────────────────────────────────────────────────────────
export function ChangesList({ changes }: { changes: OrderChanges }) {
  const { t } = useOrderWords()
  const items = changeItems(changes)
  return (
    <div className="fw-pso-changes">
      {changes.changeNote ? <p className="fw-pso-hint">{t('changes.why', { note: changes.changeNote })}</p> : null}
      {items.length === 0 ? (
        <p className="fw-pso-hint">{t('changes.nothing')}</p>
      ) : (
        <ChangeReview
          tick={false}
          label={t('changes.title', { version: changes.revision })}
          selectedIds={[]}
          onSelectionChange={() => undefined}
          items={items.map((item) => ({
            id: item.id,
            label: item.seq === null ? t('changes.order') : t('lines.line', { seq: item.seq }),
            status: item.kind ? t(`changes.kind.${item.kind}`) : '',
            note: item.sentence,
            selectable: false,
            values: [],
          }))}
        />
      )}
    </div>
  )
}

export interface VersionModel {
  revision: number
  state: 'loading' | 'error' | 'ready'
  changes: OrderChanges | null
}

export function VersionDialog({ model, onClose, onRetry }: { model: VersionModel; onClose?: () => void; onRetry?: () => void }) {
  const { t } = useOrderWords()
  return (
    <Modal open sheet size="lg" onClose={() => onClose?.()} title={t('changes.title', { version: model.revision })} footer={<Button onClick={() => onClose?.()}>{t('changes.close')}</Button>}>
      <div className="fw-pso-dialog">
        {model.state === 'loading' ? (
          <div role="status" aria-label={t('state.loading')} className="fw-pso-stack">
            <Skeleton height={48} />
            <Skeleton height={48} />
          </div>
        ) : model.state === 'error' || !model.changes ? (
          <div className="fw-pstate" role="alert">
            <span>{t('changes.failed')}</span>
            {onRetry ? <Button onClick={onRetry}>{t('state.retry')}</Button> : null}
          </div>
        ) : (
          <ChangesList changes={model.changes} />
        )}
      </div>
    </Modal>
  )
}
