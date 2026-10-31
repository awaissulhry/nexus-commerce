'use client'

import Link from 'next/link'
import { AlertTriangle, CalendarClock, CheckCircle2, FilePlus2, Search, Send, XCircle } from 'lucide-react'
import { Banner, Card, DateField, Field, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayAt, money, quantity } from '../../../_shared/buying/model'
import { SET_ASIDE, type SetAsideReason } from '../api'
import { draftCards, moveFirmProblem, MRP_NAMESPACE, runSeconds, sendable, type DraftDialog, type PlanActions, type PlanModel } from '../model'
import '../mrp.css'

/**
 * The plan's dialogs: Draft purchase orders (one card per supplier: its lines, its open draft or a new one, the lines
 * with no supplier and a supplier to pick, then the drafts made — nothing is sent), Set aside n lines (a reason, a note),
 * Run history, What the plan counts, and the keyboard keys.
 */
export function PlanDialogs({ model, actions, ownKeys }: { model: PlanModel; actions?: PlanActions; ownKeys: readonly ListKey[] }) {
  const t = useT('buying')
  const lists = useT('lists')
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'draft') return <DraftPurchaseOrders draft={dialog.draft} model={model} actions={actions} />
  if (dialog.kind === 'setAside') return <SetAside model={model} actions={actions} />
  if (dialog.kind === 'history') return <History model={model} actions={actions} />
  if (dialog.kind === 'moveFirm') return <MoveFirm model={model} actions={actions} />
  if (dialog.kind === 'explainer') {
    return (
      <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('plan.explainer.title')} size="md" footer={<Button size="sm" variant="primary" onClick={() => actions?.onCloseDialog?.()}>{t('common.close')}</Button>}>
        <div className="fw-by-dialog">
          <p className="fw-by-text">{t('plan.explainer.body')}</p>
          <ul className="fw-by-list">
            {['need', 'usable', 'held', 'onOrder', 'buy', 'orderBy', 'never'].map((part) => (
              <li key={part}>{t(`plan.explainer.${part}`)}</li>
            ))}
          </ul>
        </div>
      </Modal>
    )
  }
  return (
    <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('common.shortcuts')} size="sm">
      <ul className="fw-by-list">
        {listKeys(ownKeys, true).map((entry) => (
          <li key={entry.does}>
            <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
        <li>
          <b>⌘ ↑ ⌘ ↓</b> — {t('why.walk')}
        </li>
      </ul>
    </Modal>
  )
}

function DraftPurchaseOrders({ draft, model, actions }: { draft: DraftDialog; model: PlanModel; actions?: PlanActions }) {
  const t = useT('buying')
  const w = useT(MRP_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const cards = draftCards(draft.lines, draft.drafts ?? [])
  const noSupplier = cards.find((card) => card.supplierId === null)
  const missing = noSupplier ? noSupplier.lines.filter((line) => !draft.suppliers[line.id]).length : 0
  const orders = new Set(cards.filter((card) => card.supplierId !== null).map((card) => card.supplierId))
  for (const supplier of Object.values(draft.suppliers)) orders.add(supplier.id)
  const blocked = [...Object.values(draft.suppliers)].filter((supplier) => supplier.status === 'BLOCKED' || supplier.status === 'ARCHIVED')
  const held = draft.busy ? t('held.busy') : draft.drafts === null && !draft.draftsProblem ? t('held.loading') : missing > 0 ? t('plan.draft.pickFirst', { count: missing }) : blocked.length > 0 ? t('plan.draft.blocked', { supplier: blocked[0]!.legalName }) : cards.length === 0 ? t('held.noBuyLine') : null

  if (draft.result && draft.send) return <SendDrafts draft={draft} model={model} actions={actions} />
  if (draft.result) {
    return (
      <Modal
        open
        onClose={() => actions?.onCloseDialog?.()}
        title={t('plan.draft.doneTitle')}
        size="md"
        footer={
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
              {t('common.done')}
            </Button>
            <Button size="sm" variant="primary" heldReason={model.can.poSend ? null : w('held.noSend')} onClick={() => actions?.onSendDrafts?.()}>
              <Send size={13} aria-hidden /> {w('send.review', { count: draft.result.orders.length })}
            </Button>
          </>
        }
      >
        <div className="fw-by-dialog" role="status">
          <Banner tone="success" title={t('plan.draft.doneBody', { lines: draft.result.lines.length, count: draft.result.orders.length })} />
          <ul className="fw-by-checks">
            {draft.result.orders.map((order) => (
              <li key={order.id} className="fw-by-check">
                <CheckCircle2 size={16} className="fw-by-ico is-ok" aria-hidden />
                <span className="fw-by-check-body">
                  <Link className="fw-by-link" href={`${model.prefix}/purchasing/orders/${order.id}`}>
                    {order.number}
                  </Link>
                  <span className="fw-by-hint">{t(order.created ? 'plan.draft.created' : 'plan.draft.added', { lines: order.lineIds.length, count: order.lineCount })}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="fw-by-hint">{t('plan.draft.nothingSent')}</p>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('plan.draft.title')}
      subtitle={t('plan.draft.subtitle', { lines: cards.reduce((sum, card) => sum + card.lines.length, 0), count: orders.size })}
      size="xl"
      footer={
        <>
          <span className="fw-by-hint">{t('plan.draft.nothingSent')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()} heldReason={draft.busy ? t('held.busy') : null}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.draft?.onCreate?.()} aria-keyshortcuts="Enter">
            {draft.busy ? <Spinner size={12} /> : <FilePlus2 size={13} aria-hidden />} {t('plan.draft.create', { count: orders.size })}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        {draft.draftsProblem && <Banner tone="warning" title={t('plan.draft.draftsFailed')}>{t(draft.draftsProblem)}</Banner>}
        {draft.problem && <Banner tone="danger" title={t(draft.problem.key, draft.problem.params)} />}
        {cards.map((card) => (
          <Card key={card.supplierId ?? 'none'} padded>
            <div className="fw-by-stack">
              <div className="fw-by-card-head">
                <h3 className="fw-by-h3">{card.supplierName ?? t('plan.draft.noSupplierCard')}</h3>
                <span className="fw-by-hint">{t('plan.draft.cardLines', { count: card.lines.length })}</span>
              </div>
              <SummaryTable
                label={card.supplierName ?? t('plan.draft.noSupplierCard')}
                density="compact"
                stackOnPhone
                columns={[t('plan.col.material'), t('plan.col.buy'), t('plan.col.need'), ...(model.can.cost ? [t('plan.col.value')] : []), ...(card.supplierId === null ? [t('plan.draft.supplierCol')] : [])]}
                align={['left', 'right', 'left', ...(model.can.cost ? (['right'] as const) : []), 'left']}
                rows={card.lines.map((line) => ({
                  id: line.id,
                  cells: [
                    `${line.item.code} ${line.item.name}${line.colour ? ` · ${line.colour.name}` : ''}`,
                    `${quantity(line.suggestedQuantity, locale)} ${t(`uom.${line.suggestedUom}`)}${line.estimatedHides !== null && line.suggestedUom !== 'HIDE' ? ` (${t('plan.hides', { count: line.estimatedHides })})` : ''}`,
                    formatDate(dayAt(line.needDate), place),
                    ...(model.can.cost ? [money(line.expectedAmount ?? null, line.currency, locale)] : []),
                    ...(card.supplierId === null
                      ? [
                          <Select
                            key="supplier"
                            size="sm"
                            aria-label={t('plan.draft.pickSupplier', { material: line.item.code })}
                            value={draft.suppliers[line.id]?.id ?? ''}
                            onChange={(event) => actions?.draft?.onPickSupplier?.(line.id, draft.supplierOptions?.find((option) => option.id === event.target.value) ?? null)}
                          >
                            <option value="">{t('plan.draft.pickSupplierEmpty')}</option>
                            {(draft.supplierOptions ?? []).map((option) => (
                              <option key={option.id} value={option.id} disabled={option.status === 'BLOCKED' || option.status === 'ARCHIVED'}>
                                {option.legalName}
                                {option.status !== 'ACTIVE' ? ` (${t(`party.${option.status}`)})` : ''}
                              </option>
                            ))}
                          </Select>,
                        ]
                      : []),
                  ],
                }))}
              />
              {card.supplierId === null && (
                <Field label={t('plan.draft.findSupplier')} hint={t('plan.draft.findSupplierHint')}>
                  <Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} value={draft.supplierQuery} onChange={(event) => actions?.draft?.onSupplierQuery?.(event.target.value)} />
                </Field>
              )}
              {card.supplierId !== null && card.draft && (
                <div className="fw-by-fields" role="radiogroup" aria-label={t('plan.draft.where', { supplier: card.supplierName ?? '' })}>
                  <RadioCard
                    name={`into-${card.supplierId}`}
                    checked={draft.into[card.supplierId] === undefined || draft.into[card.supplierId] === card.draft.id}
                    selected={draft.into[card.supplierId] === undefined || draft.into[card.supplierId] === card.draft.id}
                    onChange={() => actions?.draft?.onInto?.(card.supplierId!, card.draft!.id)}
                    title={t('plan.draft.addTo', { number: card.draft.number })}
                    description={t('plan.draft.addToHint', { count: card.draft.lineCount })}
                  />
                  <RadioCard
                    name={`into-${card.supplierId}`}
                    checked={draft.into[card.supplierId] === null}
                    selected={draft.into[card.supplierId] === null}
                    onChange={() => actions?.draft?.onInto?.(card.supplierId!, null)}
                    title={t('plan.draft.newDraft')}
                    description={t('plan.draft.newDraftHint')}
                  />
                </div>
              )}
              {card.supplierId !== null && !card.draft && draft.drafts !== null && <p className="fw-by-hint">{t('plan.draft.willCreate')}</p>}
            </div>
          </Card>
        ))}
        <p className="fw-by-hint">{t('plan.draft.checksLater')}</p>
      </div>
    </Modal>
  )
}

function SetAside({ model, actions }: { model: PlanModel; actions?: PlanActions }) {
  const t = useT('buying')
  const dialog = model.dialog as Extract<NonNullable<PlanModel['dialog']>, { kind: 'setAside' }>
  const lines = model.plan.status === 'ready' ? model.plan.value.lines.filter((line) => dialog.lineIds.includes(line.id)) : []
  const noteNeeded = dialog.reason === 'OTHER' && dialog.note.trim() === ''
  const held = dialog.busy ? t('held.busy') : !dialog.reason ? t('plan.aside.pickReason') : noteNeeded ? t('plan.aside.noteNeeded') : lines.length === 0 ? t('held.noneOpen') : null
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('plan.aside.title', { count: lines.length })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.setAside?.onConfirm?.()}>
            {dialog.busy && <Spinner size={12} />} {t('plan.aside.confirm', { count: lines.length })}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        <p className="fw-by-hint">{t('plan.aside.body')}</p>
        <Field label={t('plan.aside.reason')} required>
          <Select size="sm" value={dialog.reason} onChange={(event) => actions?.setAside?.onReason?.(event.target.value as SetAsideReason)}>
            <option value="">{t('plan.aside.pick')}</option>
            {SET_ASIDE.map((reason) => (
              <option key={reason} value={reason}>
                {t(`plan.aside.reasons.${reason}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('plan.aside.note')} hint={dialog.reason === 'OTHER' ? t('plan.aside.noteOther') : t('plan.aside.noteHint')} error={noteNeeded && dialog.note.length > 0 ? t('plan.aside.noteNeeded') : undefined}>
          <Textarea rows={3} maxLength={500} value={dialog.note} onChange={(event) => actions?.setAside?.onNote?.(event.target.value)} />
        </Field>
        <ul className="fw-by-list">
          {lines.map((line) => (
            <li key={line.id}>
              {line.item.code} {line.item.name}
              {line.colour ? ` · ${line.colour.name}` : ''}
            </li>
          ))}
        </ul>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem.key, dialog.problem.params)} />}
      </div>
    </Modal>
  )
}

function History({ model, actions }: { model: PlanModel; actions?: PlanActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const dialog = model.dialog as Extract<NonNullable<PlanModel['dialog']>, { kind: 'history' }>
  const tone = (status: string) => (status === 'DONE' ? 'success' : status === 'FAILED' ? 'danger' : status === 'RUNNING' ? 'info' : 'neutral')
  return (
    <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('plan.history')} size="xl" footer={<Button size="sm" variant="primary" onClick={() => actions?.onCloseDialog?.()}>{t('common.close')}</Button>}>
      {dialog.problem ? (
        <Banner tone="danger" title={t(dialog.problem)} />
      ) : dialog.runs === null ? (
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : dialog.runs.length === 0 ? (
        <p className="fw-by-hint">{t('plan.strip.none')}</p>
      ) : (
        <SummaryTable
          label={t('plan.history')}
          density="compact"
          stackOnPhone
          columns={[t('plan.hist.started'), t('plan.hist.trigger'), t('plan.hist.took'), t('plan.hist.orderLines'), t('plan.hist.lines'), t('plan.hist.status')]}
          align={['left', 'left', 'right', 'right', 'right', 'left']}
          rows={dialog.runs.map((run) => ({
            id: run.id,
            cells: [
              formatDateTime(run.startedAt, place),
              t(`plan.trigger.${run.trigger}`),
              runSeconds(run) === null ? '—' : t('plan.strip.seconds', { count: runSeconds(run)! }),
              String(run.orderLines),
              t('plan.strip.linesShort', { lines: run.requirements, short: run.short }),
              <span key="status" className="fw-by-inline">
                <Pill tone={tone(run.status)}>{t(`plan.runStatus.${run.status}`)}</Pill>
                {run.status === 'FAILED' && <span className="fw-by-hint">{t('plan.hist.failedNote')}</span>}
              </span>,
            ],
          }))}
        />
      )}
    </Modal>
  )
}

/**
 * Send n (design pop:draft-result, W2a "review and send them one after another"; B-W2a-52's send-checks and send-many):
 * one card per draft just made — ready, or what blocks it in words (the PO page fixes it), its warnings, who receives it
 * and the confirm-by default — then each ready order sent on its own (its mail, its confirm link); a refused one keeps
 * its reason. Mail goes out through the factory's mail provider; nothing is sent before the click.
 */
function SendDrafts({ draft, model, actions }: { draft: DraftDialog; model: PlanModel; actions?: PlanActions }) {
  const t = useT('buying')
  const w = useT(MRP_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const send = draft.send!
  const ready = sendable(send.cards)
  const numberOf = (id: string) => draft.result?.orders.find((order) => order.id === id)?.number ?? '—'
  const held = !model.can.poSend ? w('held.noSend') : send.busy ? t('held.busy') : send.cards === null ? t('held.loading') : ready.length === 0 ? w('held.noneReady') : null
  if (send.outcomes) {
    const sent = send.outcomes.filter((outcome) => outcome.outcome === 'SENT')
    return (
      <Modal open onClose={() => actions?.onCloseDialog?.()} title={w('send.doneTitle')} size="md" footer={<Button size="sm" variant="primary" onClick={() => actions?.onCloseDialog?.()}>{t('common.done')}</Button>}>
        <div className="fw-by-dialog" role="status">
          <Banner tone={sent.length === send.outcomes.length ? 'success' : 'warning'} title={w('send.doneBody', { sent: sent.length, count: send.outcomes.length })} />
          <ul className="fw-by-checks">
            {send.outcomes.map((outcome) => (
              <li key={outcome.id} className="fw-by-check">
                {outcome.outcome === 'SENT' ? <CheckCircle2 size={16} className="fw-by-ico is-ok" aria-hidden /> : <XCircle size={16} className="fw-by-ico is-blocked" aria-hidden />}
                <span className="fw-by-check-body">
                  <Link className="fw-by-link" href={`${model.prefix}/purchasing/orders/${outcome.id}`}>
                    {outcome.number ?? numberOf(outcome.id)}
                  </Link>
                  <span className="fw-by-hint">{outcome.outcome === 'SENT' ? w('send.sentOne') : w(`send.refused.${outcome.refused?.code === 'conflict' ? 'conflict' : outcome.refused?.code === 'forbidden' ? 'forbidden' : 'other'}`)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={w('send.title', { count: send.cards?.length ?? draft.result?.orders.length ?? 0 })}
      subtitle={w('send.subtitle')}
      size="xl"
      footer={
        <>
          <span className="fw-by-hint">{w('send.mailNote')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()} heldReason={send.busy ? t('held.busy') : null}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSendConfirm?.()}>
            {send.busy ? <Spinner size={12} /> : <Send size={13} aria-hidden />} {w('send.confirm', { count: ready.length })}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        {send.problem && <Banner tone="danger" title={w('send.failed')}>{t(send.problem)}</Banner>}
        {send.cards === null ? (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : (
          <div className="fw-mrp-send">
            {send.cards.map((card) => {
              const blocks = card.checks.filter((check) => check.severity === 'BLOCKS')
              const warnings = card.checks.filter((check) => check.severity === 'WARNING')
              return (
                <Card key={card.id} padded>
                  <div className="fw-by-stack">
                    <div className="fw-by-card-head">
                      <h3 className="fw-by-h3">
                        <Link className="fw-by-link" href={`${model.prefix}/purchasing/orders/${card.id}`}>
                          {card.number ?? numberOf(card.id)}
                        </Link>
                      </h3>
                      <Pill tone={card.ready ? 'success' : 'danger'}>{card.ready ? w('send.ready') : w('send.notReady')}</Pill>
                    </div>
                    {card.recipient ? <p className="fw-by-hint">{w('send.to', { name: card.recipient.name, email: card.recipient.email ?? '—' })}</p> : null}
                    {card.confirmBy ? <p className="fw-by-hint">{w('send.confirmBy', { time: formatDateTime(card.confirmBy, place) })}</p> : null}
                    {card.refused && <Banner tone="danger" title={w('send.cardRefused')} />}
                    {blocks.length + warnings.length > 0 && (
                      <ul className="fw-by-checks">
                        {[...blocks, ...warnings].map((check) => (
                          <li key={`${check.code}-${check.path}`} className="fw-by-check">
                            {check.severity === 'BLOCKS' ? <XCircle size={16} className="fw-by-ico is-blocked" aria-hidden /> : <AlertTriangle size={16} className="fw-by-ico is-warning" aria-hidden />}
                            <span className="fw-by-check-body">{t(`po.check.${check.code}`)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {!card.ready && <p className="fw-by-hint">{w('send.fixOnPo')}</p>}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Move the firm planned order (MOVE_FIRM, from Short on open work orders): the same quantity, an earlier day. */
function MoveFirm({ model, actions }: { model: PlanModel; actions?: PlanActions }) {
  const t = useT('buying')
  const w = useT(MRP_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const dialog = model.dialog as Extract<NonNullable<PlanModel['dialog']>, { kind: 'moveFirm' }>
  const line = model.plan.status === 'ready' ? (model.plan.value.lines.find((entry) => entry.id === dialog.requirementId) ?? null) : null
  const today = model.today ?? dialog.date
  const problem = moveFirmProblem(line, dialog.date, today)
  const held = dialog.busy ? t('held.busy') : !model.canFirm ? w('held.noFirm') : problem ? w(problem) : null
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={w('move.title')}
      subtitle={line ? `${line.item.code} ${line.item.name}${line.colour ? ` · ${line.colour.name}` : ''}` : undefined}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.moveFirm?.onConfirm?.()}>
            {dialog.busy ? <Spinner size={12} /> : <CalendarClock size={13} aria-hidden />} {w('move.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        {line?.firm ? (
          <p className="fw-by-text">{w('move.body', { quantity: quantity(line.firm.quantity, locale), unit: t(`uom.${line.firm.uom}`), date: formatDate(dayAt(line.firm.date), place) })}</p>
        ) : (
          <Banner tone="warning" title={w('held.notFirm')} />
        )}
        <Field label={w('move.date')} hint={w('move.hint')}>
          <DateField value={dialog.date} min={today} onChange={(value) => actions?.moveFirm?.onDate?.(value)} locale={INTL_LOCALE[locale]} ariaLabel={w('move.date')} />
        </Field>
        {dialog.problem && <Banner tone="danger" title={w(dialog.problem)} />}
      </div>
    </Modal>
  )
}
