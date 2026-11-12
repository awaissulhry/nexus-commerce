'use client'

import { useEffect, useState } from 'react'
import { Banner, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, NumberStepper, RadioCard, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, ReviewChangesModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { Allocation } from '../../api'
import { laneRefOf } from '../../model'
import type { AllocationActions, AllocationViewModel, CardOperations, KitDialog, Loaded, OrdersDialog, SwitchDialog } from '../../view-model'
import type { AllocationWorkshops } from '../api'
import { dayWords, holdWords, kindWords, kitFacts, kitSentence, laterWords, leftOutWords, madeWords, partChange, quantityWords, switchHeld, verdictWords, warningWords, workshopOf, type Words } from '../model'

/**
 * The W2b dialogs of Lines & subcontractors (SCR-126; B-W2b-338): the kit timing of a drop on a workshop (design
 * pop:kit-timing), one operation in-house or outside (board#4), "Create subcontract orders (n)" (page.h#1, a
 * ReviewChangesModal over the preview), and the card's operations section. Every word is the page's; the API's English
 * is said again from codes (depth/model.ts).
 */

const ready = <T,>(loaded: { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T } | undefined): T | null => (loaded?.status === 'ready' ? loaded.value : null)

function Reading({ label }: { label: string }) {
  return (
    <div className="fw-ald-stack" aria-busy="true" aria-label={label}>
      <Skeleton width="60%" />
      <Skeleton height={64} />
    </div>
  )
}

// ---- the kit timing ------------------------------------------------------------------------------------------------------

export function KitTimingDialog({ dialog, model, actions, data, words }: { dialog: KitDialog; model: AllocationViewModel; actions?: AllocationActions; data: Allocation; words: Words }) {
  const { t, locale } = words
  const uom = useT('buying')
  const card = data.cards.find((entry) => entry.id === dialog.cardId) ?? null
  const ref = laneRefOf(dialog.laneKey)
  const lane = data.lanes.find((entry) => `${entry.kind}:${entry.id}` === dialog.laneKey) ?? null
  const workshopName = lane?.name ?? t('al.workshop')
  const timing = ready(dialog.timing)
  const said = card && ref ? verdictWords(ready(model.workshops), data.site.name, card.workOrder.id, ref.id, words) : { held: [], warnings: [] }
  const held = !(data.mayChange ?? false)
    ? t('al.kit.held.readOnly')
    : model.offline
      ? t('al.kit.held.offline')
      : dialog.busy
        ? t('al.kit.held.busy')
        : dialog.timing.status === 'error' && dialog.timing.problem === 'noWork'
          ? t('al.kit.held.noWork', { order: card?.workOrder.number ?? '—' })
          : dialog.timing.status !== 'ready'
            ? t('al.kit.held.reading')
          : said.held[0] ?? null
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      size="lg"
      title={t('al.kit.title', { workshop: workshopName })}
      subtitle={card ? t('al.kit.subtitle', { order: card.workOrder.number, style: card.workOrder.style.name, count: dialog.pieces, pieces: String(dialog.pieces) }) : undefined}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={() => actions?.onCloseDialog?.()}>
            {t('al.dialog.cancel')}
          </Button>
          <span className="grow" />
          <Button size="sm" variant="primary" heldReason={held} onClick={() => !held && actions?.onAllocateKit?.()}>
            {dialog.busy ? <Spinner size={12} /> : null} {t('al.kit.allocate', { count: dialog.pieces, pieces: String(dialog.pieces) })}
          </Button>
        </>
      }
    >
      <div className="fw-ald-stack">
        {dialog.error ? <Banner tone="danger" title={dialog.error} /> : null}
        {said.held.length > 0 ? (
          <Banner tone="danger" title={t('al.kit.heldTitle', { workshop: workshopName })}>
            <ul className="fw-ald-list">{said.held.map((line) => <li key={line}>{line}</li>)}</ul>
          </Banner>
        ) : null}
        {said.warnings.length > 0 ? (
          <Banner tone="warning" title={t('al.kit.warnTitle')}>
            <ul className="fw-ald-list">{said.warnings.map((line) => <li key={line}>{line}</li>)}</ul>
          </Banner>
        ) : null}
        {dialog.timing.status === 'loading' ? <Reading label={t('al.kit.reading')} /> : null}
        {dialog.timing.status === 'error' && dialog.timing.problem === 'noWork' ? <EmptyState title={t('al.kit.noWorkTitle')} description={t('al.kit.noWork', { order: card?.workOrder.number ?? '—' })} /> : null}
        {dialog.timing.status === 'error' && dialog.timing.problem !== 'noWork' ? (
          <EmptyState
            title={t('al.kit.errorTitle')}
            description={t(`al.error.${dialog.timing.problem}`)}
            action={
              <Button size="sm" onClick={() => actions?.onRetryKit?.()}>
                {t('al.dialog.retry')}
              </Button>
            }
          />
        ) : null}
        {timing ? (
          <>
            <Banner tone={timing.late ? 'warning' : 'info'} title={kitSentence(timing, words)} />
            <KeyValue columns={2} labelCase="sentence" items={kitFacts(timing, data.site.timeZone, words)} />
            <section aria-labelledby="fw-ald-kit">
              <h3 className="fw-ald-h3" id="fw-ald-kit">
                {t('al.kit.listTitle')}
              </h3>
              {timing.kit.lines.length === 0 ? (
                <p className="fw-ald-hint">{t('al.kit.listNone')}</p>
              ) : (
                <SummaryTable
                  label={t('al.kit.listTitle')}
                  density="compact"
                  stackOnPhone
                  columns={[t('al.kit.col.item'), t('al.kit.col.colour'), t('al.kit.col.quantity')]}
                  align={['left', 'left', 'right']}
                  rows={timing.kit.lines.map((line, index) => ({ id: `${line.item.id}-${line.colour?.id ?? 'none'}-${index}`, cells: [`${line.item.code} · ${line.item.name}`, line.colour?.code ?? '—', quantityWords(line, uom, locale)] }))}
                />
              )}
              {timing.kit.note ? <p className="fw-ald-hint">{t('al.kit.note', { note: timing.kit.note })}</p> : null}
            </section>
            <section aria-labelledby="fw-ald-later">
              <h3 className="fw-ald-h3" id="fw-ald-later">
                {t('al.kit.laterTitle')}
              </h3>
              {timing.laterOperations.length === 0 ? (
                <p className="fw-ald-hint">{t('al.kit.laterNone')}</p>
              ) : (
                <ul className="fw-ald-list">
                  {timing.laterOperations.map((operation) => (
                    <li key={operation.id}>
                      {laterWords(operation, words)} {operation.finishesLate ? <Tag tone="warning">{t('al.kit.finishesLate')}</Tag> : null}
                    </li>
                  ))}
                </ul>
              )}
              {timing.finishesLate ? <Banner tone="warning" title={t('al.kit.lateOrder')} /> : null}
            </section>
            <p className="fw-ald-hint">{t('al.kit.howOrdered')}</p>
          </>
        ) : null}
      </div>
    </Modal>
  )
}

// ---- the card's operations (design board#4) ----------------------------------------------------------------------------------

export function OperationsSection({ cardId, operations, model, actions, words }: { cardId: string; operations: Loaded<CardOperations> | undefined; model: AllocationViewModel; actions?: AllocationActions; words: Words }) {
  const { t } = words
  const mayOutsource = model.may?.outsource ?? false
  return (
    <section className="fw-ald-stack" aria-labelledby="fw-ald-ops">
      <h3 className="fw-al-h3" id="fw-ald-ops">
        {t('al.op.title')}
      </h3>
      {!operations || operations.status === 'loading' ? <Reading label={t('al.op.reading')} /> : null}
      {operations?.status === 'error' ? (
        <Banner tone="danger" title={t('al.op.errorTitle')}>
          {t(`al.error.${operations.problem}`)}{' '}
          <Button size="sm" variant="quiet" onClick={() => actions?.onRetryOperations?.()}>
            {t('al.dialog.retry')}
          </Button>
        </Banner>
      ) : null}
      {operations?.status === 'ready' ? (
        operations.value.operations.length === 0 ? (
          <p className="fw-ald-hint">{t('al.op.none')}</p>
        ) : (
          <SummaryTable
            label={t('al.op.title')}
            density="compact"
            stackOnPhone
            columns={[t('al.op.col.operation'), t('al.op.col.where'), t('al.op.col.switch')]}
            align={['left', 'left', 'right']}
            rows={operations.value.operations.map((operation) => {
              const held = !mayOutsource || !operations.value.mayOutsource ? t('al.op.held.permission') : model.offline ? t('al.op.held.offline') : operation.remaining === 0 && !operation.outsourced ? t('al.op.held.noWork') : null
              return {
                id: operation.id,
                cells: [
                  <span key="op" className="fw-ald-cell">
                    <span>{t('al.op.name', { seq: String(operation.seq), operation: operation.name })}</span>
                    <span className="fw-ald-sub">{kindWords(operation.workCentreKind, words)}</span>
                  </span>,
                  operation.outsourced ? (
                    <span key="where" className="fw-ald-cell">
                      <Tag tone="info">{t('al.op.outside')}</Tag>
                      <span className="fw-ald-sub">{operation.workshopName ? t(operation.subcontractOrderId ? 'al.op.atOrdered' : 'al.op.atNoOrder', { workshop: operation.workshopName }) : t(operation.subcontractOrderId ? 'al.op.ordered' : 'al.op.noOrderYet')}</span>
                    </span>
                  ) : (
                    <Tag key="where" tone="neutral">
                      {t('al.op.inHouse')}
                    </Tag>
                  ),
                  <Button key="switch" size="sm" heldReason={held} onClick={() => !held && actions?.onSwitch?.(cardId, operation.id, operation.outsourced ? 'in-house' : 'outside')}>
                    {t(operation.outsourced ? 'al.op.toInHouse' : 'al.op.toOutside')}
                  </Button>,
                ],
              }
            })}
          />
        )
      ) : null}
      <p className="fw-ald-hint">{t('al.op.rule')}</p>
    </section>
  )
}

// ---- one operation in-house or outside -----------------------------------------------------------------------------------------

export function SwitchOperationDialog({ dialog, model, actions, data, words }: { dialog: SwitchDialog; model: AllocationViewModel; actions?: AllocationActions; data: Allocation; words: Words }) {
  const { t, locale } = words
  const card = data.cards.find((entry) => entry.id === dialog.cardId) ?? null
  const read = ready(dialog.workshops)
  const operation = read?.operations.find((entry) => entry.id === dialog.operationId) ?? null
  const offered = (read?.workshops ?? []).filter((workshop) => workshop.offered)
  const [partyId, setPartyId] = useState<string | null>(dialog.partyId ?? null)
  const [pieces, setPieces] = useState<number>(card?.workOrder.garments ?? 1)
  const [reason, setReason] = useState<string>(dialog.reason ?? '')
  useEffect(() => {
    if (partyId === null && offered.length === 1) setPartyId(offered[0]!.id)
  }, [offered.length])
  useEffect(() => setPieces(read?.workOrder.garments ?? card?.workOrder.garments ?? 1), [read?.workOrder.garments])
  const picked = read?.workshops.find((workshop) => workshop.id === partyId) ?? null
  const mayOutsource = (model.may?.outsource ?? false) && (read?.mayOutsource ?? true)
  const garments = read?.workOrder.garments ?? card?.workOrder.garments ?? 1
  const held =
    dialog.workshops.status !== 'ready'
      ? t('al.op.held.reading')
      : switchHeld({ mayOutsource, offline: model.offline, busy: dialog.busy ?? false, mode: dialog.mode, partyId, offered: picked?.offered ?? false, reason }, words) ?? (dialog.mode === 'outside' && (!Number.isInteger(pieces) || pieces < 1 || pieces > garments) ? t('al.op.held.pieces', { count: garments, pieces: String(garments) }) : null)
  const title = operation ? t(dialog.mode === 'outside' ? 'al.op.outsideTitle' : 'al.op.inHouseTitle', { seq: String(operation.seq), operation: operation.name }) : t('al.op.switchTitle')
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      size="lg"
      title={title}
      subtitle={card ? `${card.workOrder.number} · ${card.workOrder.style.code} · ${card.workOrder.style.name}` : undefined}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={() => actions?.onBackToCard?.()}>
            {t('al.dialog.back')}
          </Button>
          <span className="grow" />
          <Button size="sm" variant="primary" heldReason={held} onClick={() => !held && (dialog.mode === 'outside' ? partyId && actions?.onSendOutside?.({ partyId, pieces }) : actions?.onBringInHouse?.(reason.trim()))}>
            {dialog.busy ? <Spinner size={12} /> : null} {t(dialog.mode === 'outside' ? 'al.op.send' : 'al.op.bringBack')}
          </Button>
        </>
      }
    >
      <div className="fw-ald-stack">
        {dialog.error ? <Banner tone="danger" title={dialog.error} /> : null}
        {dialog.workshops.status === 'loading' ? <Reading label={t('al.op.reading')} /> : null}
        {dialog.workshops.status === 'error' ? (
          <EmptyState
            title={t('al.op.errorTitle')}
            description={t(`al.error.${dialog.workshops.problem}`)}
            action={
              <Button size="sm" onClick={() => actions?.onRetrySwitch?.()}>
                {t('al.dialog.retry')}
              </Button>
            }
          />
        ) : null}
        {read && dialog.mode === 'outside' ? (
          <>
            <p className="fw-ald-hint">{t('al.op.outsideLead', { kind: kindWords(operation?.workCentreKind ?? null, words) })}</p>
            {read.workshops.length === 0 ? (
              <p className="fw-ald-hint">{t('al.op.noWorkshops')}</p>
            ) : (
              <div className="fw-ald-choices" role="radiogroup" aria-label={t('al.op.pick')}>
                {read.workshops.map((workshop) => {
                  const known = workshopOf(ready(model.workshops), workshop.id) ?? workshop
                  const why = workshop.held.map((reason) => holdWords(reason, known, data.site.name, words))
                  const warn = workshop.warnings.map((reason) => warningWords(reason, known, words))
                  return (
                    <RadioCard
                      key={workshop.id}
                      name="fw-ald-workshop"
                      value={workshop.id}
                      checked={partyId === workshop.id}
                      selected={partyId === workshop.id}
                      disabled={!workshop.offered}
                      onChange={() => setPartyId(workshop.id)}
                      title={
                        <span className="fw-ald-inline">
                          {workshop.name} {workshop.offered ? <Tag tone="success">{t('al.op.offered')}</Tag> : <Tag tone="danger">{t('al.op.notOffered')}</Tag>}
                          {workshop.routing ? <Tag tone="neutral">{t('al.op.routing')}</Tag> : null}
                        </span>
                      }
                      description={[...why, ...warn].join(' ') || t('al.op.noRemark')}
                    />
                  )
                })}
              </div>
            )}
            <Field label={t('al.op.pieces')} hint={t('al.op.piecesHint', { count: garments, pieces: String(garments) })}>
              <NumberStepper size="sm" value={pieces} min={1} max={garments} onChange={setPieces} decrementLabel={t('al.op.less')} incrementLabel={t('al.op.more')} />
            </Field>
            <p className="fw-ald-hint">{t((model.may?.order ?? false) ? 'al.op.orderWill' : 'al.op.orderBuyer')}</p>
          </>
        ) : null}
        {read && dialog.mode === 'in-house' ? (
          <>
            <p className="fw-ald-hint">{t(operation?.subcontractOrderId ? 'al.op.inHouseLeadOrder' : 'al.op.inHouseLead')}</p>
            <Field label={t('al.op.reason')} hint={t('al.op.reasonHint')}>
              <Textarea rows={3} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
            </Field>
          </>
        ) : null}
        <p className="fw-ald-hint">{t('al.op.when', { date: dayWords(read?.asOf.slice(0, 10) ?? data.today, locale) })}</p>
      </div>
    </Modal>
  )
}

// ---- Create subcontract orders (n) ---------------------------------------------------------------------------------------------

export function CreateOrdersDialog({ dialog, model, actions, data, words }: { dialog: OrdersDialog; model: AllocationViewModel; actions?: AllocationActions; data: Allocation; words: Words }) {
  const { t } = words
  const workshops: AllocationWorkshops | null = ready(model.workshops)
  const preview = ready(dialog.preview)
  const passing = (preview?.results ?? []).filter((result) => result.ok)
  const leftOut = preview ? leftOutWords(preview, workshops, data.site.name, words) : []
  const state =
    dialog.preview.status === 'loading'
      ? ({ phase: 'reading' } as const)
      : dialog.preview.status === 'error'
        ? ({ phase: 'failed', error: t(`al.error.${dialog.preview.problem}`) } as const)
        : dialog.phase === 'saving'
          ? ({ phase: 'saving' } as const)
          : dialog.phase === 'done' && dialog.result
            ? ({ phase: 'done', results: Object.fromEntries(dialog.result.results.map((result) => [result.slotId, { ok: result.ok, words: madeWords(result, workshops, data.site.name, words, data.site.timeZone), verb: t('al.orders.verb') }])) } as const)
            : ({ phase: 'ready' } as const)
  const problems = [...(dialog.error ? [t(dialog.error)] : []), ...(model.offline ? [t('al.orders.held.offline')] : []), ...(preview && passing.length === 0 ? [t('al.orders.nonePass')] : [])]
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onCloseDialog?.()}
      size="xl"
      title={t('al.orders.title', { count: dialog.slotIds.length })}
      summary={t('al.orders.summary')}
      changes={passing.map((result) => ({ id: result.slotId, ...partChange(result, data.cards.find((card) => card.slot?.id === result.slotId), workshops, words, data.today) }))}
      state={state}
      problems={problems}
      saveLabel={t('al.orders.save', { count: passing.length })}
      onSave={() => actions?.onConfirmOrders?.()}
      onRetry={() => actions?.onRetryOrders?.()}
      lead={
        leftOut.length > 0 ? (
          <Banner tone="warning" title={t('al.orders.leftOut', { count: leftOut.length })}>
            <ul className="fw-ald-list">
              {leftOut.map((line) => (
                <li key={line.id}>
                  <b>{line.label}</b> — {line.why}
                </li>
              ))}
            </ul>
          </Banner>
        ) : undefined
      }
    />
  )
}
