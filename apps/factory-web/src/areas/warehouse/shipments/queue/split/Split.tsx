'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi } from '../../../../../lib/session/context'
import { failed, LOADING, ready, writeWords } from '../shared/depth'
import { readSplit, splitByHand, splitByRule } from './api'
import { handBody, splitHeld, SPLIT_REFUSALS, type SplitActions, type SplitModel } from './model'
import { INTO_MAX, type ShipToChoice } from './model' // F-OS-302
import { listShipToAddresses } from '../../../../sales/orders/api' // F-OS-302 (X1-B4): the customer's approved delivery addresses (parties.view)
import { SplitDialog } from './view/SplitDialog'

/**
 * Split… (SCR-593): opened from the record's ⋯ on a DRAFT; reads `GET …/split` (shipping.view), then ONE `POST …/split` or
 * `…/split-by-rule` on the shipment's version with its own Idempotency-Key. `onDone` makes the record read itself again.
 *
 * F-OS-302 (order SHIPMENTS tab; B-OS-010; X1-B3, X1-B4) — the same window on Warehouse's record and the order's Shipments tab: into
 * several shipments in one go (`groups[]`, ONE command), another delivery address of the customer when the opener knows the customer
 * (`partyId`: its approved SHIP_TO addresses, read when that reason is picked; this shipment's own address left out), and the
 * customer's "all in one delivery" said as a warning (`shipComplete`, never a block).
 */
export function Split({ shipmentId, prefix, onClose, onDone, partyId, shipToAddressId, shipComplete }: { shipmentId: string; prefix: string; onClose: () => void; onDone: () => void; /* F-OS-302 */ partyId?: string; shipToAddressId?: string | null; shipComplete?: boolean }) {
  const api = useOfficeApi()
  const [model, setModel] = useState<SplitModel>({ preview: LOADING, mode: 'hand', quantities: {}, reason: null, transportBy: 'CARRIER', carrierCode: '', serviceCode: '', busy: false, problem: null, made: null, prefix, into: 2, extra: [], shipToOffered: !!partyId, addresses: null, shipToAddressId: '', shipComplete: shipComplete === true })
  const latest = useRef(model)
  latest.current = model
  const key = useRef(newIdempotencyKey())

  const load = useCallback(async () => {
    setModel((state) => ({ ...state, preview: LOADING }))
    try {
      const preview = await readSplit(api, shipmentId)
      setModel((state) => ({ ...state, preview: ready(preview), mode: preview.splittable ? state.mode : preview.rules.some((rule) => rule.shipments.length > 0) ? 'rule' : state.mode }))
    } catch (error) {
      setModel((state) => ({ ...state, preview: failed(error) }))
    }
  }, [api, shipmentId])

  useEffect(() => {
    void load()
  }, [load])

  // ---- F-OS-302 (X1-B4): the customer's approved delivery addresses, read once that reason is picked (again on Try again) ----
  const loadAddresses = useCallback(async () => {
    if (!partyId) return
    setModel((state) => ({ ...state, addresses: LOADING }))
    try {
      const addresses = await listShipToAddresses(api, partyId)
      const choices: ShipToChoice[] = addresses.filter((address) => address.id !== shipToAddressId).map((address) => ({ id: address.id, label: [address.name, address.line1, `${address.postalCode} ${address.city}`, address.country].filter(Boolean).join(', ') }))
      setModel((state) => ({ ...state, addresses: ready(choices), shipToAddressId: choices.length === 1 ? choices[0]!.id : state.shipToAddressId }))
    } catch (error) {
      setModel((state) => ({ ...state, addresses: failed(error) }))
    }
  }, [api, partyId, shipToAddressId])

  const actions = useMemo<SplitActions>(
    () => ({
      onRetry: () => void load(),
      onMode: (mode) => setModel((state) => ({ ...state, mode, problem: null })),
      onQuantity: (lineId, quantity) => setModel((state) => ({ ...state, quantities: { ...state.quantities, [lineId]: quantity }, problem: null })),
      onReason: (reason) => {
        setModel((state) => ({ ...state, reason, problem: null }))
        if (reason === 'SHIP_TO' && latest.current.addresses === null) void loadAddresses() // F-OS-302
      },
      // ---- F-OS-302 (B-OS-010): into several — how many, the garments of each new shipment, the delivery address ----
      onInto: (into) => setModel((state) => ({ ...state, into: Math.max(2, Math.min(INTO_MAX, into)), problem: null })),
      onGroupQuantity: (group, lineId, quantity) =>
        setModel((state) => {
          if (group === 0) return { ...state, quantities: { ...state.quantities, [lineId]: quantity }, problem: null }
          const extra = [...(state.extra ?? [])]
          while (extra.length < group) extra.push({})
          extra[group - 1] = { ...extra[group - 1], [lineId]: quantity }
          return { ...state, extra, problem: null }
        }),
      onShipTo: (addressId) => setModel((state) => ({ ...state, shipToAddressId: addressId, problem: null })),
      onRetryAddresses: () => void loadAddresses(),
      // ---- end F-OS-302
      onDelivery: (next) => setModel((state) => ({ ...state, ...next, problem: null })),
      onClose,
      onSplit: () => {
        const state = latest.current
        if (state.preview.state !== 'ready' || splitHeld(state, state.preview.value)) return
        const preview = state.preview.value
        const body = state.mode === 'hand' ? handBody(state, preview) : null
        if (state.mode === 'hand' && !body) return
        setModel((current) => ({ ...current, busy: true, problem: null }))
        const run = state.mode === 'rule' ? splitByRule(api, shipmentId, preview.version, key.current) : splitByHand(api, shipmentId, body!, key.current)
        run
          .then((made) => {
            key.current = newIdempotencyKey()
            setModel((current) => ({ ...current, busy: false, made }))
            onDone()
          })
          .catch((error: unknown) => {
            const problem = writeWords(error, 'split.refusal', SPLIT_REFUSALS)
            setModel((current) => ({ ...current, busy: false, problem: { key: problem.key, params: problem.params } }))
            if (problem.reload) void load()
          })
      },
    }),
    [api, shipmentId, load, onClose, onDone, loadAddresses],
  )

  return <SplitDialog model={model} actions={actions} />
}
