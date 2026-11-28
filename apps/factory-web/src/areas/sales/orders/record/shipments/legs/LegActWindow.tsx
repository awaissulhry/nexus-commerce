'use client'

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { OrderWarningKind } from '@nexus/factory-domain/sales/warnings/kinds'
import { useOfficeApi, useOfficeSession } from '../../../../../../lib/session/context'
import { companyPrefix } from '../../../../../../lib/session/session'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { getShipment } from '../../../../../warehouse/shipments/api'
import { readProblem, writeProblem } from '../../../../../warehouse/shipments/model'
import { shipmentHref } from '../view/hrefs'
import { forwardShipment, markArrived } from './api'
import { EMPTY_SEND_ON, legsForAct, sendOnBody, sendOnHeld, shipRightsOf, warningsOf, type LegAct, type SendOnForm } from './model'
import { useOrderLegs } from './use-legs'
import { LegActView, type LegActViewModel } from './view/LegActView'

/** The catalogues the leg's window speaks: its own, and the Warehouse's refusal words. */
export const LEG_NS = ['ship-ways', 'shipments', 'orders'] as const

export interface LegActWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly act: LegAct
  /** The order whose legs are read (the order's Shipments tab, the band); else the shipment's own order is read first. */
  readonly salesOrderId?: string | null
  /** Only this shipment (the Warehouse record, Our warehouses); absent: every shipment of the order that fits the act. */
  readonly shipmentId?: string | null
  /** After the act: the host reads itself again. */
  readonly onDone?: () => void
}

/**
 * owb-ss3 (settles L2, L5; server Shape owb-ss1) — the warehouse leg's window as a container: reads the order's legs (from the shipment's
 * own order when only a shipment is given), the shipments that fit the act (number and pieces, one read each), and does the act ONE
 * time: `POST …/arrived` or `POST …/forward`. Send on that answers 409 WARNINGS keeps the window open with the warnings in words; the
 * same press again ("Send it anyway") sends them as `overrides`. A version that moved reads the legs again. Mounted only while open.
 */
export function LegActWindow(props: LegActWindowProps): ReactElement | null {
  if (!props.open) return null
  return (
    <WithMessages namespaces={LEG_NS}>
      <Container {...props} />
    </WithMessages>
  )
}

interface Facts {
  readonly number: string
  readonly pieces: number
  readonly salesOrderId: string
}

function Container({ open, onClose, act, salesOrderId = null, shipmentId = null, onDone }: LegActWindowProps): ReactElement {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const rights = useMemo(() => shipRightsOf(session.permissions), [session.permissions])
  const prefix = session.company ? companyPrefix(session.company.code) : ''
  // The order: given, or the shipment's own (one read).
  const [orderId, setOrderId] = useState<string | null>(salesOrderId)
  const [orderProblem, setOrderProblem] = useState<string | null>(null)
  const [facts, setFacts] = useState<ReadonlyMap<string, Facts>>(new Map())
  const [version, setVersion] = useState(0)
  const read = useOrderLegs(api, orderId, version)
  const [picked, setPicked] = useState<string | null>(shipmentId)
  const [form, setForm] = useState<SendOnForm>(EMPTY_SEND_ON)
  const [warnings, setWarnings] = useState<OrderWarningKind[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<LegActViewModel['writeProblem']>(null)

  useEffect(() => {
    if (salesOrderId || !shipmentId) return
    getShipment(api, shipmentId)
      .then((shipment) => setOrderId(shipment.salesOrderId))
      .catch((error: unknown) => setOrderProblem(readProblem(error)))
  }, [api, salesOrderId, shipmentId])

  const legs = useMemo(() => legsForAct(read.legs ?? [], act, rights).filter((leg) => !shipmentId || leg.shipmentId === shipmentId), [read.legs, act, rights, shipmentId])
  // Each shipment that fits: its number and pieces (the leg read carries ids only).
  const ids = legs.map((leg) => leg.shipmentId).join(',')
  useEffect(() => {
    if (!ids) return
    let live = true
    Promise.all(ids.split(',').map((id) => getShipment(api, id).then((shipment): [string, Facts] => [id, { number: shipment.number, pieces: shipment.garments, salesOrderId: shipment.salesOrderId }]).catch(() => null)))
      .then((rows) => {
        if (live) setFacts(new Map(rows.filter((row): row is [string, Facts] => row !== null)))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [api, ids])
  useEffect(() => {
    if (!picked && legs[0]) setPicked(legs[0].shipmentId)
  }, [legs, picked])

  const leg = legs.find((entry) => entry.shipmentId === picked) ?? legs[0] ?? null
  const problemOfRead = orderProblem ?? read.problem
  const state: LegActViewModel['state'] = problemOfRead ? 'failed' : read.legs === null ? 'reading' : legs.length === 0 ? 'none' : 'ready'
  const pickedFacts = leg ? (facts.get(leg.shipmentId) ?? null) : null

  const run = async () => {
    if (!leg || busy) return
    if (act === 'SEND_ON' && sendOnHeld(form, false)) return
    setBusy(true)
    setProblem(null)
    try {
      if (act === 'ARRIVED') await markArrived(api, leg.shipmentId, leg.version)
      else await forwardShipment(api, leg.shipmentId, sendOnBody(leg, form, warnings ?? []))
      onDone?.()
      onClose()
    } catch (error) {
      const found = act === 'SEND_ON' ? warningsOf(error) : null
      if (found) setWarnings(found)
      else {
        const said = writeProblem(error)
        setProblem({ key: said.key, detail: said.detail ?? null })
        if (said.reload) setVersion((value) => value + 1)
      }
    } finally {
      setBusy(false)
    }
  }

  const model: LegActViewModel = {
    open,
    act,
    state,
    readProblem: problemOfRead,
    choices: legs.map((entry) => ({ shipmentId: entry.shipmentId, number: facts.get(entry.shipmentId)?.number ?? null, pieces: facts.get(entry.shipmentId)?.pieces ?? null, place: entry.warehouse.city ? `${entry.warehouse.name}, ${entry.warehouse.city}` : entry.warehouse.name })),
    picked: leg?.shipmentId ?? null,
    leg,
    href: leg && pickedFacts && session.company ? shipmentHref(prefix, session.company.id, { id: leg.shipmentId, number: pickedFacts.number }) : null,
    form,
    warnings,
    busy,
    writeProblem: problem,
  }
  return (
    <LegActView
      model={model}
      actions={{
        onClose: () => {
          if (!busy) onClose()
        },
        onPick: (id) => {
          setPicked(id)
          setWarnings(null)
          setProblem(null)
        },
        onForm: (next) => {
          setForm(next)
          setProblem(null)
        },
        onAct: () => void run(),
        onRetry: () => {
          setOrderProblem(null)
          read.reload()
        },
      }}
    />
  )
}
