'use client'

import { useEffect } from 'react'
import { Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Kbd, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { RequestRow, StyleDetail } from '../api'
import { CHANGE_EFFECTS, CHANGE_PRIORITIES, linkable, newOrderHeld, type ChangeEffect, type ChangePriority, type ChangesCan, type NewOrderDraft, type Notice, type Phrase } from '../model'
import { NoticeLine, RequestPill, useWords } from '../parts'
import { StylePicker, type StylePick } from './StylePicker'

/** New change order: the style, what and why, when it takes effect, the requests it carries. */
export interface NewOrderModel {
  draft: NewOrderDraft
  styles: StylePick
  style: { item: StyleDetail | null; reading: boolean; problem: string | null }
  /** The style's requests a change order may carry (open, in review, accepted; in no live change order). */
  requests: { items: RequestRow[] | null; problem: string | null } | null
  busy: boolean
  notice: Notice | null
  lines: readonly Phrase[]
  offline: boolean
}

export interface NewOrderActions {
  onDraft?: (patch: Partial<NewOrderDraft>) => void
  onFindStyles?: (q: string) => void
  onPickStyle?: (styleId: string | null) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * New change order (the edit rule's "Products › Changes (New change order)"; the band's ⋯ and a request's "Write a change
 * order"): a DRAFT from the style's released revision with an ECO number, carrying the requests ticked (an open one goes
 * into review). Its draft revision, approvers and work in progress are then set on its record. ⌘↵ writes it.
 */
export function NewOrderDialog({ model, can, actions }: { model: NewOrderModel; can: ChangesCan; actions?: NewOrderActions }) {
  const { t, say } = useWords()
  const draft = model.draft
  const style = model.style.item
  const held = newOrderHeld(draft, style, can, model.offline)
  const heldText = model.busy ? t('common.working') : say(held)
  const released = style?.revisions.find((revision) => revision.status === 'RELEASED') ?? null
  const requests = (model.requests?.items ?? []).filter(linkable)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held && !model.busy) {
        event.preventDefault()
        actions?.onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, model.busy, actions])

  const toggle = (id: string, on: boolean) => actions?.onDraft?.({ requestIds: on ? [...draft.requestIds, id] : draft.requestIds.filter((one) => one !== id) })
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('newOrder.title')}
      size="lg"
      footer={
        <>
          <span className="fw-chg-hint">{t('newOrder.carries', { count: draft.requestIds.length })}</span>
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onSubmit?.()} aria-keyshortcuts="Meta+Enter">
            {t('newOrder.submit')}
            <span className="fw-chg-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <div className="fw-chg-form">
        <NoticeLine notice={model.notice} lines={model.lines} />
        <div className="fw-chg-form-grid">
          <StylePicker pick={model.styles} style={style} styleId={draft.styleId} held={can.styles ? null : t('held.needsRight', { right: t('right.product.styles.view') })} onFind={actions?.onFindStyles} onPick={actions?.onPickStyle} />
          <Field label={t('newOrder.from')} hint={t('newOrder.fromHint')}>
            <p className="fw-chg-text">{style ? (released ? t('revision.label', { revision: released.revision }) : t('refusal.NO_RELEASED_REVISION')) : '—'}</p>
          </Field>
          <Field label={t('col.priority')}>
            <Select size="sm" value={draft.priority} onChange={(event) => actions?.onDraft?.({ priority: event.target.value as ChangePriority })}>
              {CHANGE_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`priority.${priority}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('field.effect')} hint={t('newOrder.effectHint')}>
            <Select size="sm" value={draft.effect} onChange={(event) => actions?.onDraft?.({ effect: event.target.value as ChangeEffect })}>
              {CHANGE_EFFECTS.map((effect) => (
                <option key={effect} value={effect}>
                  {t(`effect.${effect}`)}
                </option>
              ))}
            </Select>
          </Field>
          {draft.effect === 'DATE' && (
            <Field label={t('field.effectiveDate')} required>
              <DateField value={draft.effectiveDate} onChange={(value) => actions?.onDraft?.({ effectiveDate: value ?? '' })} />
            </Field>
          )}
          <div className="fw-chg-wide">
            <Field label={t('new.what')} required>
              <Input size="sm" maxLength={200} value={draft.title} onChange={(event) => actions?.onDraft?.({ title: event.target.value })} placeholder={t('new.whatPlaceholder')} />
            </Field>
          </div>
          <div className="fw-chg-wide">
            <Field label={t('new.why')} required>
              <Textarea rows={3} maxLength={4000} value={draft.reason} onChange={(event) => actions?.onDraft?.({ reason: event.target.value })} />
            </Field>
          </div>
          <div className="fw-chg-wide">
            <Field label={t('newOrder.requests')} hint={t('newOrder.requestsHint')}>
              {!style ? (
                <p className="fw-chg-hint">{t('new.heldStyle')}</p>
              ) : model.requests?.items === null ? (
                <p className="fw-chg-hint" role="status">
                  <Spinner size={14} /> {t('common.loading')}
                </p>
              ) : model.requests?.problem ? (
                <p className="fw-chg-hint">{t(model.requests.problem)}</p>
              ) : requests.length === 0 ? (
                <p className="fw-chg-hint">{t('newOrder.noRequests')}</p>
              ) : (
                <ul className="fw-chg-picks">
                  {requests.map((request) => (
                    <li key={request.id} className="fw-chg-pick">
                      <Checkbox checked={draft.requestIds.includes(request.id)} onChange={(event) => toggle(request.id, event.target.checked)} label={`${request.number ?? t('row.floorNoNumber')} · ${request.title}`} />
                      <RequestPill status={request.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  )
}
