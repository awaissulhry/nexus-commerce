'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { WithMessages } from '../../../record-panels/i18n'
import { addLines, createShipment, getShipment, joinableShipments, listShipments, readyToShip, type ReadyOrder } from '../shipments/api'
import { joinHeld, readProblem, writeProblem } from '../shipments/model'
import { shipRightsOf } from '../../sales/orders/record/shipments/legs/model'
import { addLinesOf, byCustomer, chipQuery, oneShipmentBody, oneShipmentHeld, oneShipmentWords, selectionOf, shipmentLinesOf, toggled, toggledCustomer, type ShipmentChip } from './model'
import { ReadyToShipView, type Part, type ReadyToShipViewModel } from './view/ReadyToShipView'

/**
 * `/w/<company>/warehouse/ready-to-ship` (owb-ss3 step 3.4; permission shipping.view; design plan § 5n "Shipping › Ready to ship"): reads
 * every order with garments released and on no shipment (`GET /shipping/ready`) and the shipments of the chosen chip
 * (`GET /shipping/shipments`); with the plan right (shipping.plan OR shipping.manage) the person ticks orders of ONE customer and makes
 * ONE DRAFT for them (today's create, its own Idempotency-Key per choice) or adds them to a DRAFT of that customer they may join
 * (`GET /shipping/shipments/joinable` of the first ticked order, then the DRAFT's lines), then opens that shipment in Warehouse to pack and
 * send (weights, the DDT, the holds stay there).
 */
export function ReadyToShipPage(): ReactElement {
  return (
    <WithMessages namespaces={['ready-to-ship', 'shipments', 'orders']}>
      <Container />
    </WithMessages>
  )
}

function Container(): ReactElement {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const prefix = session.company ? companyPrefix(session.company.code) : ''
  const plan = useMemo(() => shipRightsOf(session.permissions).plan, [session.permissions])
  const [orders, setOrders] = useState<Part<ReadyOrder[]>>({ state: 'reading' })
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [drafts, setDrafts] = useState<ReadyToShipViewModel['drafts']>([])
  const [chip, setChip] = useState<ShipmentChip>('open')
  const [shipments, setShipments] = useState<ReadyToShipViewModel['shipments']>({ state: 'reading' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<ReadyToShipViewModel['problem']>(null)
  const key = useRef<{ body: string; key: string } | null>(null)

  const loadOrders = useCallback(() => {
    setOrders({ state: 'reading' })
    readyToShip(api, {})
      .then((rows) => setOrders({ state: 'ready', value: rows }))
      .catch((error: unknown) => setOrders({ state: 'failed', problem: readProblem(error) }))
  }, [api])
  const chipSeq = useRef(0)
  const loadShipments = useCallback(
    (which: ShipmentChip) => {
      const mine = ++chipSeq.current
      setShipments({ state: 'reading' })
      listShipments(api, chipQuery(which))
        .then((page) => mine === chipSeq.current && setShipments({ state: 'ready', value: shipmentLinesOf(page.shipments) }))
        .catch((error: unknown) => mine === chipSeq.current && setShipments({ state: 'failed', problem: readProblem(error) }))
    },
    [api],
  )
  useEffect(() => loadOrders(), [loadOrders])
  useEffect(() => loadShipments(chip), [loadShipments, chip])

  const rows = orders.state === 'ready' ? orders.value : []
  const groups = useMemo(() => byCustomer(rows), [rows])
  const selection = selectionOf(groups, ticked)

  // "Add to SH-…": the DRAFTs of the ticked orders' ONE customer that the first ticked order may join.
  const first = selection.customers.length === 1 ? (selection.orderIds[0] ?? null) : null
  useEffect(() => {
    if (!plan || !first) return setDrafts([])
    let live = true
    joinableShipments(api, first)
      .then((answer) => live && setDrafts(answer.shipments.filter((row) => row.status === 'DRAFT' && joinHeld(row.joinable) === null).map((row) => ({ shipmentId: row.shipmentId, number: row.number }))))
      .catch(() => live && setDrafts([]))
    return () => {
      live = false
    }
  }, [api, plan, first])

  const held = oneShipmentHeld({ plan, selection, busy })
  const open = (shipmentId: string) => router.push(`${prefix}/warehouse/shipments/${encodeURIComponent(shipmentId)}`)

  const oneShipment = async () => {
    if (held) return
    const body = oneShipmentBody(rows, selection.orderIds)
    if (!body) return
    const text = JSON.stringify(body)
    if (key.current?.body !== text) key.current = { body: text, key: newIdempotencyKey() }
    setBusy(true)
    setProblem(null)
    try {
      const shipment = await createShipment(api, body, key.current.key)
      open(shipment.id)
    } catch (error) {
      const said = writeProblem(error)
      setProblem({ key: said.key, detail: said.detail ?? null })
      if (said.reload) loadOrders()
    } finally {
      setBusy(false)
    }
  }

  const addTo = async (shipmentId: string) => {
    if (busy || !plan || selection.customers.length !== 1) return
    setBusy(true)
    setProblem(null)
    try {
      const shipment = await getShipment(api, shipmentId)
      await addLines(api, shipmentId, shipment.version, addLinesOf(rows, selection.orderIds))
      open(shipmentId)
    } catch (error) {
      const said = writeProblem(error)
      setProblem({ key: said.key, detail: said.detail ?? null })
      if (said.reload) loadOrders()
    } finally {
      setBusy(false)
    }
  }

  const model: ReadyToShipViewModel = {
    prefix,
    plan,
    groups: orders.state === 'ready' ? { state: 'ready', value: groups } : orders,
    ticked,
    picked: { orders: selection.orderIds.length, customers: selection.customers.length, pieces: selection.pieces },
    one: { words: oneShipmentWords(selection.orderIds.length), held },
    drafts: selection.customers.length === 1 ? drafts : [],
    busy,
    problem,
    chip,
    shipments,
  }
  return (
    <ReadyToShipView
      model={model}
      actions={{
        onTick: (id) => {
          setTicked((current) => toggled(current, id))
          setProblem(null)
        },
        onTickCustomer: (group) => {
          setTicked((current) => toggledCustomer(current, group))
          setProblem(null)
        },
        onOneShipment: () => void oneShipment(),
        onAddTo: (id) => void addTo(id),
        onChip: setChip,
        onRetry: (part) => (part === 'orders' ? loadOrders() : loadShipments(chip)),
      }}
    />
  )
}
