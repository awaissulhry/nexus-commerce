'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { browserApi } from '../../lib/api/browser'
import { useLiveChanges } from '../../record-panels/live'
import { getEInvoicing } from '../../areas/finance/invoices/test-mode/api'
import { readTestModes } from '../../areas/warehouse/shipping/test-mode/api'
import { TEST_MODE_EVENTS, testModeBanner, type CarrierSiteMode, type CompanyEInvoicingMode, type TestModeRights } from './test-mode'
import type { SystemBanner } from './view/OfficeShellView'

/** A burst of changes (several sites switched) is one read. */
const SETTLE_MS = 800

/**
 * B-W2b-437: the shell's TEST MODE banner, live (test-mode.ts says what it shows). ONE read of each test mode the person may
 * read when the shell mounts or the company changes — never on every page — then again on a test-mode event and after a
 * reconnect. A failed read shows nothing for that part (the banner is a reminder; each settings page says the state in full).
 */
export function useTestModeBanner(company: string, companyId: string | null, rights: TestModeRights): SystemBanner | null {
  const api = useMemo(() => browserApi({ company }), [company])
  const [modes, setModes] = useState<{ carrier: CarrierSiteMode[]; eInvoicing: CompanyEInvoicingMode[] }>({ carrier: [], eInvoicing: [] })
  const seq = useRef(0)
  const enabled = rights.carrier || rights.eInvoicing
  const read = useCallback(async () => {
    const mine = ++seq.current
    const [carrier, eInvoicing] = await Promise.all([
      rights.carrier ? readTestModes(api, companyId).catch(() => []) : Promise.resolve([]),
      rights.eInvoicing ? getEInvoicing(api).catch(() => []) : Promise.resolve([]),
    ])
    if (mine === seq.current) setModes({ carrier, eInvoicing })
  }, [api, companyId, rights.carrier, rights.eInvoicing])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void read()
    }, SETTLE_MS)
  }, [read])
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), [])

  useEffect(() => {
    if (enabled) void read()
  }, [enabled, read])
  useLiveChanges({ onChange: (change) => TEST_MODE_EVENTS.includes(change.type) && soon(), onReconnect: soon }, enabled)

  return enabled ? testModeBanner({ ...modes, companyId, rights }) : null
}
