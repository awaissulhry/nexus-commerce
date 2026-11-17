'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { listIncoming } from '../api' // B-TH-233: Incoming's one read
import { backAddressOf, backHref, fullPageHref, inquiriesCan, queryOf, recordTabOf, type RecordTab } from '../model'
import { useInquiry } from '../use-inquiry'
import { InquiryPageView } from '../view/InquiryPageView'

/**
 * `/w/<company>/sales/incoming/<id>` (B-TH-219, threads plan TH-1b, PL5; the old /sales/inquiries/<id> redirects here): the
 * request's full page in its own tab, a deep link or a phone, on the same container as the reading pane (`use-inquiry.tsx`).
 * Opened from the list it keeps the list in `?back=` — "Back to Incoming" returns to the same filters with this request open, and
 * "3 of 41" / J / K walk the list's order page by page. A decision keeps the page on the request (read again, its receipt shown).
 */
export function InquiryRecord({ inquiryId }: { inquiryId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = recordTabOf(params)
  const { address: list, back } = useMemo(() => backAddressOf(params), [params])
  const onTab = useCallback((next: RecordTab) => router.replace(`${pathname}${next === 'request' ? '' : `?tab=${next}`}`, { scroll: false }), [router, pathname])
  const record = useInquiry({ inquiryId, tab, onTab })

  // The list it came from, for "3 of 41" (only when opened from the list: a deep link has no order to walk).
  const [ids, setIds] = useState<string[] | null>(null)
  const canView = inquiriesCan(session.permissions).view
  const queryKey = JSON.stringify(queryOf(list))
  useEffect(() => {
    if (!back || !canView) return setIds(null)
    const controller = new AbortController()
    // B-TH-233: the full page walks the list's requests (a catalogue order and a change request have no full page of a request).
    listIncoming(api, { ...(JSON.parse(queryKey) as ReturnType<typeof queryOf>), kind: 'REQUEST' }, { signal: controller.signal })
      .then((answer) => setIds(answer.rows.map((row) => row.id)))
      .catch(() => setIds(null))
    return () => controller.abort()
  }, [api, back, canView, queryKey])

  return (
    <InquiryPageView
      model={record.model}
      actions={record.actions}
      thread={record.thread}
      asOf={record.asOf}
      handled={record.handled}
      backHref={backHref(prefix, list, inquiryId)}
      nav={ids && ids.includes(inquiryId) ? { ids, onGo: (id) => router.push(fullPageHref(prefix, id, list)) } : null}
      closing={record.closing}
      rights={{ erase: session.permissions.includes('privacy.requests.manage'), closeThread: session.permissions.includes('threads.manage') }}
      onErase={() => window.open(`${prefix}/admin/privacy?view=requests&new=1&kind=ERASURE`, '_blank', 'noopener')}
      onCloseThread={record.onCloseThread}
      onConfirmClose={record.onConfirmClose}
      onCancelClose={record.onCancelClose}
    />
  )
}
