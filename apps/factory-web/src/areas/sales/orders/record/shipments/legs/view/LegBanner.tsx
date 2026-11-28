'use client'

import type { ReactElement } from 'react'
import { Warehouse } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { useT } from '../../../../../../../lib/i18n/provider'
import type { Leg } from '../api'
import type { LegAct } from '../model'
import { LegMarks } from './LegMarks'

/**
 * owb-ss3 step 3.3 (design plan § 7; settle L5) — Warehouse's shipment record says it once, in its notices: this shipment goes to our
 * warehouse first (which one), where it is now and the act it offers this reader (the SAME marks and the SAME window as the order's
 * Shipments tab). Before it leaves: the first leg travels as a transfer (the DDT window presets it). Draws its input; fetches nothing.
 */
export function LegBanner({ leg, status, acts, onAct }: { leg: Leg; status: string; acts: readonly LegAct[]; onAct?: (act: LegAct) => void }): ReactElement {
  const t = useT('ship-ways')
  const before = status === 'DRAFT' || status === 'PACKED'
  return (
    <Banner tone="info" icon={<Warehouse size={18} aria-hidden />} title={t('leg.record.title', { place: leg.warehouse.city ? `${leg.warehouse.name}, ${leg.warehouse.city}` : leg.warehouse.name })}>
      {before ? <span>{t('leg.record.transfer')} </span> : null}
      <LegMarks leg={leg} status={status} acts={acts} onAct={onAct} />
    </Banner>
  )
}
