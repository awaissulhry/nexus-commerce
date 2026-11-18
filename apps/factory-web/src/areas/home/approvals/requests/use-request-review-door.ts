'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { recordAddress } from '../../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { grainsOf } from '../../../sales/quotes/model'
import type { BrandRequest } from './api'
import { DOOR_PARAM, doorAddress, doorTargetOf, type FollowUp, type RequestDoorList } from './model'
import { clearRush, liftCustomerPause, probeOpen, useRequestReview, type RequestNotice } from './use-request-review'
import type { RequestDoorParts } from './view/RequestReview'

/**
 * F-SA-240 (sales page plan P5, P24; 14-change-flow §3.1, §3.5) — the door hook: ONE review window (requests/view/RequestReview.tsx),
 * opened from any office page that lists a customer's requests — the order page (band notice "Answer…", Overview "Waiting on us",
 * Changes), the order's thread (the ask's card) and the customer's Work tab —, beside Home › Approvals (which keeps its own host,
 * Approvals.tsx). Host-agnostic: the door gives its own list (the ‹ › arrows walk it), its live state, and what it reads again after
 * an answer; the hook keeps the window in the page's own address (`?open=<id>`, every other word kept: Esc / Close returns to the
 * same tab and scroll), reads the request or batch through use-request-review (the same reads, answers, Idempotency-Keys and
 * refusals in words as Approvals), and keeps the door's notice and the follow-ups ("Lift the hold" with why, "Clear rush").
 *
 * An id the address names that the door does not list (a link from the bell, "Open the batch") is asked of the API — a customer's
 * request, else a batch; another customer's reads "not there any more" (PW-H01b: the API's wall). After an answer the window goes
 * to the batch the request came from while others of it wait, else it closes and the notice says what was done (Approvals opens the
 * next row instead — "Next request ›"). The mount:
 *
 *     const door = useRequestReviewDoor({ ids, batches, offline, onChanged: reload, orderId })
 *     <CustomerOverrideProvider onDone={door.refresh}> … <RequestDoorNoticeBanner door={door} /> … <RequestDoorWindow door={door} />
 *     an opener: <Link href={door.hrefOf(request.id)}>Answer…</Link> (a real link, rule 40)
 */

export interface RequestDoor extends RequestDoorList {
  /** The page's live state: offline holds every answer. */
  readonly offline?: boolean
  /** The door's record changed (an answer, a refusal that reads again): the host reads its requests and its "Still to do" again. */
  readonly onChanged?: () => void
  /** The door is this order's own page: the window does not offer "Open <order>" for it. */
  readonly orderId?: string | null
  /** The address word (default `open`). */
  readonly param?: string
}

export interface RequestDoorResult extends RequestDoorParts {
  /** What the address opens (null: the window is closed). */
  readonly openId: string | null
  /** The address that opens the window on `id` on this page (null: closed), the page's other words kept. */
  readonly hrefOf: (id: string | null) => string
  /** Open the window on `id`, or close it (null), without scrolling. */
  readonly open: (id: string | null) => void
  /** Read the open request again (a "Decide for <customer>" done, the door's own change). */
  readonly refresh: () => void
}

export function useRequestReviewDoor(door: RequestDoor): RequestDoorResult {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const param = door.param ?? DOOR_PARAM
  const search = params?.toString() ?? ''
  const openId = params?.get(param) || null
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const price = useMemo(() => grainsOf(session.permissions).price, [session.permissions])
  const prefix = /^\/w\/[^/]+/.exec(pathname)?.[0] ?? companyPrefix(session.company?.code ?? '')
  const doorRef = useRef(door)
  doorRef.current = door
  const offline = door.offline ?? false

  // What the id opens: the door's own list says it; else the API is asked (a request, then a batch).
  const listed = openId ? doorTargetOf(door, openId) : null
  const [probed, setProbed] = useState<{ id: string; as: 'request' | 'batch' } | null>(null)
  useEffect(() => {
    if (!openId || listed !== null || probed?.id === openId) return
    let gone = false
    void probeOpen(api, openId, { tasks: false, requests: true }).then((as) => {
      // Neither (or another customer's): read as a request, whose read says "not there any more".
      if (!gone) setProbed({ id: openId, as: as === 'batch' ? 'batch' : 'request' })
    })
    return () => {
      gone = true
    }
  }, [api, openId, listed, probed?.id])
  const openAs = !openId ? null : (listed ?? (probed?.id === openId ? probed.as : null))

  const hrefOf = useCallback((id: string | null) => `${pathname}${doorAddress(search, id, param)}`, [pathname, search, param])
  const open = useCallback((id: string | null) => router.replace(hrefOf(id), { scroll: false }), [router, hrefOf])

  const [notice, setNotice] = useState<RequestNotice | null>(null)
  const [lift, setLift] = useState<RequestDoorParts['lift']>(null)
  const [busy, setBusy] = useState(false)

  const orderHref = useCallback(
    (request: Pick<BrandRequest, 'orderId' | 'orderNumber' | 'companyId'>) =>
      request.orderId === doorRef.current.orderId ? '' : `${prefix}${recordAddress({ type: 'SalesOrder', id: request.orderId, label: request.orderNumber, companyId: request.companyId, siteId: null }, OFFICE_PAGES)}`,
    [prefix],
  )
  const review = useRequestReview({
    api,
    openId: openAs ? openId : null,
    openAs,
    offline,
    price,
    orderHref,
    mayLift: held.has('workorders.hold'),
    onAnswered: (answered) => {
      setNotice(answered.notice)
      doorRef.current.onChanged?.()
      open(answered.then)
    },
    onReload: () => doorRef.current.onChanged?.(),
  })

  // R-23: "Clear rush" at once (each work order read for its version), "Lift the hold" with why (its dialog) — as Approvals does.
  const followUp = async (next: FollowUp) => {
    if (next.kind === 'lift') {
      setLift({ followUp: next, busy: false, problem: null })
      return
    }
    setBusy(true)
    try {
      const result = await clearRush(api, next)
      setNotice(result.failed.length > 0 ? { key: 'notice.rushNotCleared', tone: 'warning', params: { orders: result.failed.join(', ') } } : { key: 'notice.rushCleared', tone: 'success', params: { orders: result.cleared.join(', ') } })
    } finally {
      setBusy(false)
    }
  }
  const liftNow = async (reason: string) => {
    const current = lift
    if (!current) return
    setLift({ ...current, busy: true, problem: null })
    setBusy(true)
    try {
      const result = await liftCustomerPause(api, current.followUp, reason)
      setLift(null)
      setNotice(
        result.failed.length > 0
          ? { key: 'notice.holdNotLifted', tone: 'warning', params: { orders: result.failed.join(', ') } }
          : result.lifted.length > 0
            ? { key: 'notice.holdLifted', tone: 'success', params: { orders: result.lifted.join(', ') } }
            : { key: 'notice.holdNothing', tone: 'info' },
      )
      doorRef.current.onChanged?.()
      review.refresh()
    } finally {
      setBusy(false)
    }
  }

  return {
    openId,
    hrefOf,
    open,
    refresh: review.refresh,
    window: {
      review: review.model,
      grains: { price },
      offline,
      busy: busy || review.busy,
      nav: { ids: door.ids, onOpen: open },
      actions: { ...review.actions, onLift: (next) => setLift({ followUp: next, busy: false, problem: null }) },
    },
    notice,
    lift,
    can: { lift: held.has('workorders.hold'), rush: held.has('workorders.manage') },
    actions: {
      onDismiss: () => setNotice(null),
      onFollowUp: (next) => void followUp(next),
      onLiftConfirm: (reason) => void liftNow(reason),
      onLiftClose: () => setLift(null),
    },
  }
}
