'use client'

import Link from 'next/link'
import { Banner } from '@nexus/ui/components'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NAMESPACES } from '../../queue/shared/depth'
import { useDepthWords } from '../../queue/shared/DepthDialog'
import type { Holds } from '../api'
import { inForce, MONEY_REASONS } from '../model'
import '../../shipments.css'

/**
 * The record's band line while a hold is in force (SCR-592; Owner rule W2b-6 "a held shipment says who may release it"):
 * the reasons, that it cannot be packed, labelled or handed over, who releases it, and a link to its holds when the reader is
 * on another tab. Nothing while none is in force.
 */
export function HoldBanner({ holds, holdsHref }: { holds: Holds | null; holdsHref: string | null }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <HoldLine holds={holds} holdsHref={holdsHref} />
    </WithMessages>
  )
}

function HoldLine({ holds, holdsHref }: { holds: Holds | null; holdsHref: string | null }) {
  const { t } = useDepthWords()
  if (!holds?.held) return null
  const live = inForce(holds)
  const reasons = [...new Set(live.map((hold) => t(`holdReason.${hold.reason}`)))].join(', ')
  const finance = live.some((hold) => hold.bySystem || MONEY_REASONS.includes(hold.reason))
  return (
    <Banner tone="danger" title={t('holds.banner', { reasons })}>
      {finance ? t('holds.bannerFinance') : t('holds.bannerWarehouse')}{' '}
      {holdsHref && (
        <Link className="fw-sh-link" href={holdsHref}>
          {t('holds.openHolds')}
        </Link>
      )}
    </Banner>
  )
}
