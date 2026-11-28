'use client'

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { WithMessages } from '../../../../../record-panels/i18n'
import { createShipment, readyToShip, type ReadyOrder } from '../../../../warehouse/shipments/api'
import { readProblem, writeProblem } from '../../../../warehouse/shipments/model'
import { ourWarehouses } from './legs/api'
import { shipRightsOf } from './legs/model'
import { shipmentHref } from './view/hrefs'
import { defaultSiteOf, joinableIds, makeHeld, piecesOf, shipBodyOf, togetherRowsOf, waysOf, type WarehouseChoice, type WaysChoice } from './ways/model'
import { ShipWaysView, type ShipWaysViewModel } from './ways/view/ShipWaysView'

/**
 * SLOT — owner: S3 (owb-ss3); filled by ss3 step 3.1 (the window "Ship the whole order…": alone · together · to our warehouse first).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Where: the band opens it as
 * its next act on an order ready to ship (S2 of5 mounts it); not mounted by the base. Office only: the customer never reaches it.
 *
 * owb-ss3 (design plan § 7; settles L3, L4, L5; server Shape owb-ss1): reads what this order and the customer's other orders have
 * released and on no shipment (`GET /shipping/ready?salesOrderId=&together=1`) and the company's own warehouses
 * (`GET /shipping/our-warehouses`), then makes ONE DRAFT shipment through today's create (`POST /shipping/shipments`, its own
 * Idempotency-Key per choice) — never more: the person packs and sends in Warehouse (weights, the DDT, the holds). Mounted only while
 * open; the page reads itself again on the shipment's event.
 */
export interface ShipWholeOrderWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function ShipWholeOrderWindow(props: ShipWholeOrderWindowProps): ReactElement | null {
  if (!props.open) return null
  return (
    <WithMessages namespaces={['ship-ways', 'shipments', 'warehouse-shipments-depth', 'orders']}>
      <Container {...props} />
    </WithMessages>
  )
}

const NO_CHOICE: WaysChoice = Object.freeze({ way: null, ticked: [], siteId: null })

function Container({ open, onClose, companyId, orderId }: ShipWholeOrderWindowProps): ReactElement {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const rights = useMemo(() => shipRightsOf(session.permissions), [session.permissions])
  const prefix = session.company ? companyPrefix(session.company.code) : ''
  const [orders, setOrders] = useState<ReadyOrder[] | null>(null)
  const [warehouses, setWarehouses] = useState<WarehouseChoice[] | null>(null)
  const [readFailed, setReadFailed] = useState<string | null>(null)
  const [choice, setChoice] = useState<WaysChoice>(NO_CHOICE)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<ShipWaysViewModel['writeProblem']>(null)
  const [made, setMade] = useState<ShipWaysViewModel['made']>(null)
  // One key per choice: a lost answer sent again is answered from its receipt; a new choice is a new shipment.
  const key = useRef<{ body: string; key: string } | null>(null)

  useEffect(() => {
    let live = true
    readyToShip(api, { salesOrderId: orderId, together: true })
      .then((rows) => {
        if (live) setOrders(rows)
      })
      .catch((error: unknown) => {
        if (live) setReadFailed(readProblem(error))
      })
    // The warehouses: a failed read leaves "To our warehouse first" held (none known), the other ways still work.
    ourWarehouses(api)
      .then((rows) => {
        if (!live) return
        const list = rows.map((row) => ({ siteId: row.siteId, name: row.name, city: row.city }))
        setWarehouses(list)
        setChoice((current) => (current.siteId ? current : { ...current, siteId: defaultSiteOf(list) }))
      })
      .catch(() => {
        if (live) setWarehouses([])
      })
    return () => {
      live = false
    }
  }, [api, orderId])

  const order = orders?.find((row) => row.salesOrderId === orderId) ?? null
  const others = useMemo(() => (orders ?? []).filter((row) => row.salesOrderId !== orderId), [orders, orderId])
  const rows = useMemo(() => togetherRowsOf(others, orderId), [others, orderId])
  // The other ready orders that may go with it are ticked once, when they are read.
  const tickedOnce = useRef(false)
  useEffect(() => {
    if (tickedOnce.current || orders === null) return
    tickedOnce.current = true
    setChoice((current) => ({ ...current, ticked: joinableIds(rows) }))
  }, [orders, rows])

  const ways = waysOf({ rows, warehouses })
  const held = makeHeld({ rights, order, ways, choice, busy })

  const make = async () => {
    if (!order || held || busy) return
    const body = shipBodyOf({ order, others, choice })
    const text = JSON.stringify(body)
    if (key.current?.body !== text) key.current = { body: text, key: newIdempotencyKey() }
    setBusy(true)
    setProblem(null)
    try {
      const shipment = await createShipment(api, body, key.current.key)
      setMade({ number: shipment.number, href: shipmentHref(prefix, shipment.companyId || companyId, { id: shipment.id, number: shipment.number }), way: choice.way ?? 'ALONE' })
    } catch (error) {
      const said = writeProblem(error)
      setProblem({ key: said.key, detail: said.detail ?? null })
    } finally {
      setBusy(false)
    }
  }

  const model: ShipWaysViewModel = {
    open,
    state: made ? 'made' : readFailed ? 'failed' : orders === null ? 'reading' : 'ready',
    readProblem: readFailed,
    // An order with nothing released on no shipment is not in the read: the window says so (the act stays held with its words).
    order: order ? { number: order.number, customer: order.party.legalName, pieces: piecesOf(order) } : orders !== null ? { number: '', customer: '', pieces: 0 } : null,
    ways,
    rows,
    warehouses,
    choice,
    held,
    busy,
    writeProblem: problem,
    made,
  }
  return (
    <ShipWaysView
      model={model}
      actions={{
        onClose: () => {
          if (!busy) onClose()
        },
        onChoice: (next) => {
          setChoice(next)
          setProblem(null)
        },
        onMake: () => void make(),
      }}
    />
  )
}
