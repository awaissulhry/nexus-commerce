'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { eInvoicingTouched, getEInvoicing, type CompanyEInvoicing } from './api'
import { bannerOf } from './model'
import { TestModeBannerView } from './view/TestModeBannerView'

/**
 * The test-mode banner's container (B-W2b-417): reads the e-invoicing settings of the companies the person sees (GET
 * /invoicing/e-invoicing/settings, invoices.view) and reads them again when someone goes live or back to test mode. A
 * failed read shows nothing (the banner is a reminder; Finance settings › E-invoicing says the state in full). `companyId`
 * narrows it to the one company a record belongs to.
 */
export function TestModeBanner({ companyId = null }: { companyId?: string | null }) {
  const api = useOfficeApi()
  const [companies, setCompanies] = useState<CompanyEInvoicing[]>([])
  const read = useCallback(async () => {
    try {
      setCompanies(await getEInvoicing(api))
    } catch {
      setCompanies([])
    }
  }, [api])
  useEffect(() => {
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 800)
  useLive(
    (change) => {
      if (eInvoicingTouched(change)) reread()
    },
    () => reread(),
  )
  return <TestModeBannerView model={bannerOf(companies, companyId)} />
}
