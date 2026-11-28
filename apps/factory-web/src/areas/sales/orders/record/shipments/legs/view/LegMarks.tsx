'use client'

import type { ReactElement } from 'react'
import { CheckCircle2, Hourglass, Truck, Warehouse } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../../../lib/i18n/provider'
import { StateChip } from '../../../../../../../lib/order-cells/view/StateChip'
import type { Leg } from '../api'
import { legChipOf, type LegAct } from '../model'
import '../legs.css'

/**
 * owb-ss3 step 3.2 (design plan § 5n, § 7; ship.js `shRow` "It arrived at the warehouse", `whNote` "Send on to the customer") — a
 * shipment's leg on its row of the order's Shipments tab (and on Warehouse's record): on its way to our warehouse · **At our warehouse**
 * (the order life's own chip) with the customer's label here or awaited · sent on to the customer; and the act it offers this reader
 * now (by the server's `may` and the pack-and-send right: a planner sees none). Draws its input; fetches nothing.
 */
export function LegMarks({ leg, status = null, acts, onAct }: { leg: Leg; /* the shipment's status */ status?: string | null; acts: readonly LegAct[]; onAct?: (act: LegAct) => void }): ReactElement {
  const t = useT('ship-ways')
  const chip = legChipOf(leg, status)
  return (
    <span className="fw-leg-row">
      {chip.kind === 'planned' ? (
        <Tag tone="neutral">
          <Warehouse size={12} aria-hidden /> {t('leg.chip.planned', { place: chip.place })}
        </Tag>
      ) : null}
      {chip.kind === 'onTheWay' ? (
        <Tag tone="info">
          <Truck size={12} aria-hidden /> {t('leg.chip.onTheWay', { place: chip.place })}
        </Tag>
      ) : null}
      {chip.kind === 'atWarehouse' ? (
        <>
          <StateChip life="AT_OUR_WAREHOUSE" />
          <Tag tone={chip.label ? 'success' : 'warning'}>
            {chip.label ? <CheckCircle2 size={12} aria-hidden /> : <Hourglass size={12} aria-hidden />} {chip.label ? t('leg.chip.labelYes') : t('leg.chip.labelNo')}
          </Tag>
        </>
      ) : null}
      {chip.kind === 'sentOn' ? <Tag tone="neutral">{chip.withoutLabel ? t('leg.chip.sentOnNoLabel') : t('leg.chip.sentOn')}</Tag> : null}
      {acts.map((act) => (
        <Button key={act} size="sm" onClick={() => onAct?.(act)}>
          {act === 'ARRIVED' ? t('leg.act.arrived') : t('leg.act.sendOn')}
        </Button>
      ))}
    </span>
  )
}
