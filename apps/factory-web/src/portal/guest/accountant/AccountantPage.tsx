'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { GuestZipBody } from '@nexus/factory-domain/accounting/guest/contracts'
import { zipNameOf } from '@nexus/factory-domain/accounting/guest/files'
import type { GuestPeriodKind } from '@nexus/factory-domain/accounting/guest/periods'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame } from '../../shell/frame'
import { PortalThread } from '../../shell/thread/PortalThread'
import { fetchOverview, fetchPeriod, fileLink, saveAs, zipBytes, type Overview, type PeriodRead } from './api'
import { accountantBandOf } from './band'
import {
  accountingHref,
  addressOf,
  choicesOf,
  chosenPeriod,
  dayWords,
  exportRowsOf,
  invoiceFileIds,
  invoiceRowsOf,
  kindOf,
  NS,
  periodOfKind,
  periodWords,
  periodZipHeld,
  refusalKey,
  registerRowsOf,
} from './model'
import { AccountantClosedView, AccountantView, type AccountantActions, type AccountantViewModel } from './view/AccountantView'
import type { ListSection } from './view/Lists'

/**
 * `/p/<party>/accounting?period=` — the accountant's room (B-W2b-201, SCR-268; design portal.guest.accountant) on its API:
 * the overview (your access, the handed-over months) and the period chosen are read each on its own; a file opens from its
 * 60-second link after the API recorded the download; a zip (the whole period, its XML, the files chosen) comes as bytes the
 * API writes, recorded too. The page reads again when the tab comes back into view (a new export or lock shows up then: the
 * accounting events carry no party, so the partner live channel does not bring them). Ask finance is the frame's
 * conversation about the firm's own account (`Party`), in the element `#messages` (the band's ⋯ "Ask a question" goes there).
 */
export function AccountantRoute() {
  return (
    <WithMessages namespaces={[NS, 'portal', 'ds-words', 'lists']}>
      <Suspense fallback={null}>
        <Gate />
      </Suspense>
    </WithMessages>
  )
}

function Gate() {
  const frame = usePortalFrame()
  const opens = frame.kinds.includes('GUEST') && frame.me.permissions.includes('portal.accounting.view')
  return opens ? <Container /> : <Closed />
}

function Closed() {
  const t = useT(NS)
  const frame = usePortalFrame()
  usePortalBand({ title: t('title'), back: { href: frame.prefix, label: t('noAccess.home') } })
  return <AccountantClosedView model={{ homeHref: frame.prefix }} />
}

type Async<T> = { state: 'loading' | 'error' | 'ready'; value: T | null }
const NONE: Record<ListSection, string[]> = { exports: [], invoices: [], registers: [] }
const SLOW_MS = 1000

function Container() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const t = useT(NS)
  const locale = useLocale()
  const router = useRouter()
  const params = useSearchParams()
  const address = addressOf(params)
  const [overview, setOverview] = useState<Async<Overview>>({ state: 'loading', value: null })
  const [period, setPeriod] = useState<{ state: 'loading' | 'error' | 'ready' | 'refused'; value: PeriodRead | null; refusal: string | null }>({ state: 'loading', value: null, refusal: null })
  const [selected, setSelected] = useState<Record<ListSection, string[]>>(NONE)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<AccountantViewModel['notice']>(null)
  const [slow, setSlow] = useState(false)
  const [offline, setOffline] = useState(false)
  const [now] = useState(() => Date.now())
  const reading = useRef<AbortController | null>(null)
  const shown = chosenPeriod(address, overview.value)

  const readOverview = useCallback(async () => {
    try {
      const value = await fetchOverview(api)
      setOverview({ state: 'ready', value })
    } catch {
      setOverview((current) => ({ state: current.value ? 'ready' : 'error', value: current.value }))
    }
  }, [api])

  const readPeriod = useCallback(
    async (key: string | null) => {
      reading.current?.abort()
      if (!key) return
      const control = new AbortController()
      reading.current = control
      setPeriod((current) => ({ state: current.value && current.value.period.key === key ? current.state : 'loading', value: current.value?.period.key === key ? current.value : null, refusal: null }))
      try {
        const value = await fetchPeriod(api, key, control.signal)
        if (control.signal.aborted) return
        setPeriod({ state: 'ready', value, refusal: null })
        setSelected((current) => ({
          exports: current.exports.filter((id) => value.exports.some((batch) => batch.files.some((file) => file.file.id === id))),
          invoices: current.invoices.filter((id) => value.invoices.some((row) => row.id === id)),
          registers: current.registers.filter((id) => value.registers.some((row) => row.file.id === id)),
        }))
      } catch (error) {
        if (control.signal.aborted) return
        const key = refusalKey(error)
        const refused = key === 'refusal.PERIOD_NOT_SHARED' || key === 'refusal.NOT_ACCOUNTANT'
        setPeriod((current) => (refused ? { state: 'refused', value: null, refusal: key } : { state: current.value ? 'ready' : 'error', value: current.value, refusal: null }))
      }
    },
    [api],
  )

  useEffect(() => {
    void readOverview()
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [readOverview])

  useEffect(() => {
    if (overview.state !== 'ready') return
    void readPeriod(shown)
  }, [overview.state, shown, readPeriod])

  // A new export or lock shows up when the tab comes back into view; offline holds downloads.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void readOverview()
      void readPeriod(chosenPeriod(addressOf(new URLSearchParams(window.location.search)), null) ?? shown)
    }
    const onLine = () => setOffline(!navigator.onLine)
    onLine()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onLine)
    window.addEventListener('offline', onLine)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onLine)
      window.removeEventListener('offline', onLine)
    }
  }, [readOverview, readPeriod, shown])

  const go = useCallback((next: string | null) => router.replace(accountingHref(frame.prefix, next), { scroll: false }), [router, frame.prefix])
  const preview = frame.me.preview || overview.value?.access.preview === true
  const facts = { preview, offline, busy: busy !== null }

  const download = useCallback(
    async (fileId: string, name: string) => {
      if (!shown || busy) return
      setBusy(fileId)
      try {
        const answer = await fileLink(api, fileId, shown, newIdempotencyKey())
        saveAs({ url: answer.download.url }, answer.file.name || name)
        setNotice({ key: 'done.file', params: { name: answer.file.name || name }, tone: 'success' })
      } catch (error) {
        setNotice({ key: refusalKey(error), tone: 'danger' })
        if (refusalKey(error) === 'refusal.FILE_NOT_IN_PERIOD') void readPeriod(shown)
      } finally {
        setBusy(null)
      }
    },
    [api, busy, shown, readPeriod],
  )

  const zip = useCallback(
    async (body: GuestZipBody, tag: string) => {
      if (busy) return
      setBusy(`zip:${tag}`)
      try {
        const bytes = await zipBytes(api, body)
        const name = zipNameOf(overview.value?.access.company.code ?? 'company', body.period, body.what)
        saveAs({ bytes, type: 'application/zip' }, name)
        setNotice({ key: 'done.zip', params: { name }, tone: 'success' })
      } catch (error) {
        setNotice({ key: refusalKey(error), tone: 'danger' })
      } finally {
        setBusy(null)
      }
    },
    [api, busy, overview.value],
  )

  const lists = useMemo(() => {
    const value = period.value
    return {
      exports: value ? exportRowsOf(value) : null,
      invoices: value ? invoiceRowsOf(value) : null,
      registers: value ? registerRowsOf(value) : null,
    }
  }, [period.value])

  const actions: AccountantActions = {
    onRetryOverview: () => {
      setOverview({ state: 'loading', value: null })
      void readOverview()
    },
    onRetry: () => void readPeriod(shown),
    onKind: (kind: GuestPeriodKind) => go(periodOfKind(shown, kind, overview.value?.choices ?? null)),
    onPeriod: (value) => go(value),
    onSelect: (section, ids) => setSelected((current) => ({ ...current, [section]: ids })),
    onDownload: (fileId, name) => void download(fileId, name),
    onZipChosen: (section, ids) => {
      if (!shown) return
      const fileIds = section === 'invoices' ? invoiceFileIds(lists.invoices ?? [], ids) : [...ids]
      if (fileIds.length > 0) void zip({ period: shown, what: 'FILES', fileIds }, section)
    },
    onZipXml: () => {
      if (shown) void zip({ period: shown, what: 'XML' }, 'XML')
    },
    onDismissNotice: () => setNotice(null),
  }

  const files = period.state === 'ready' && period.value ? period.value.counts.files : period.state === 'refused' ? 0 : null
  const zipHold = periodZipHeld({ ...facts, files })
  const value = overview.value
  const until = value?.access.accessUntil && !preview ? dayWords(value.access.accessUntil, locale) : null
  usePortalBand(
    accountantBandOf({
      t,
      until,
      firmId: value?.access.firm.id ?? null,
      zipHeld: zipHold ? t(zipHold) : null,
      onZip: () => {
        if (shown) void zip({ period: shown, what: 'PERIOD' }, 'PERIOD')
      },
    }),
  )

  const kind = kindOf(shown)
  const model: AccountantViewModel = {
    state: overview.state,
    slow,
    access: value
      ? { firm: value.access.firm.name, company: value.access.company.name, givenBy: value.access.givenBy, accessUntil: value.access.accessUntil, endsSoon: value.access.endsSoon, preview, now }
      : null,
    period:
      value && shown
        ? {
            kind,
            value: shown,
            options: choicesOf(value.choices, kind, locale, shown),
            kinds: (['MONTH', 'QUARTER', 'YEAR'] as const).filter((entry) => (entry === 'MONTH' ? value.choices.months : entry === 'QUARTER' ? value.choices.quarters : value.choices.years).length > 0),
            months: period.value ? period.value.period.months.map((entry) => ({ month: entry.month, label: periodWords(entry.month, locale), shared: entry.shared, lock: entry.lock })) : null,
          }
        : null,
    read: { state: period.state, refusal: period.refusal },
    lists: {
      state: period.state === 'error' ? 'error' : period.state === 'ready' ? 'ready' : 'loading',
      ...lists,
      later: period.value?.later ?? [],
      selected,
      busy,
      held: preview ? 'held.preview' : offline ? 'held.offline' : null,
    },
    notice,
  }

  return (
    <AccountantView model={model} actions={actions}>
      {value ? <PortalThread type="Party" id={value.access.firm.id} title={t('ask.title')} showRecord={false} /> : null}
    </AccountantView>
  )
}
