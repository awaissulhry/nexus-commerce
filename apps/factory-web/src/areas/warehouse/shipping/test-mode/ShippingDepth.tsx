'use client'

import { useMemo } from 'react'
import { useOfficeSession } from '../../../../lib/session/context'
import { dispatchAbilitiesOf } from '../../shipments/pickup/dispatch'
import { Contracts } from '../contracts/Contracts'
import { Eori } from '../eori/Eori'
import { Packaging } from '../packaging/Packaging'
import { TestMode } from './TestMode'
import '../../shipments/pickup/dispatch.css'

/**
 * What B-W2b-412 adds to Carriers & shipping (SCR-068; SCR-656 … SCR-659), below the W1 form of the chosen site (each card
 * reads and writes on its own, outside that form): Test mode and Switch to live labels, our own carrier contracts, EORI with the
 * broker-pack switch, and Packaging. The W1 page passes the company and the site it shows.
 */
export function ShippingDepth({ companyId, siteId, siteCode }: { companyId: string | null; siteId: string | null; siteCode: string | null }) {
  const session = useOfficeSession()
  const can = useMemo(() => dispatchAbilitiesOf(session.permissions), [session.permissions])
  return (
    <div className="fw-shipset fw-dsp-settings">
      <div className="fw-shipset-grid">
        <TestMode companyId={companyId} siteId={siteId} can={can} />
        {companyId && <Eori companyId={companyId} siteId={siteId} can={can} />}
        {companyId && <Contracts companyId={companyId} siteId={siteId} siteCode={siteCode} can={can} />}
        {companyId && <Packaging companyId={companyId} can={can} />}
      </div>
    </div>
  )
}
