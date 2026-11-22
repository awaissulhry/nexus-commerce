'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { cancelShipment, getShipment, unpack, type Shipment } from '../api'
import { takeOffOrder } from '../queue/move/api'
import { MOVE_REFUSAL_CODES, moveProblem, TAKE_OFF_REFUSAL_CODES } from '../queue/move/model'
import { DepthDialog, PartRead } from '../queue/shared/DepthDialog'
import { failed, LOADING, ready, writeWords, type Read, type Words } from '../queue/shared/depth'
import { DOOR_NAMESPACES, useDoorWords } from '../queue/shared/door-words'
import { readCarrierReturn, receiveCarrierReturn, setDdtRequired, type CarrierReturn } from './doors-api'
import { DDT_REQUIRED_REFUSAL_CODES, ddtRequiredBody } from './doors'
import { CancelDialog, TakeOffDialog, UnpackDialog, type DoorActions, type DoorModel } from './view/Dialogs'
import { DdtRequiredDialog, ReceiveBackDialog } from './view/DoorDialogs'

/**
 * F-OS-201 (order SHIPMENTS tab; 13-backend §7; plan O3 "one path per job") — a shipment's OWN windows opened from another page (the
 * order's Shipments row ⋯; Warehouse's record ⋯ for the two new ones): Unpack… · Cancel shipment… · Take this order off… (Warehouse's
 * dialogs, exported with a narrow model — never copied) · This shipment travels without a DDT… / Put back the DDT · Receive the
 * garments back…. It reads the shipment once (`GET /shipping/shipments/:id`; the carrier return's read for the last), then ONE write
 * through the SAME Warehouse API functions, with the version as read and its own Idempotency-Key; `onDone` says what happened (the
 * page reads itself again and says it once, with the door to Warehouse). Warehouse's record renders exactly as before.
 */

export type ShipmentDoorKind = { readonly kind: 'unpack' } | { readonly kind: 'cancel' } | { readonly kind: 'takeOff'; readonly salesOrderId: string } | { readonly kind: 'ddtRequired' } | { readonly kind: 'receiveBack' }

export interface ShipmentDoorDone {
  /** What happened, in the lane's words (`order-shipments`: door.done.*). */
  readonly words: Words
  readonly shipment: { readonly id: string; readonly number: string }
}

export function ShipmentDoor({ shipmentId, door, onDone, onClose }: { shipmentId: string; door: ShipmentDoorKind; onDone: (done: ShipmentDoorDone) => void; onClose: () => void }) {
  return (
    <WithMessages namespaces={DOOR_NAMESPACES}>
      <Door shipmentId={shipmentId} door={door} onDone={onDone} onClose={onClose} />
    </WithMessages>
  )
}

function Door({ shipmentId, door, onDone, onClose }: { shipmentId: string; door: ShipmentDoorKind; onDone: (done: ShipmentDoorDone) => void; onClose: () => void }) {
  const api = useOfficeApi()
  const { t, say } = useDoorWords()
  const [shipment, setShipment] = useState<Read<Shipment>>(LOADING)
  const [carrier, setCarrier] = useState<Read<CarrierReturn> | null>(door.kind === 'receiveBack' ? LOADING : null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Words | null>(null)
  const key = useRef(newIdempotencyKey())
  const wantsReturn = door.kind === 'receiveBack'

  const load = useCallback(async () => {
    setShipment(LOADING)
    try {
      setShipment(ready(await getShipment(api, shipmentId)))
    } catch (error) {
      setShipment(failed(error))
    }
    if (!wantsReturn) return
    try {
      setCarrier(ready(await readCarrierReturn(api, shipmentId)))
    } catch (error) {
      setCarrier(failed(error))
    }
  }, [api, shipmentId, wantsReturn])

  useEffect(() => {
    void load()
  }, [load])

  /** ONE write; done: the page reads itself again and says it; refused: said inside, read again when the API says so. */
  const write = useCallback(
    (run: (idempotencyKey: string) => Promise<unknown>, done: Words, refusal: (error: unknown) => Words & { reload: boolean }) => {
      if (busy || shipment.state !== 'ready') return
      const value = shipment.value
      setBusy(true)
      setProblem(null)
      run(key.current)
        .then(() => {
          key.current = newIdempotencyKey()
          setBusy(false)
          onDone({ words: done, shipment: { id: value.id, number: value.number } })
        })
        .catch((error: unknown) => {
          const words = refusal(error)
          setBusy(false)
          setProblem({ key: words.key, ...(words.params ? { params: words.params } : {}) })
          if (words.reload) void load()
        })
    },
    [busy, shipment, load, onDone],
  )

  const title = t(`door.title.${door.kind}`)
  if (shipment.state !== 'ready' || (carrier && carrier.state !== 'ready')) {
    const failure = shipment.state === 'error' ? shipment.problem : carrier?.state === 'error' ? carrier.problem : null
    return (
      <DepthDialog title={title} held={t('door.held.reading')} onGo={() => undefined} goLabel={title} onClose={onClose} problem={null} size="sm">
        <PartRead problem={failure} onRetry={() => void load()} label={title} />
      </DepthDialog>
    )
  }
  const value = shipment.value
  const said = say(problem)
  // Warehouse's own dialogs take its record's model; here the narrow part they read (the refusal said inside, in its own words).
  const model: DoorModel = { busy, dialogProblem: said ? { words: { key: 'problem.write.state' }, detail: said } : null, ddt: null, backorder: { value: null, problem: null } }
  const actions: DoorActions = {
    onDialog: (next) => {
      if (next === null) onClose()
    },
    onUnpack: () => write(() => unpack(api, value.id, value.version), { key: 'door.done.unpacked', params: { number: value.number } }, (error) => writeWords(error, 'move.refusal', MOVE_REFUSAL_CODES)),
    onCancel: (reason) => write(() => cancelShipment(api, value.id, value.version, reason), { key: 'door.done.cancelled', params: { number: value.number } }, (error) => writeWords(error, 'move.refusal', MOVE_REFUSAL_CODES)),
    onTakeOff: (salesOrderId, reason) => write((idempotencyKey) => takeOffOrder(api, value.id, salesOrderId, value.version, reason, idempotencyKey), { key: 'door.done.takenOff', params: { number: value.number } }, (error) => moveProblem(error, TAKE_OFF_REFUSAL_CODES)),
  }
  switch (door.kind) {
    case 'unpack':
      return <UnpackDialog shipment={value} model={model} actions={actions} />
    case 'cancel':
      return <CancelDialog shipment={value} model={model} actions={actions} />
    case 'takeOff':
      return <TakeOffDialog shipment={value} model={model} actions={actions} salesOrderId={door.salesOrderId} />
    case 'ddtRequired':
      return (
        <DdtRequiredDialog
          shipment={value}
          busy={busy}
          problem={said}
          onClose={onClose}
          onGo={(form) => write((idempotencyKey) => setDdtRequired(api, value.id, ddtRequiredBody(value, form), idempotencyKey), { key: value.ddtRequired ? 'door.done.ddtOff' : 'door.done.ddtBack', params: { number: value.number } }, (error) => writeWords(error, 'door.ddt.refusal', DDT_REQUIRED_REFUSAL_CODES))}
        />
      )
    case 'receiveBack': {
      const read = carrier?.state === 'ready' ? carrier.value : null
      if (!read) return null
      return (
        <ReceiveBackDialog
          read={read}
          busy={busy}
          problem={said}
          onClose={onClose}
          onGo={(form) => write((idempotencyKey) => receiveCarrierReturn(api, value.id, { version: read.version, ...(form.locationId ? { locationId: form.locationId } : {}), note: form.note.trim() || null }, idempotencyKey), { key: 'door.done.received', params: { number: value.number, count: read.garments } }, (error) => writeWords(error, 'door.receive.refusal', []))}
        />
      )
    }
  }
}
