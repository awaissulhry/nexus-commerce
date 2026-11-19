'use client'

import { useState, type KeyboardEvent } from 'react'
import { Banner, EmptyState, Field, Stepper } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, NumberStepper, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { TRANSPORT_BY, type ReadyCell, type ReadyOrder, type TransportBy } from '../../api'
import { newShipmentLines, newShipmentProblems, orderWords, ordersOfNew, togetherRows, type ShippingAbilities } from '../../model'
import type { NewShipmentModel, ShipmentsListActions } from '../list-model'
// F-OP-121: the customer's other orders, held with the join reason in the screen's words (the depth catalogue's shipOrders.*).
import { DEPTH_NS } from '../../queue/shared/depth'

/**
 * New shipment (design sh-new, W1): two steps — 1 the order (only orders with garments quality released and not on a
 * shipment yet) and who carries the goods; 2 how many of each colour and size, each capped at what that cell can still
 * ship (released − reversed − on other shipments, the cap shown beside it). Create shipment makes a DRAFT with the
 * SHIPMENT series' next number and opens it. ⌘↵ creates; Esc closes (the DS Modal returns the focus).
 *
 * F-OP-121 (order page N6): `model.together` — opened from the order page: step 1 is this order and, beside it, "Add other open
 * orders of <Customer> to this shipment" (the walled ship-together read: the same customer only, each held with its reason;
 * several orders are held off until the switch); step 2 groups the garments under each order ("SO-0150 · PO 4471").
 */
export function NewShipmentDialog({ model, can, actions }: { model: NewShipmentModel; can: ShippingAbilities; actions?: ShipmentsListActions }) {
  const t = useT('shipments')
  const order = model.orders?.find((entry) => entry.salesOrderId === model.salesOrderId) ?? null
  // F-OP-121: every order the shipment would carry (this one, then the others added).
  const carried = ordersOfNew(model)
  const cells = carried.flatMap((entry) => entry.cells)
  const lines = order ? newShipmentLines(cells, model.quantities) : []
  const garments = lines.reduce((sum, line) => sum + line.quantity, 0)
  const problems = order ? newShipmentProblems(cells, model.quantities) : []
  const held =
    model.step === 1
      ? !order
        ? t('new.held.order')
        : null
      : !can.manage
        ? t('held.noManage')
        : problems.length > 0
          ? t('new.held.range')
          : garments === 0
            ? t('new.held.none')
            : model.busy
              ? t('held.busy')
              : null
  const go = () => {
    if (held) return
    if (model.step === 1) actions?.onNewStep?.(2)
    else actions?.onNewCreate?.()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      go()
    }
  }

  return (
    <Modal
      open
      onClose={() => actions?.onNewClose?.()}
      title={t('new.title')}
      subtitle={order ? t('new.subtitle', { order: order.number, customer: order.party.legalName }) : undefined}
      size="lg"
      footer={
        <>
          {model.step === 2 && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onNewStep?.(1)}>
              {t('new.back')}
            </Button>
          )}
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onNewClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.step === 1 ? t('new.next') : t('new.create', { count: garments })}
          </Button>
        </>
      }
    >
      <form
        className="fw-sh-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          go()
        }}
        onKeyDown={onKeyDown}
      >
        <Stepper
          steps={[
            { key: 'order', label: t('new.step.order') },
            { key: 'quantities', label: t('new.step.quantities') },
          ]}
          current={model.step - 1}
          onSelect={(index) => actions?.onNewStep?.(index === 0 ? 1 : 2)}
        />
        {model.refused && (
          <Banner tone="danger" title={t(model.refused.words.key, model.refused.words.params)}>
            {model.refused.detail}
          </Banner>
        )}
        {model.problem ? (
          <EmptyState title={t('new.failed')} description={t(model.problem)} />
        ) : model.orders === null ? (
          <p className="fw-sh-hint" role="status">
            <Spinner size={14} /> {t('new.loading')}
          </p>
        ) : model.orders.length === 0 || (model.together && !order) ? (
          <EmptyState title={t('new.empty.title')} description={t('new.empty.body')} />
        ) : model.step === 1 ? (
          model.together && order ? (
            <TogetherStep order={order} model={model} actions={actions} />
          ) : (
            <OrderStep model={model} actions={actions} />
          )
        ) : order ? (
          <QuantitiesStep orders={carried} model={model} actions={actions} />
        ) : null}
        <p className="fw-sh-hint">{t('new.number')}</p>
      </form>
    </Modal>
  )
}

// ── F-OP-121: this order, and the same customer's other open orders beside it (ship together) ────────────────────────────────────
function TogetherStep({ order, model, actions }: { order: ReadyOrder; model: NewShipmentModel; actions?: ShipmentsListActions }) {
  const t = useT('shipments')
  const d = useT(DEPTH_NS)
  const shippable = (entry: ReadyOrder) => entry.cells.reduce((sum, cell) => sum + cell.shippable, 0)
  const po = (ref: string) => t('new.customerRef', { ref })
  const rows = togetherRows(model)
  const picked = new Set(model.others ?? [])
  return (
    <div className="fw-sh-stack">
      <div className="fw-sh-choices">
        <CheckboxCard checked readOnly aria-readonly="true" selected title={orderWords({ number: order.number, customerRef: order.customerRef }, po)} description={t('new.together.this', { count: shippable(order) })} />
      </div>
      <h3 className="fw-sh-h3">{t('new.together.add', { customer: order.party.legalName })}</h3>
      {rows.length === 0 ? (
        <p className="fw-sh-hint">{t('new.together.none', { customer: order.party.legalName })}</p>
      ) : (
        <div className="fw-sh-choices" role="group" aria-label={t('new.together.add', { customer: order.party.legalName })}>
          {rows.map(({ order: other, held }) => (
            // Held, never hidden nor disabled: it keeps its focus and says why (aria-disabled; ticking it does nothing).
            <CheckboxCard
              key={other.salesOrderId}
              checked={picked.has(other.salesOrderId)}
              selected={picked.has(other.salesOrderId)}
              aria-disabled={held ? true : undefined}
              onChange={(event) => (held ? undefined : actions?.onNewOther?.(other.salesOrderId, event.target.checked))}
              title={orderWords({ number: other.number, customerRef: other.customerRef }, po)}
              description={held ? d(held.key) : t('new.shippable', { count: shippable(other) })}
            />
          ))}
        </div>
      )}
      <DeliveryFields model={model} actions={actions} />
    </div>
  )
}

function DeliveryFields({ model, actions }: { model: NewShipmentModel; actions?: ShipmentsListActions }) {
  const t = useT('shipments')
  return (
    <div className="fw-sh-fields">
      <Field label={t('new.transportBy')}>
        <Select size="sm" value={model.transportBy} onChange={(event) => actions?.onNewDelivery?.({ transportBy: event.target.value as TransportBy })}>
          {TRANSPORT_BY.map((value) => (
            <option key={value} value={value}>
              {t(`transportBy.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      {model.transportBy === 'CARRIER' && (
        <>
          <Field label={t('new.carrierCode')} hint={t('new.carrierHint')}>
            <Input size="sm" value={model.carrierCode} onChange={(event) => actions?.onNewDelivery?.({ carrierCode: event.target.value })} />
          </Field>
          <Field label={t('new.serviceCode')} hint={t('new.serviceHint')}>
            <Input size="sm" value={model.serviceCode} onChange={(event) => actions?.onNewDelivery?.({ serviceCode: event.target.value })} />
          </Field>
        </>
      )}
    </div>
  )
}
// ── end F-OP-121 ──

function OrderStep({ model, actions }: { model: NewShipmentModel; actions?: ShipmentsListActions }) {
  const t = useT('shipments')
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const orders = (model.orders ?? []).filter((order) => !needle || [order.number, order.customerRef ?? '', order.party.legalName, order.party.code].some((text) => text.toLowerCase().includes(needle)))
  const shippable = (order: ReadyOrder) => order.cells.reduce((sum, cell) => sum + cell.shippable, 0)
  return (
    <div className="fw-sh-stack">
      {(model.orders?.length ?? 0) > 5 && <Input size="sm" type="search" aria-label={t('new.search')} placeholder={t('new.search')} value={search} onChange={(event) => setSearch(event.target.value)} />}
      <div className="fw-sh-choices" role="radiogroup" aria-label={t('new.step.order')}>
        {orders.map((order) => (
          <RadioCard
            key={order.salesOrderId}
            name="fw-sh-new-order"
            checked={model.salesOrderId === order.salesOrderId}
            selected={model.salesOrderId === order.salesOrderId}
            onChange={() => actions?.onNewOrder?.(order.salesOrderId)}
            title={`${order.number} · ${order.party.legalName}`}
            description={[order.customerRef ? t('new.customerRef', { ref: order.customerRef }) : null, t('new.shippable', { count: shippable(order) })].filter(Boolean).join(' · ')}
          />
        ))}
        {orders.length === 0 && <p className="fw-sh-hint">{t('new.noMatch')}</p>}
      </div>
      <DeliveryFields model={model} actions={actions} /* F-OP-121: shared with the together step */ />
    </div>
  )
}

function QuantitiesStep({ orders, model, actions }: { orders: readonly ReadyOrder[]; model: NewShipmentModel; actions?: ShipmentsListActions }) {
  const t = useT('shipments')
  const problems = newShipmentProblems(
    orders.flatMap((order) => order.cells),
    model.quantities,
  )
  // F-OP-121: grouped by order ("SO-0150 · PO 4471") when it carries several, then by style and colour.
  const po = (ref: string) => t('new.customerRef', { ref })
  const several = orders.length > 1 || !!model.together
  const groups = new Map<string, ReadyCell[]>()
  for (const order of orders) {
    for (const cell of order.cells) {
      const key = `${several ? `${orderWords({ number: order.number, customerRef: order.customerRef }, po)} — ` : ''}${cell.styleCode} · ${cell.colourwayName}`
      groups.set(key, [...(groups.get(key) ?? []), cell])
    }
  }
  return (
    <div className="fw-sh-stack">
      <div className="fw-sh-card-head">
        <span className="fw-sh-hint">{t('new.capNote')}</span>
        <Button size="sm" onClick={() => actions?.onNewAll?.()}>
          {t('new.all')}
        </Button>
      </div>
      {[...groups.entries()].map(([title, cells]) => (
        <fieldset key={title} className="fw-sh-sizes">
          <legend className="fw-sh-h3">
            {title} <span className="fw-sh-muted">· {cells[0]!.styleName}</span>
          </legend>
          <div className="fw-sh-size-grid">
            {cells.map((cell) => {
              const problem = problems.find((entry) => entry.cellId === cell.workOrderSizeId)
              return (
                <Field
                  key={cell.workOrderSizeId}
                  label={t('new.size', { size: cell.size })}
                  hint={t('new.cap', { count: cell.shippable, batch: cell.batchNumber ?? cell.workOrderNumber })}
                  error={problem ? t(problem.key, problem.params) : undefined}
                >
                  <NumberStepper
                      size="sm"
                      min={0}
                      max={cell.shippable}
                      value={model.quantities[cell.workOrderSizeId] ?? 0}
                      onChange={(next) => actions?.onNewQuantity?.(cell.workOrderSizeId, next)}
                      decrementLabel={t('new.minus', { size: cell.size })}
                      incrementLabel={t('new.plus', { size: cell.size })}
                      disabled={cell.shippable === 0}
                    />
                </Field>
              )
            })}
          </div>
          {cells.some((cell) => cell.serialTracked) && <p className="fw-sh-hint">{t('new.serials')}</p>}
        </fieldset>
      ))}
    </div>
  )
}
