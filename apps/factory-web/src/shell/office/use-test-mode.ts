'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { browserApi } from '../../lib/api/browser'
import type { ApiClient } from '../../lib/api/client'
import { useLiveChanges } from '../../record-panels/live'
import { NO_TEST_MODES, TEST_MODE_EVENTS, testModeBanner, type TestModeNotices, type TestModeRights } from './test-mode'
import type { SystemBanner } from './view/OfficeShellView'

/** A burst of changes (several sites switched) is one read. */
const SETTLE_MS = 800

const noticesSchema = z.object({
  testModes: z.object({
    carrierSites: z.array(z.object({ siteId: z.string(), name: z.string() })),
    eInvoicingCompanies: z.array(z.object({ companyId: z.string(), name: z.string() })),
  }),
})

/** B-W2b-F49: GET /shell/notices?companyId (any signed-in office person): what is in test mode where the person works. */
export const readShellNotices = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<TestModeNotices> =>
  api.get('/shell/notices', { query: { companyId: companyId ?? undefined }, schema: noticesSchema, signal }).then((answer) => answer.testModes)

/**
 * B-W2b-437: the shell's TEST MODE banner, live (test-mode.ts says what it shows). B-W2b-F49: ONE read for every office
 * person (`GET /shell/notices`) when the shell mounts (a page load) or the company changes — never on every page — then again
 * on a test-mode event and after a reconnect. The live layer sends shipping.test_mode_changed only to shipping.view and
 * e_invoicing.settings_changed only to invoices.view (their definitions' live permission): a person without them sees a
 * change at the next page load or reconnect. A failed read shows nothing (the banner is a reminder; each settings page says
 * the state in full).
 */
export function useTestModeBanner(company: string, companyId: string | null, rights: TestModeRights): SystemBanner | null {
  const api = useMemo(() => browserApi({ company }), [company])
  const [notices, setNotices] = useState<TestModeNotices>(NO_TEST_MODES)
  const seq = useRef(0)
  const read = useCallback(async () => {
    const mine = ++seq.current
    const answer = await readShellNotices(api, companyId).catch(() => NO_TEST_MODES)
    if (mine === seq.current) setNotices(answer)
  }, [api, companyId])

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
    void read()
  }, [read])
  useLiveChanges({ onChange: (change) => TEST_MODE_EVENTS.includes(change.type) && soon(), onReconnect: soon })

  return testModeBanner({ notices, rights })
}
