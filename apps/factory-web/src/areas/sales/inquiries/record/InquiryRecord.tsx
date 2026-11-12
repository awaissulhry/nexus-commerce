'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { recordTabOf, type RecordTab } from '../model'
import { useInquiry } from '../use-inquiry'
import { InquiryPageView } from '../view/InquiryPageView'

/**
 * `/w/<company>/sales/inquiries/<id>` (design tab:inquiries.full; `?tab=request|files|quote|activity`): the inquiry's full
 * page in its own tab, on the same container as the list's DetailModal (`use-inquiry.tsx`). A decision keeps the page on the
 * inquiry (read again, its receipt shown): the queue's "next" belongs to the list.
 */
export function InquiryRecord({ inquiryId }: { inquiryId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = recordTabOf(params)
  const onTab = useCallback((next: RecordTab) => router.replace(`${pathname}${next === 'request' ? '' : `?tab=${next}`}`, { scroll: false }), [router, pathname])
  const { model, actions, slots, asOf } = useInquiry({ inquiryId, tab, onTab })
  return <InquiryPageView model={model} actions={actions} slots={slots} asOf={asOf} />
}
