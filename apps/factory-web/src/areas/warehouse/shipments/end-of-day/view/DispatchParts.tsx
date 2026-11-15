'use client'

import { CalendarCheck2, MoreHorizontal, PackageCheck, Truck } from 'lucide-react'
import { Menu } from '@nexus/ui/components'
import { SelectionLabel } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Words } from '../../queue/shared/depth'
import type { PickupRow } from '../../pickup/api'
import { DISPATCH_NAMESPACES, DISPATCH_NS } from '../../pickup/dispatch'
import { cardPickup, pickupsByCarrier } from '../../pickup/model'
import { PickupDialog } from '../../pickup/view/PickupDialog'
import { endOfDayHeld, pickupable, pickupHeld, type DispatchListActions, type DispatchListModel, type DispatchPick } from '../list-model'
import { handOverHeld, handOverOf } from '../model'
import { EndOfDayDialog } from './EndOfDayDialog'
import { HandOverDialog } from './HandOverDialog'
import '../../pickup/dispatch.css'

/**
 * SCR-655 — what B-W2b-412 adds to the shipments list (design warehouse.shipments page.h "End of day (W2b manifest)" in the
 * band, ⋯ "Book a pickup (W2b)", sh-cutoff "W2b pickup booked 16:00" on each carrier's card, sh-grid#4 the selection row's
 * "Book pickup (W2b)" and "Mark handed over (manual carriers, W2b)"), drawn into the list's own parts (one prop each).
 */

function useWords() {
  const t = useT(DISPATCH_NS)
  return { t, say: (value: Words | null) => (value ? t(value.key, value.params) : null) }
}

/** The band: End of day, and ⋯ Book a pickup… (by hand: the site's parcels and pallets typed). */
export function DispatchBand({ model, actions }: { model: DispatchListModel; actions?: DispatchListActions }) {
  return (
    <WithMessages namespaces={DISPATCH_NAMESPACES}>
      <Band model={model} actions={actions} />
    </WithMessages>
  )
}

function Band({ model, actions }: { model: DispatchListModel; actions?: DispatchListActions }) {
  const { t, say } = useWords()
  const pickupBlocked = say(pickupHeld(model, null))
  return (
    <>
      <Button size="sm" heldReason={say(endOfDayHeld(model))} onClick={() => actions?.onEndOfDay?.()}>
        <CalendarCheck2 size={14} aria-hidden /> {t('band.endOfDay')}
      </Button>
      <Menu
        label={<MoreHorizontal size={16} aria-hidden />}
        align="right"
        triggerProps={{ 'aria-label': t('band.more') }}
        items={[{ id: 'pickup', label: t('band.bookPickup'), disabled: !!pickupBlocked, description: pickupBlocked ?? undefined, onSelect: () => actions?.onPickup?.([]) }]}
      />
    </>
  )
}

/** A carrier card's pickups today ("Pickup booked 16:00"; a failure in red). */
export function PickupCardLine({ rows }: { rows: readonly PickupRow[] | undefined }) {
  return (
    <WithMessages namespaces={DISPATCH_NAMESPACES}>
      <CardLine rows={rows} />
    </WithMessages>
  )
}

function CardLine({ rows }: { rows: readonly PickupRow[] | undefined }) {
  const { say } = useWords()
  const line = cardPickup(rows)
  if (!line) return null
  return (
    <span className="fw-shd-chips">
      <Tag tone={line.tone}>
        <Truck size={12} aria-hidden /> {say(line.words)}
      </Tag>
    </span>
  )
}

/** The pickups of the day by carrier code, for the cut-off cards (empty while unread). */
export const pickupsOf = (model: DispatchListModel | null | undefined): Map<string, PickupRow[]> => (model?.pickups?.state === 'ready' ? pickupsByCarrier(model.pickups.value) : new Map())

/** The selection row's Book pickup N and Mark handed over N (beside Hold N). */
export function DispatchSelection({ model, actions, picked }: { model: DispatchListModel; actions?: DispatchListActions; picked: readonly DispatchPick[] }) {
  return (
    <WithMessages namespaces={DISPATCH_NAMESPACES}>
      <Selection model={model} actions={actions} picked={picked} />
    </WithMessages>
  )
}

function Selection({ model, actions, picked }: { model: DispatchListModel; actions?: DispatchListActions; picked: readonly DispatchPick[] }) {
  const { t, say } = useWords()
  const pickups = pickupable(picked).length
  const handing = handOverOf(picked).go.length
  return (
    <>
      <Button size="sm" aria-label={t('selection.pickup', { count: pickups })} heldReason={say(pickupHeld(model, picked))} onClick={() => actions?.onPickup?.(picked)}>
        <Truck size={13} aria-hidden /> <SelectionLabel>{t('selection.pickup', { count: pickups })}</SelectionLabel>
      </Button>
      <Button size="sm" aria-label={t('selection.handOver', { count: handing })} heldReason={say(handOverHeld(picked, model.can))} onClick={() => actions?.onHandOver?.(picked)}>
        <PackageCheck size={13} aria-hidden /> <SelectionLabel>{t('selection.handOver', { count: handing })}</SelectionLabel>
      </Button>
    </>
  )
}

/** The pop-ups: Book a pickup, End of day (with its preview), Mark handed over. */
export function DispatchDialogs({ model, actions }: { model: DispatchListModel; actions?: DispatchListActions }) {
  return (
    <>
      {model.pickup && <PickupDialog model={model.pickup} actions={actions?.pickup} />}
      {model.endOfDay && <EndOfDayDialog model={model.endOfDay} actions={actions?.endOfDay} />}
      {model.handOver && <HandOverDialog model={model.handOver} onGo={actions?.onHandOverGo} onClose={actions?.onHandOverClose} />}
    </>
  )
}
