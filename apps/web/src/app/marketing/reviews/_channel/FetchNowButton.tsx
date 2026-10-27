'use client'

/**
 * "Fetch now" for Amazon's seller feedback report (PR H) — the Amazon page's seller-feedback card and Settings › Sources.
 * POST /api/reviews/amazon/seller-feedback/fetch with an Idempotency-Key (a double press asks Amazon once). The API
 * starts the fetch in the background and answers at once; Amazon takes a few minutes to make the report, so the button
 * then shows the fetching state from the next read. Held, with its reason (`held`, from `fetchHeldWords` or the
 * Sources row), when the person may not manage reviews, this setup does not fetch seller feedback, Amazon is not
 * connected, or a fetch is already running.
 */
import { useState } from 'react'
import { useToast } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { reviewsSend } from '../_lib/reviewsFetch'
import type { FetchNowAnswer } from './sellerFeedbackModel'

const ASKING = 'Nexus is asking Amazon for the report now. It shows here in a few minutes.'

export function FetchNowButton({ held, fetching = false, onDone }: { held: string | null; fetching?: boolean; onDone?: () => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const reason = busy ? ASKING : held

  const fetchNow = async () => {
    setBusy(true)
    const res = await reviewsSend<FetchNowAnswer>('POST', '/reviews/amazon/seller-feedback/fetch', undefined, { idempotent: true, what: 'fetch' })
    setBusy(false)
    // New feedback arrives as reviews (live events): the pages read again by themselves.
    if (res.data) toast(res.data.words, 'success')
    else toast(res.error, 'warning')
    onDone?.()
  }

  return reason
    ? <Button size="sm" heldReason={reason}>{busy || fetching ? 'Fetching…' : 'Fetch now'}</Button>
    : <Button size="sm" onClick={() => void fetchNow()}>Fetch now</Button>
}
