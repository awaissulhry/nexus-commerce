'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { liveMatches, useLive } from '../../quality/_shared/hooks'
import { findCustomers, listProfiles, listTemplates, PAGE_SIZE, type PartyOption, type ProfileRow, type TemplateOption, type Tiles } from './api'
import { addressOf, addressText, HOME_ADDRESS, mtmCan, queryOf, quoteHref, readProblem, recordHref, type ListAddress, type Notice } from './model'
import { MtmMessages } from './parts'
// ---- F-SA-222 (sales page plan N7, pick P12; 12-lists-board §4.4, §4.7): Orders | Riders ----
import { LIST_PATH, ordersGateOf, ridersAddressText, segmentHref, segmentOf, type MtmCan, type Segment } from './model'
import { useOrdersSheet } from '../orders/list/use-orders-sheet'
import { MtmOrdersSegment } from './view/MtmListView'
import { useMeasurementsDialog } from './use-measurements'
import { useLinkDialog, useQuoteDialog } from './use-dialogs'
import type { MtmListModel } from './view-model'
import { MtmListView } from './view/MtmListView'

/**
 * `/w/<company>/sales/made-to-measure` (SCR-036): the saved row or tile (`?view=`), the garment type (`?garment=`), the search
 * (`?q=`), New measurements (`?new=1`), Send a measurement link from the band (`?link=1`); the tiles with the list; the garment
 * types and whether made-to-measure has started for each (GATE-MTM); live `measurement_profile.*`, `measurements.submitted` (a
 * measurement link answered → a new revision waiting for the factory review), `appointment.*` and `fitting_result.*` behind "N
 * updates · Show". A row's New revision opens the record with its dialog; Use in a new quote is drawn here (the row names the
 * rider and the customer); Print worksheet opens the worksheet tab.
 *
 * F-SA-222 (sales page plan N7, pick P12; 12-lists-board §4.4, §4.7): the page shows Orders | Riders — link tabs in its band
 * (`?segment=riders`). Orders is the ONE Orders sheet (use-orders-sheet.ts) locked to made-to-measure orders (`kind=mtm`, in the
 * address), embedded (this page's band), list and board — By promise week is held with why (it reads one site's promise plan and
 * cannot narrow to made-to-measure); an empty view says why (GATE-MTM). Riders is the rider list as it was; every old address of
 * it (`?view=<rider view>`, `?garment=`, `?customer=`, `?new=1`, `?link=1`) opens Riders. Without orders.view: Riders only.
 */
export function MtmPage() {
  return (
    <MtmMessages>
      <Container />
    </MtmMessages>
  )
}

function Container() {
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => mtmCan(session.permissions), [session.permissions])
  const segment = segmentOf(params, can)
  // F-SA-222: each segment is its own part (only its reads run).
  return segment === 'orders' ? <OrdersSegment can={can} /> : <RidersSegment segmented={can.ordersView} />
}

/** F-SA-222: the band's link tabs (none without orders.view: the page is Riders only). */
function segmentsOf(prefix: string, active: Segment, shown: boolean) {
  return shown ? { active, href: (segment: Segment) => segmentHref(prefix, segment) } : null
}

/** F-SA-222: the made-to-measure orders — the Orders sheet locked to `kind=mtm`, this page's band. */
function OrdersSegment({ can }: { can: MtmCan }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const sheet = useOrdersSheet({ basePath: LIST_PATH, locked: { kind: 'mtm' }, embedded: true, keep: ['segment'] })
  // GATE-MTM: the templates say why an empty view is empty (read with product.styles.view, as the rider list reads them).
  const [templates, setTemplates] = useState<readonly TemplateOption[] | null>(null)
  useEffect(() => {
    if (!can.styles) return
    listTemplates(api, { status: 'ALL' })
      .then((answer) => setTemplates(answer.templates))
      .catch(() => setTemplates(null))
  }, [api, can.styles])
  // By promise week cannot show only made-to-measure orders: an address that asks it opens the list (the switch holds it with why).
  const week = sheet.model.layout === 'week'
  useEffect(() => {
    if (!week) return
    const next = new URLSearchParams(params?.toString() ?? '')
    next.delete('view')
    next.delete('site')
    router.replace(`${prefix}${LIST_PATH}?${next.toString()}`, { scroll: false })
  }, [week, params, prefix, router])
  return <MtmOrdersSegment sheet={sheet} gate={ordersGateOf(templates)} segments={segmentsOf(prefix, 'orders', true)} can={can} />
}

/** The rider list (SCR-036) as it was; F-SA-222: its band carries the segment tabs and its address keeps `segment=riders`. */
function RidersSegment({ segmented }: { segmented: boolean }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const language = locale === 'en' ? 'en' : 'it'
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = useMemo(() => ({ id: session.user.id, name: session.user.displayName }), [session.user.id, session.user.displayName])
  const can = useMemo(() => mtmCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  // F-SA-222: the rider list's addresses keep its segment when the page shows Orders | Riders.
  const go = useCallback((next: Partial<ListAddress>) => router.replace(`${pathname}${(segmented ? ridersAddressText : addressText)({ ...address, ...next })}`, { scroll: false }), [router, pathname, address, segmented])

  const [rows, setRows] = useState<MtmListModel['rows']>({ items: null, more: false, problem: null, matching: null })
  const [tiles, setTiles] = useState<Tiles | null>(null)
  const [tilesFailed, setTilesFailed] = useState(false)
  const [templates, setTemplates] = useState<readonly TemplateOption[] | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  // B-W2b-371 (XF2:03): the customers for "By customer" (read once, with parties.view).
  const [customers, setCustomers] = useState<readonly PartyOption[] | null>(null)
  const offset = useRef(0)
  const readId = useRef(0)
  const queryKey = JSON.stringify(queryOf(address))

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const page = await listProfiles(api, queryOf(address, 0))
      if (id !== readId.current) return
      offset.current = page.rows.length
      setRows({ items: page.rows, more: page.matching > page.rows.length, problem: null, matching: page.matching })
      setTiles(page.tiles)
      setTilesFailed(false)
      setAsOf(page.asOf)
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error), matching: null })
      setTiles(null)
      setTilesFailed(true)
    }
    // The query's text is the dependency (a new address object with the same filters reads nothing again).
  }, [api, can.view, queryKey])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null, matching: null })
    void load()
  }, [load])

  useEffect(() => {
    if (!can.parties) return
    findCustomers(api, '', companyId)
      .then(setCustomers)
      .catch(() => setCustomers(null))
  }, [api, can.parties, companyId])

  useEffect(() => {
    if (!can.styles) return
    listTemplates(api, { status: 'ALL' })
      .then((answer) => setTemplates(answer.templates))
      .catch(() => setTemplates(null))
  }, [api, can.styles])

  const more = useCallback(async () => {
    try {
      const page = await listProfiles(api, queryOf(address, offset.current))
      offset.current += page.rows.length
      setRows((now) => {
        const items = [...(now.items ?? []), ...page.rows.filter((row) => !now.items?.some((seen) => seen.id === row.id))]
        return { items, more: page.matching > items.length && page.rows.length === PAGE_SIZE, problem: null, matching: page.matching }
      })
    } catch (error) {
      setNotice({ key: readProblem(error), tone: 'danger' })
    }
  }, [api, address])

  const live = useLive(
    (change) => {
      if (!liveMatches(change, ['measurement_profile.', 'measurements.submitted', 'appointment.', 'fitting_result.', 'measurement_template.'])) return
      setUpdates((count) => count + 1)
      if (change.type === 'measurements.submitted') setNotice({ key: 'live.linkAnswered', tone: 'info' })
    },
    () => void load(),
  )
  const offline = live === 'offline'

  // ---- the dialogs --------------------------------------------------------------------------------------------------------
  const measurements = useMeasurementsDialog({
    api,
    can,
    me,
    companyId,
    offline,
    onSaved: (answer) => {
      go({ isNew: false })
      router.push(recordHref(prefix, answer.profile.id))
    },
  })
  const pointsOf = useCallback((garment: string) => templates?.find((template) => template.code === garment)?.points ?? null, [templates])
  const link = useLinkDialog({ api, can, companyId, language, offline, pointsOf })
  const quote = useQuoteDialog({ api, can, companyId, prefix, offline, onCreated: (made) => router.push(quoteHref(prefix, made.id)) })

  // `?new=1` opens New measurements, `?link=1` Send a measurement link (once per address).
  useEffect(() => {
    if (address.isNew && can.record && !measurements.model) measurements.openNew()
    if (!address.isNew && measurements.model?.mode === 'new') measurements.close()
    // Once per `?new=1`.
  }, [address.isNew, can.record])
  useEffect(() => {
    if (address.link && can.link && rows.items && !link.model) link.openFromBand(rows.items)
    // Once the rows are read.
  }, [address.link, can.link, rows.items !== null])

  const model: MtmListModel = {
    prefix,
    me: me.id,
    companyId,
    can,
    address,
    rows,
    tiles,
    tilesFailed,
    templates,
    asOf,
    live,
    updates,
    notice,
    measurements: measurements.model,
    link: link.model,
    quote: quote.model,
    customers,
    segments: segmentsOf(prefix, 'riders', segmented), // F-SA-222
  }

  const openQuote = (row: ProfileRow) => quote.open({ profileId: row.id, riderName: row.riderName, customer: row.customer.name, partyId: row.partyId, contactId: row.contactId, revision: row.revision })

  return (
    <MtmListView
      model={model}
      actions={{
        onAddress: (patch) => go(patch),
        onClearFilters: () => go(HOME_ADDRESS),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onMore: () => void more(),
        onOpen: (id) => router.push(recordHref(prefix, id)),
        onRowVerb: (row, verb) => (verb === 'quote' ? openQuote(row) : verb === 'revision' ? router.push(recordHref(prefix, row.id, 'measurements', 'revision')) : window.open(`${prefix}/sales/made-to-measure/${encodeURIComponent(row.id)}/worksheet`, '_blank', 'noopener')),
        onNew: () => go({ isNew: true }),
        onLink: () => go({ link: true }),
        measurements: {
          ...measurements.actions,
          onClose: () => {
            measurements.actions.onClose?.()
            if (!measurements.model || !Object.values(measurements.model.draft.values).some((value) => value.trim() !== '') || measurements.model.leaving) go({ isNew: false })
          },
          onDiscard: () => {
            measurements.actions.onDiscard?.()
            go({ isNew: false })
          },
        },
        link: {
          ...link.actions,
          onClose: () => {
            link.actions.onClose?.()
            go({ link: false })
          },
        },
        quote: quote.actions,
        onCopy: (lines) => {
          void navigator.clipboard
            ?.writeText(lines.join('\n'))
            .then(() => setNotice({ key: 'list.copied', params: { count: lines.length }, tone: 'success' }))
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
