'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeSession } from '../../../../lib/session/context'
import { ReprintCard, useOwnTransport } from '../booking/CarrierDepth'
import { TransportView } from '../booking/view/TransportView'
import { CartonsCard } from '../cartons/CartonsCard'
import { useShipmentHolds } from '../holds/use-holds'
import { HoldBanner } from '../holds/view/HoldBanner'
import { HoldsDialogsView, HoldsPanelView } from '../holds/view/HoldsPanelView'
import { inForce, placeHeld } from '../holds/model'
import { CustomerNotice } from '../notice/CustomerNotice'
import { Papers } from '../papers/Papers'
import { Delivery } from '../pod/Delivery'
import { depthAbilitiesOf, DEPTH_NS } from './shared/depth'
import { Split } from './split/Split'
// F-OS-203 (order SHIPMENTS tab; L6): Move / Merge and the two new windows — ONE component each, mounted here and on the order's tab.
import { Move } from './move/Move'
import { ShipmentDoor, type ShipmentDoorKind } from '../record/ShipmentDoor'
import { DOOR_NS } from './shared/door-words'
// B-W2b-412
import { ExportPapers } from '../export/ExportPapers'

/**
 * What B-W2b-410 adds to a shipment's record (SCR-067; SCR-592 … SCR-598), each part its own container slotted into the W1
 * tabs: the holds (the band's line, "No hold" in Ready to ship, the next step held with why, Place a hold… in ⋯), Split… in
 * ⋯ (a DRAFT), the cartons with contents and serials (Lines & cartons), how it travels and the label prints (Carrier &
 * label), the pack, the proforma and the public DoC pages (Documents), the proof of delivery, the tracking problems and the
 * customer notice (Tracking & delivery).
 */
export interface ShipmentDepthSlots {
  readonly banner: ReactNode
  /** Why the next step waits on a hold (pack, labels, hand over), in words; null: no hold in force. */
  readonly stepHeld: string | null
  readonly holds: ReactNode
  readonly held: boolean
  /** A carrier booked by hand: no label is bought (the next step goes on to the hand-over). */
  readonly noLabels: boolean
  readonly cartons: ReactNode
  readonly booking: ReactNode
  readonly labels: ReactNode
  readonly papers: ReactNode
  readonly delivery: ReactNode
  readonly notice: ReactNode
  /** B-W2b-412: the Export tab's papers (commercial invoice, CN 22 / CN 23, the declaration, the broker's pack). */
  readonly exportPapers: ReactNode
  /** Items of the record's ⋯ (Place a hold…, Split…). */
  readonly more: readonly { id: string; label: string; disabled?: boolean; description?: string; onSelect: () => void }[]
  readonly dialogs: ReactNode
}

export interface RecordDepthInput {
  readonly shipment: {
    readonly id: string
    readonly number: string
    readonly status: string
    readonly version: number
    readonly companyId: string
    readonly parcels: readonly { readonly id: string; readonly trackingNumber: string | null }[]
    readonly lines: readonly { readonly styleId: string; readonly styleCode: string; readonly styleName: string }[]
    /** F-OS-203: whether it needs a DDT, and whether it was made in Nexus (travels without a DDT…). */
    readonly ddtRequired?: boolean
    readonly origin?: 'NEXUS' | 'ELSEWHERE'
    /** F-OS-302 (X1-B4): its customer (the delivery addresses Split may choose) and its own delivery address (left out of them). */
    readonly partyId?: string
    readonly shipToAddressId?: string | null
  } | null
  readonly prefix: string
  readonly tab: string
  readonly busy: boolean
  /** The tracking facts W1 read (the expected and returned days beside the proof of delivery). */
  readonly expectedAt: string | null
  readonly returnedAt: string | null
  /** The record's own (W1) actions the cartons card lends. */
  readonly onAddCarton: () => void
  readonly onWeigh: (parcelId: string) => void
  readonly onRemoveCarton: (parcelId: string) => void
  readonly onPackingList: () => void
  /** Read the record again (a hold, an arrangement, a split moved it). */
  readonly onReload: () => void
}

export function useRecordDepth(input: RecordDepthInput): ShipmentDepthSlots {
  const t = useT(DEPTH_NS)
  const session = useOfficeSession()
  const can = useMemo(() => depthAbilitiesOf(session.permissions), [session.permissions])
  const shipment = input.shipment
  const id = shipment?.id ?? ''
  const version = shipment?.version ?? 0
  const holds = useShipmentHolds(id, version, can, input.onReload)
  const transport = useOwnTransport(id, version, can, input.onReload)
  const [splitOpen, setSplitOpen] = useState(false)
  // F-OS-203: the shared window open from the ⋯ (Move / Merge, travels without a DDT, receive the garments back).
  const own = useT(DOOR_NS)
  const [door, setDoor] = useState<null | { readonly kind: 'move' | 'merge' } | { readonly kind: 'door'; readonly door: ShipmentDoorKind }>(null)
  const mayDdt = session.permissions.includes('shipping.ddt.issue')
  const styles = useMemo(() => {
    const seen = new Map<string, { id: string; code: string; name: string }>()
    for (const line of shipment?.lines ?? []) if (!seen.has(line.styleId)) seen.set(line.styleId, { id: line.styleId, code: line.styleCode, name: line.styleName })
    return [...seen.values()]
  }, [shipment?.lines])

  if (!shipment) return { banner: null, stepHeld: null, holds: null, held: false, noLabels: false, cartons: null, booking: null, labels: null, papers: null, delivery: null, notice: null, exportPapers: null, more: [], dialogs: null }

  const held = holds.holds?.held ?? false
  const reasons = holds.holds ? [...new Set(inForce(holds.holds).map((hold) => t(`holdReason.${hold.reason}`)))].join(', ') : ''
  const placeBlocked = holds.holds ? placeHeld(holds.holds, holds.model.can, holds.model.busy) : null
  const open = shipment.status === 'DRAFT' || shipment.status === 'PACKED'
  const recordHref = `${input.prefix}/warehouse/shipments/${shipment.id}`
  return {
    banner: <HoldBanner holds={holds.holds} holdsHref={input.tab === 'lines' ? null : `${recordHref}?tab=lines`} />,
    stepHeld: held ? t('holds.stepHeld', { reasons }) : null,
    holds: <HoldsPanelView model={holds.model} actions={holds.actions} />,
    held,
    noLabels: transport.arrangement === 'MANUAL_CARRIER',
    cartons: (
      <CartonsCard
        shipmentId={shipment.id}
        version={version}
        context={{ status: shipment.status as 'DRAFT', parcels: shipment.parcels, canPack: can.pack, busy: input.busy }}
        onAdd={input.onAddCarton}
        onWeigh={input.onWeigh}
        onRemove={input.onRemoveCarton}
        onPackingList={input.onPackingList}
      />
    ),
    booking: <TransportView model={transport.model} actions={transport.actions} />,
    labels: can.pack ? <ReprintCard shipmentId={shipment.id} version={version} can={can} /> : null,
    papers: <Papers shipment={shipment} version={version} styles={styles} can={can} />,
    delivery: <Delivery shipment={shipment} version={version} can={can} facts={{ expectedAt: input.expectedAt, returnedAt: input.returnedAt }} />,
    notice: <CustomerNotice shipmentId={shipment.id} version={version} />,
    exportPapers: input.tab === 'export' ? <ExportPapers shipmentId={shipment.id} companyId={shipment.companyId} prefix={input.prefix} /> : null,
    more: [
      ...(open
        ? [
            {
              id: 'hold',
              label: t('holds.placeMenu'),
              disabled: !!placeBlocked || !holds.holds,
              description: placeBlocked ? t(placeBlocked.key, placeBlocked.params) : undefined,
              onSelect: () => holds.actions.onDialog?.({ kind: 'place', reason: null, text: '' }),
            },
          ]
        : []),
      ...(shipment.status === 'DRAFT'
        ? [
            {
              id: 'split',
              label: t('split.menu'),
              disabled: !can.manage,
              description: can.manage ? undefined : t('split.held.noManage'),
              onSelect: () => setSplitOpen(true),
            },
            // F-OS-203 (L6): the same Move garments to… / Merge into… windows as the order's Shipments tab.
            ...(can.manage
              ? [
                  { id: 'move', label: own('ships.act.move'), onSelect: () => setDoor({ kind: 'move' }) },
                  { id: 'merge', label: own('ships.act.merge'), onSelect: () => setDoor({ kind: 'merge' }) },
                ]
              : []),
          ]
        : []),
      // F-OS-203 (D6 / O7 B): this shipment travels without a DDT… / Put back the DDT (a Nexus shipment before it leaves).
      ...(open && shipment.origin !== 'ELSEWHERE' && can.manage && mayDdt ? [{ id: 'ddtRequired', label: shipment.ddtRequired === false ? own('ships.act.ddtBack') : own('ships.act.ddtOff'), onSelect: () => setDoor({ kind: 'door', door: { kind: 'ddtRequired' } }) }] : []),
      // F-OS-203 (H3-B11): the garments the carrier brought back, received into finished goods.
      ...(shipment.status === 'RETURNED' && can.manage ? [{ id: 'receiveBack', label: own('ships.act.receiveBack'), onSelect: () => setDoor({ kind: 'door', door: { kind: 'receiveBack' } }) }] : []),
    ],
    dialogs: (
      <>
        <HoldsDialogsView model={holds.model} actions={holds.actions} />
        {splitOpen && <Split shipmentId={shipment.id} prefix={input.prefix} onClose={() => setSplitOpen(false)} onDone={input.onReload} partyId={shipment.partyId} shipToAddressId={shipment.shipToAddressId ?? null} /* F-OS-302 */ />}
        {/* F-OS-203 (L6): the shared windows; done, the record reads itself again. */}
        {door && door.kind !== 'door' && (
          <Move
            shipmentId={shipment.id}
            number={shipment.number}
            mode={door.kind}
            onClose={() => setDoor(null)}
            onDone={() => {
              setDoor(null)
              input.onReload()
            }}
          />
        )}
        {door?.kind === 'door' && (
          <ShipmentDoor
            shipmentId={shipment.id}
            door={door.door}
            onClose={() => setDoor(null)}
            onDone={() => {
              setDoor(null)
              input.onReload()
            }}
          />
        )}
      </>
    ),
  }
}
