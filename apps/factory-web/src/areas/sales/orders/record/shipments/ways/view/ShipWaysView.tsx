'use client'

import type { ReactElement, ReactNode } from 'react'
import Link from 'next/link'
import { Boxes, Package, Warehouse } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, RadioCard, Select } from '@nexus/ui/primitives'
import { useT } from '../../../../../../../lib/i18n/provider'
import { PartReading } from '../../../../../../../lib/record-sections/Kit'
import { WindowShell } from '../../../../../../../lib/window-shell/view/WindowShell'
import type { Said, ShipWay, TogetherRow, WarehouseChoice, WaysChoice, WayModel } from '../model'
import '../../legs/legs.css'

/**
 * owb-ss3 step 3.1 (design plan § 7; office.js modal 'ship' "How do you ship it?"; core.js SHIP_WAYS) — the window "Ship the whole
 * order", drawn with the ONE window frame: the order (number, customer, pieces ready), the three ways as big choices (a way that cannot
 * be taken stays, with its words), under Together the customer's other ready orders with tick boxes, under Our warehouse the pick of the
 * warehouse; the ONE act **Make the shipment** (held with words). Made: the draft's number and **Open it in Warehouse to pack and send**
 * (the weights, the DDT and the holds stay there). Draws its model; fetches nothing.
 */

export interface ShipWaysViewModel {
  readonly open: boolean
  readonly state: 'reading' | 'failed' | 'ready' | 'made'
  /** Why it could not be read (a `shipments` word). */
  readonly readProblem: string | null
  readonly order: { readonly number: string; readonly customer: string; readonly pieces: number } | null
  readonly ways: readonly WayModel[]
  readonly rows: readonly TogetherRow[]
  readonly warehouses: readonly WarehouseChoice[] | null
  readonly choice: WaysChoice
  readonly held: Said | null
  readonly busy: boolean
  /** A refused create, in the Warehouse's words (`shipments`: problem.write.*), with the API's sentence. */
  readonly writeProblem: { readonly key: string; readonly detail: string | null } | null
  /** The draft made: its number and its home in Warehouse. */
  readonly made: { readonly number: string; readonly href: string; readonly way: ShipWay } | null
}

export interface ShipWaysViewActions {
  readonly onClose: () => void
  readonly onChoice?: (choice: WaysChoice) => void
  readonly onMake?: () => void
}

const WAY_ICON: Readonly<Record<ShipWay, ReactNode>> = Object.freeze({
  ALONE: <Package size={18} aria-hidden />,
  TOGETHER: <Boxes size={18} aria-hidden />,
  OUR_WAREHOUSE: <Warehouse size={18} aria-hidden />,
})

const WAY_KEY: Readonly<Record<ShipWay, string>> = Object.freeze({ ALONE: 'ways.alone.name', TOGETHER: 'ways.together.name', OUR_WAREHOUSE: 'ways.warehouse.name' })

/** The design index draws the window without a host: Cancel / Close then does nothing. */
const NO_ACTIONS: ShipWaysViewActions = Object.freeze({ onClose: () => undefined })

export function ShipWaysView({ model, actions = NO_ACTIONS }: { model: ShipWaysViewModel; actions?: ShipWaysViewActions }): ReactElement {
  const t = useT('ship-ways')
  const s = useT('shipments')
  const d = useT('warehouse-shipments-depth')
  const say = (said: Said): string => (said.ns === 'depth' ? d(said.key, said.params) : t(said.key, said.params))
  const { choice } = model
  const set = (next: Partial<WaysChoice>) => actions.onChoice?.({ ...choice, ...next })
  const subtitle = model.order && model.order.number ? t('ways.subtitle', { number: model.order.number, customer: model.order.customer, count: model.order.pieces }) : undefined
  const act = model.state === 'ready' ? { words: t('ways.make'), onAct: () => actions.onMake?.(), held: model.held ? say(model.held) : null, busy: model.busy } : null
  const more =
    model.state === 'made' && model.made ? (
      <Button size="sm" variant="primary" asChild>
        <Link href={model.made.href}>{t('ways.made.open')}</Link>
      </Button>
    ) : undefined
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={t('ways.title')} subtitle={subtitle} act={act} more={more} size="md">
      <div className="fw-ways">
        {model.state === 'reading' ? <PartReading rows={3} height={48} /> : null}
        {model.state === 'failed' ? <Banner tone="danger" title={t('ways.readFailed')}>{model.readProblem ? s(model.readProblem) : null}</Banner> : null}
        {model.state === 'made' && model.made ? (
          <Banner tone="success" title={t('ways.made.title', { number: model.made.number })}>
            {model.made.way === 'OUR_WAREHOUSE' ? t('ways.made.warehouse') : t('ways.made.next')}
          </Banner>
        ) : null}
        {model.state === 'ready' ? (
          <>
            {model.order && model.order.pieces === 0 ? <p className="fw-ways-line">{t('ways.held.nothing')}</p> : null}
            <fieldset className="fw-ways-list">
              <legend className="fw-ways-legend">{t('ways.question')}</legend>
              {model.ways.map((way) => (
                <div key={way.id} className="fw-ways-way">
                  <span className="fw-ways-icon">{WAY_ICON[way.id]}</span>
                  <RadioCard
                    name="fw-ways"
                    value={way.id}
                    checked={choice.way === way.id}
                    selected={choice.way === way.id}
                    disabled={way.held !== null}
                    onChange={() => set({ way: way.id })}
                    title={t(WAY_KEY[way.id])}
                    description={say(way.sub)}
                  />
                </div>
              ))}
            </fieldset>
            {choice.way === 'TOGETHER' && model.rows.length > 0 ? (
              <fieldset className="fw-ways-sub">
                <legend className="fw-ways-legend">{t('ways.together.list', { count: model.rows.filter((row) => row.held === null).length })}</legend>
                {model.rows.map((row) => (
                  <div key={row.salesOrderId} className="fw-ways-order">
                    <Checkbox
                      checked={choice.ticked.includes(row.salesOrderId)}
                      disabled={row.held !== null}
                      onChange={(event) => set({ ticked: event.target.checked ? [...choice.ticked, row.salesOrderId] : choice.ticked.filter((id) => id !== row.salesOrderId) })}
                      label={row.customerRef ? `${row.number} · ${row.customerRef}` : row.number}
                    />
                    <span className="fw-ways-hint">{row.held ? say(row.held) : t('ways.together.pieces', { count: row.pieces })}</span>
                  </div>
                ))}
              </fieldset>
            ) : null}
            {choice.way === 'OUR_WAREHOUSE' && model.warehouses && model.warehouses.length > 0 ? (
              <div className="fw-ways-sub">
                <Field label={t('ways.warehouse.pick')} hint={t('ways.warehouse.customerReads')}>
                  <Select size="sm" value={choice.siteId ?? ''} onChange={(event) => set({ siteId: event.target.value || null })}>
                    <option value="">{t('ways.warehouse.choose')}</option>
                    {model.warehouses.map((warehouse) => (
                      <option key={warehouse.siteId} value={warehouse.siteId}>
                        {warehouse.city ? `${warehouse.name} · ${warehouse.city}` : warehouse.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : null}
            <p className="fw-ways-hint">{t('ways.draftOnly')}</p>
          </>
        ) : null}
        {model.writeProblem ? (
          <Banner tone="danger" title={s(model.writeProblem.key)}>
            {model.writeProblem.detail}
          </Banner>
        ) : null}
      </div>
    </WindowShell>
  )
}
