'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useCoalesced, useLive } from '../_shared/hooks'
import { changeSubscription, getDaily, listRecipients, listSubscriptions, subscribe, type DailyReport, type Recipient, type Subscription } from './api'
import {
  addressOf,
  draftOf,
  LIVE_COALESCE_MS,
  liveTouches,
  mySubscription,
  othersSubscribed,
  readProblem,
  reportsCanOf,
  reportsHref,
  subscribeBody,
  subscribeHeld,
  subscribeProblem,
  toggleDay,
  toggleRecipient,
  type Phrase,
  type ReportAddress,
  type SubscribeDraft,
} from './model'
import { ReportsView, type ReportsActions, type ReportsModel } from './view/ReportsView'
import type { SubscribeModel } from './view/SubscribeDialog'

/**
 * `/w/<company>/production/reports` (SCR-240): reads the day's report of the site in the address (`?site=&date=`; else the
 * API's first site, today) and my e-mail subscriptions, reads the report again when the floor reports (at most once a
 * minute, the design), and runs the "Email me this report" dialog (the colleagues who may get it are read when it opens,
 * for whoever may subscribe them). Nothing per person is asked for: the API serves none.
 */
export function ReportsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/reports\/?$/, '')
  const can = useMemo(() => reportsCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const [daily, setDaily] = useState<{ value: DailyReport | null; problem: string | null }>({ value: null, problem: null })
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null)
  const [dialog, setDialog] = useState<{ draft: SubscribeDraft; people: { value: Recipient[] | null; problem: string | null }; busy: boolean; problem: Phrase | null } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const asked = useRef(address)
  asked.current = address

  const load = useCallback(async () => {
    // Without production.reports.view the page says so and asks the API nothing (it would refuse).
    if (!can.view) return
    const target = asked.current
    try {
      const value = await getDaily(api, { siteId: target.site, date: target.date })
      if (asked.current === target) setDaily({ value, problem: null })
    } catch (error) {
      if (asked.current === target) setDaily({ value: null, problem: readProblem(error) })
    }
    setNow(Date.now())
    listSubscriptions(api)
      .then(setSubscriptions)
      .catch(() => setSubscriptions([]))
  }, [api, can.view])

  useEffect(() => {
    setDaily((current) => ({ value: current.value && current.value.site.id === address.site && current.value.day === address.date ? current.value : null, problem: null }))
    void load()
  }, [load, address])

  const reread = useCoalesced(() => void load(), LIVE_COALESCE_MS)
  const live = useLive(
    (change) => {
      if (liveTouches(change)) reread()
    },
    () => void load(),
  )

  const go = (next: ReportAddress) => router.replace(reportsHref(prefix, next), { scroll: false })
  const site = daily.value?.site ?? null
  const mine = mySubscription(subscriptions, site?.id ?? null)
  const me = { id: session.user.id, name: session.user.displayName }

  const openSubscribe = () => {
    if (!site) return
    setDialog({ draft: draftOf(mine, me.id), people: { value: null, problem: null }, busy: false, problem: null })
    if (can.subscribe)
      listRecipients(api, site.id)
        .then((value) => setDialog((current) => (current ? { ...current, people: { value, problem: null } } : current)))
        .catch((error: unknown) => setDialog((current) => (current ? { ...current, people: { value: null, problem: readProblem(error) } } : current)))
  }

  const actions: ReportsActions = {
    onSite: (siteId) => go({ site: siteId, date: address.date }),
    onDay: (date) => go({ site: site?.id ?? address.site, date: date === daily.value?.today ? null : date }),
    onRetry: () => void load(),
    onOpenSubscribe: openSubscribe,
    onCloseSubscribe: () => setDialog(null),
    onDraft: (change) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, ...change }, problem: null } : current)),
    onToggleDay: (day) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, weekdays: toggleDay(current.draft.weekdays, day) }, problem: null } : current)),
    onToggleRecipient: (id) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, recipients: toggleRecipient(current.draft.recipients, id) }, problem: null } : current)),
    onSubscribe: () => {
      if (!dialog || !site || dialog.busy || subscribeHeld(dialog.draft, can, me.id)) return
      const draft = dialog.draft
      setDialog({ ...dialog, busy: true, problem: null })
      subscribe(api, subscribeBody(draft, site.id, me.id))
        .then(() => {
          setDialog(null)
          return listSubscriptions(api).then(setSubscriptions)
        })
        .catch((error: unknown) => setDialog((current) => (current ? { ...current, busy: false, problem: subscribeProblem(error, current.people.value ?? [], draft.recipients) } : current)))
    },
    onTurnOff: (row) => {
      setDialog((current) => (current ? { ...current, busy: true, problem: null } : current))
      changeSubscription(api, row.id, { version: row.version, active: false })
        .then(() => listSubscriptions(api).then(setSubscriptions))
        .then(() => setDialog((current) => (current ? { ...current, busy: false } : current)))
        .catch((error: unknown) => setDialog((current) => (current ? { ...current, busy: false, problem: subscribeProblem(error, [], []) } : current)))
    },
  }

  const dialogModel: SubscribeModel | null =
    dialog && site
      ? { site: { id: site.id, code: site.code, name: site.name }, me, can, draft: dialog.draft, mine, others: othersSubscribed(subscriptions, site.id), people: dialog.people, busy: dialog.busy, problem: dialog.problem }
      : null
  const model: ReportsModel = { prefix, can, address, daily, mine, live, now, dialog: dialogModel }
  return <ReportsView model={model} actions={actions} />
}
