'use client'

import Link from 'next/link'
import { Ban, CheckCircle2, FilePlus2 } from 'lucide-react'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayAt, money, quantity, unitPrice } from '../../../_shared/buying/model'
import { SET_ASIDE, type SetAsideReason } from '../api'
import { cardKey, confirmHeld, existingDraftOf, intoOf, orderHref, rejectConfirmHeld, say, type RequestsActions, type RequestsModel } from '../model'

/**
 * "Draft POs for n" (the same dialog as planning's Draft purchase orders: one card per supplier and delivery site, its
 * open draft or a new one, its lines with their warnings, the value with the cost grain; the requests that cannot be
 * drafted listed first, since the API refuses the whole batch while one is held; then the drafts made — nothing is sent),
 * and "Reject with reason" (planning's set-aside of the plan lines: a reason, a note; OTHER needs the note).
 */
export function DraftPosDialog({ model, actions }: { model: RequestsModel; actions?: RequestsActions }) {
  const t = useT('purchasing-requests')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const draft = model.draft!
  const close = () => actions?.draft?.onClose?.()

  if (draft.result) {
    const lines = draft.result.lines.length
    return (
      <Modal open onClose={close} title={t('draft.doneTitle')} size="md" footer={<Button size="sm" variant="primary" onClick={close}>{t('common.done')}</Button>}>
        <div className="fw-by-dialog" role="status">
          <Banner tone="success" title={t('draft.doneBody', { lines, count: draft.result.orders.length })} />
          <ul className="fw-by-checks">
            {draft.result.orders.map((order) => (
              <li key={order.id} className="fw-by-check">
                <CheckCircle2 size={16} className="fw-by-ico is-ok" aria-hidden />
                <span className="fw-by-check-body">
                  <Link className="fw-by-link" href={orderHref(model.prefix, order.id)}>
                    {order.number}
                  </Link>
                  <span className="fw-by-hint">{t(order.created ? 'draft.created' : 'draft.added', { lines: order.lineIds.length, count: order.lineCount })}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="fw-by-hint">{t('draft.nothingSent')}</p>
        </div>
      </Modal>
    )
  }

  const preview = draft.preview.status === 'ready' ? draft.preview.value : null
  const held = confirmHeld(draft, model.offline)
  const orders = preview?.cards.length ?? 0
  const materialOf = (requestId: string) => {
    const row = model.rows.items?.find((entry) => entry.id === requestId)
    return row ? `${row.item.code}${row.colour ? ` · ${row.colour.name}` : ''}` : t('draft.aRequest')
  }

  return (
    <Modal
      open
      onClose={close}
      title={t('draft.title', { count: draft.requestIds.length })}
      subtitle={preview ? t('draft.subtitle', { lines: preview.cards.reduce((sum, card) => sum + card.lines.length, 0), count: orders }) : undefined}
      size="xl"
      footer={
        <>
          <span className="fw-by-hint">{t('draft.nothingSent')}</span>
          <span className="grow" />
          <Button size="sm" onClick={close} heldReason={draft.busy ? t('held.busy') : null}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? say(t, held) : null} onClick={() => actions?.draft?.onConfirm?.()} aria-keyshortcuts="Enter">
            {draft.busy ? <Spinner size={12} /> : <FilePlus2 size={13} aria-hidden />} {t('draft.confirm', { count: orders })}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        {draft.preview.status === 'loading' && (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('draft.reading')}
          </p>
        )}
        {draft.preview.status === 'error' && (
          <Banner tone="danger" title={t('draft.previewFailed')} action={<Button size="sm" onClick={() => actions?.draft?.onRetry?.()}>{t('common.retry')}</Button>}>
            {t(draft.preview.problem)}
          </Banner>
        )}
        {draft.problem && <Banner tone="danger" title={say(t, draft.problem)} />}
        {preview && preview.held.length > 0 && (
          <Banner
            tone="warning"
            title={t('draft.heldTitle', { count: preview.held.length })}
            action={
              <Button size="sm" onClick={() => actions?.draft?.onLeaveOutHeld?.()}>
                {t('draft.leaveOut', { count: preview.held.length })}
              </Button>
            }
          >
            <ul className="fw-by-list">
              {preview.held.map((entry) => (
                <li key={entry.requestId}>
                  <b>{materialOf(entry.requestId)}</b> — {t(`hold.${entry.code}`, { supplier: model.rows.items?.find((row) => row.id === entry.requestId)?.supplier?.name ?? t('supplier.theSupplier'), material: materialOf(entry.requestId) })}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {preview && preview.cards.length === 0 && preview.held.length === 0 && <p className="fw-by-hint">{t('draft.nothing')}</p>}
        {preview && (
          <div className="fw-rq-cards">
            {preview.cards.map((card) => {
              const key = cardKey(card)
              const existing = existingDraftOf(card)
              const into = intoOf(card, draft.into)
              return (
                <Card key={key} padded>
                  <div className="fw-by-stack">
                    <div className="fw-by-card-head">
                      <h3 className="fw-by-h3">
                        {card.supplier.name}
                        {card.supplier.status !== 'ACTIVE' && <Tag tone={card.supplier.status === 'PROSPECT' ? 'warning' : 'danger'}>{t(`party.${card.supplier.status === 'PROSPECT' ? 'PROSPECT' : 'OTHER'}`)}</Tag>}
                      </h3>
                      <span className="fw-by-hint">{t('draft.cardMeta', { site: card.site.code, count: card.lines.length, currency: card.currency })}</span>
                    </div>
                    {!card.mayDraft && <Banner tone="danger" title={t('draft.noRight', { supplier: card.supplier.name, site: card.site.code })} />}
                    <SummaryTable
                      label={card.supplier.name}
                      density="compact"
                      stackOnPhone
                      columns={[t('col.material'), t('col.quantity'), t('col.need'), ...(model.can.cost ? [t('detail.price'), t('col.value')] : [])]}
                      align={['left', 'right', 'left', ...(model.can.cost ? (['right', 'right'] as const) : [])]}
                      rows={card.lines.map((line) => ({
                        id: line.requestId,
                        cells: [
                          <span key="m" className="fw-by-cell">
                            <span>
                              {line.item.code} {line.item.name}
                              {line.colour ? ` · ${line.colour.name}` : ''}
                            </span>
                            {line.warnings.map((warning) => (
                              <span key={warning.code} className="fw-by-cell-sub fw-by-warning">
                                {t(`warning.${warning.code}`)}
                              </span>
                            ))}
                          </span>,
                          `${quantity(line.quantity, locale)} ${t(`uom.${line.uom}`)}`,
                          formatDate(dayAt(line.needDate), place),
                          ...(model.can.cost ? [line.unitPrice ? unitPrice(line.unitPrice, card.currency, locale) : t('detail.noPrice'), money(line.expectedAmount ?? null, card.currency, locale)] : []),
                        ],
                      }))}
                    />
                    {model.can.cost && <p className="fw-by-text">{t('draft.cardTotal', { amount: money(card.expectedAmount ?? null, card.currency, locale) })}</p>}
                    {existing ? (
                      <div className="fw-by-fields" role="radiogroup" aria-label={t('draft.where', { supplier: card.supplier.name })}>
                        <RadioCard
                          name={`into-${key}`}
                          checked={into === 'existing'}
                          selected={into === 'existing'}
                          onChange={() => actions?.draft?.onInto?.(key, 'existing')}
                          title={t('draft.addTo', { number: existing.number })}
                          description={t('draft.addToHint', { count: existing.lineCount })}
                        />
                        <RadioCard name={`into-${key}`} checked={into === 'new'} selected={into === 'new'} onChange={() => actions?.draft?.onInto?.(key, 'new')} title={t('draft.newDraft')} description={t('draft.newDraftHint')} />
                      </div>
                    ) : (
                      <p className="fw-by-hint">{t('draft.willCreate')}</p>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
        <p className="fw-by-hint">{t('draft.checksLater')}</p>
      </div>
    </Modal>
  )
}

export function RejectDialog({ model, actions }: { model: RequestsModel; actions?: RequestsActions }) {
  const t = useT('purchasing-requests')
  const reject = model.reject!
  const rows = (model.rows.items ?? []).filter((row) => reject.requestIds.includes(row.id))
  const held = rejectConfirmHeld(reject)
  const noteNeeded = reject.reason === 'OTHER' && reject.note.trim() === ''
  return (
    <Modal
      open
      onClose={() => actions?.reject?.onClose?.()}
      title={t('reject.title', { count: rows.length })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.reject?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? say(t, held) : null} onClick={() => actions?.reject?.onConfirm?.()}>
            {reject.busy ? <Spinner size={12} /> : <Ban size={13} aria-hidden />} {t('reject.confirm', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        <p className="fw-by-hint">{t('reject.body')}</p>
        <Field label={t('reject.reason')} required>
          <Select size="sm" value={reject.reason} onChange={(event) => actions?.reject?.onReason?.(event.target.value as SetAsideReason | '')}>
            <option value="">{t('reject.pick')}</option>
            {SET_ASIDE.map((reason) => (
              <option key={reason} value={reason}>
                {t(`reason.${reason}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('reject.note')} hint={reject.reason === 'OTHER' ? t('reject.noteOther') : t('reject.noteHint')} error={noteNeeded && reject.note.length > 0 ? t('reject.noteNeeded') : undefined}>
          <Textarea rows={3} maxLength={500} value={reject.note} onChange={(event) => actions?.reject?.onNote?.(event.target.value)} />
        </Field>
        <ul className="fw-by-list">
          {rows.map((row) => (
            <li key={row.id}>
              {row.item.code} {row.item.name}
              {row.colour ? ` · ${row.colour.name}` : ''} — {row.site.code}
            </li>
          ))}
        </ul>
        <p className="fw-by-hint">{t('reject.planSees')}</p>
        {reject.problem && <Banner tone="danger" title={say(t, reject.problem)} />}
      </div>
    </Modal>
  )
}
