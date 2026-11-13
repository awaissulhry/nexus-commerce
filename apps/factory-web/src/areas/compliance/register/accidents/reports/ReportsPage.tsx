'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useT } from '../../../../../lib/i18n/provider'
import { intakeBodyOf, patchIntake, refusedFields, romeToday } from '../../../../../lib/safety-reports/intake'
import { companyPrefix } from '../../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { downloadText, liveMatches, useLive } from '../../../../quality/_shared/hooks'
import { listReporters, listStyles, type PartyOption, type StyleOption } from '../../api'
import { listReports, outsideOpen, recordReport, reportCounts, type Person, type ReportCounts, type ReportRow } from '../api'
import { EMPTY_NEW, newReportProblems, NS, readProblemOf, refusalOf, reportHref, reportsAddressOf, reportsCsv, reportsQuery, safetyCan, type NewReportDraft, type ReportsAddress } from '../model'
import { SafetyMessages } from '../parts'
import type { NewReportModel } from './view/NewReportDialog'
import { ReportsListView } from './view/ReportsListView'

const LIVE_TYPES = ['safety_report.', 'accident_log.revised']

type NewState = Omit<NewReportModel, 'problems' | 'today' | 'camera'> & { tried: boolean; fields: NewReportModel['problems'] }

/**
 * `/w/<company>/compliance/register/accidents/reports` — Product-safety reports (SCR-421, B-W2b-357 on B-W2b-351's API): the
 * list with the address's terms (`?view=&source=&q=`, 50 a page, Show more by the cursor), the tiles, whether the doors from
 * outside are open, live changes behind "N updates · Show", Copy / Export of the selection (no reporter, no words, no injury),
 * and New report (`?new=1`; ONE call with one Idempotency-Key per body, then the report opens).
 */
export function ReportsPage() {
  return (
    <SafetyMessages>
      <ReportsContainer />
    </SafetyMessages>
  )
}

function ReportsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const t = useT(NS)
  const can = useMemo(() => safetyCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const address = useMemo(() => reportsAddressOf(params), [params])
  const [query, setQuery] = useState(address.q)
  const [rows, setRows] = useState<{ items: readonly ReportRow[] | null; more: string | null; problem: string | null }>({ items: null, more: null, problem: null })
  const [people, setPeople] = useState<readonly Person[] | null>(null)
  const [counts, setCounts] = useState<ReportCounts | null>(null)
  const [outside, setOutside] = useState<'open' | 'closed' | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [creating, setCreating] = useState<NewState | null>(null)
  const reading = useRef<AbortController | null>(null)
  const writeKey = useRef<{ body: string; key: string } | null>(null)
  const today = romeToday()

  const effective = useMemo(() => ({ view: address.view, source: address.source, q: query }), [address.view, address.source, query])

  const load = useCallback(async () => {
    if (!can.view) return
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const [list, tiles] = await Promise.all([listReports(api, effective, control.signal), reportCounts(api, control.signal).catch(() => null)])
      if (control.signal.aborted) return
      setRows({ items: list.reports, more: list.nextCursor, problem: null })
      setPeople(list.people)
      setCounts(tiles)
      setAsOf(list.asOf)
      setUpdates(0)
      setSelected((current) => current.filter((id) => list.reports.some((row) => row.id === id)))
    } catch (error) {
      if (control.signal.aborted) return
      setRows({ items: null, more: null, problem: readProblemOf(error) })
    }
  }, [api, effective, can.view])

  useEffect(() => {
    const timer = setTimeout(() => void load(), query === address.q ? 0 : 250)
    return () => clearTimeout(timer)
  }, [load, query, address.q])

  useEffect(() => {
    outsideOpen(api)
      .then((open) => setOutside(open ? 'open' : 'closed'))
      .catch(() => setOutside(null))
  }, [api])

  const live = useLive(
    (change) => {
      if (liveMatches(change, LIVE_TYPES)) setUpdates((count) => count + 1)
    },
    () => setUpdates((count) => count + 1),
  )

  const go = (next: Omit<ReportsAddress, 'isNew'>) => router.replace(`${pathname}${reportsQuery(next)}`, { scroll: false })

  const openNew = useCallback(() => {
    if (!can.manage || !can.serviceManage) return
    writeKey.current = null
    setCreating({ draft: EMPTY_NEW, parties: can.parties ? null : 'failed', styles: can.styles ? null : 'failed', busy: false, refusal: null, scanning: false, tried: false, fields: {} })
    if (can.parties)
      listReporters(api)
        .then((parties: PartyOption[]) => setCreating((current) => (current ? { ...current, parties } : current)))
        .catch(() => setCreating((current) => (current ? { ...current, parties: 'failed' } : current)))
    if (can.styles)
      listStyles(api)
        .then((styles: StyleOption[]) => setCreating((current) => (current ? { ...current, styles } : current)))
        .catch(() => setCreating((current) => (current ? { ...current, styles: 'failed' } : current)))
  }, [api, can])

  // `?new=1` opens New report once, then the address is cleaned.
  useEffect(() => {
    if (!address.isNew) return
    openNew()
    router.replace(`${pathname}${reportsQuery(address)}`, { scroll: false })
  }, [address, openNew, router, pathname])

  const submit = () => {
    if (!creating || creating.busy || !session.company) return
    const problems = newReportProblems(creating.draft, today)
    if (Object.keys(problems).length > 0) return setCreating({ ...creating, tried: true })
    const draft = creating.draft
    const body = {
      ...intakeBodyOf(draft, 'office'),
      companyId: session.company.id,
      source: draft.source,
      partyId: draft.partyId || null,
      styleId: draft.styleId || null,
      receivedAt: draft.source === 'MAIL' && draft.receivedAt ? draft.receivedAt : null,
    }
    const text = JSON.stringify(body)
    if (writeKey.current?.body !== text) writeKey.current = { body: text, key: newIdempotencyKey() }
    setCreating({ ...creating, busy: true, refusal: null, fields: {} })
    recordReport(api, body, writeKey.current.key)
      .then((answer) => {
        writeKey.current = null
        setCreating(null)
        router.push(reportHref(prefix, answer.report.id))
      })
      .catch((error: unknown) => {
        const fields = refusedFields(error, draft, 'office')
        setCreating((current) => (current ? { ...current, busy: false, refusal: Object.keys(fields).length > 0 ? 'refused.fields' : refusalOf(error), fields, tried: true } : current))
      })
  }

  const newReport: NewReportModel | null = creating
    ? { draft: creating.draft, problems: { ...(creating.tried ? newReportProblems(creating.draft, today) : {}), ...creating.fields }, parties: creating.parties, styles: creating.styles, busy: creating.busy, refusal: creating.refusal, scanning: creating.scanning, today, camera: true }
    : null

  return (
    <ReportsListView
      model={{
        prefix,
        today,
        can,
        address: { ...address, q: query },
        rows: { items: rows.items, more: rows.more !== null, problem: rows.problem },
        counts,
        people,
        outside,
        asOf,
        live,
        updates,
        loadingMore,
        newReport,
        selected,
      }}
      actions={{
        onAddress: (patch) => {
          if (patch.q !== undefined) setQuery(patch.q)
          const next = { view: patch.view ?? address.view, source: patch.source !== undefined ? patch.source : address.source, q: patch.q ?? query }
          go(next)
        },
        onClear: () => {
          setQuery('')
          go({ view: 'open', source: null, q: '' })
        },
        onRetry: () => {
          setRows((current) => ({ ...current, problem: null }))
          void load()
        },
        onShowUpdates: () => void load(),
        onMore: () => {
          if (!rows.more || loadingMore) return
          setLoadingMore(true)
          listReports(api, { ...effective, cursor: rows.more })
            .then((page) => {
              setRows((current) => ({ items: [...(current.items ?? []), ...page.reports], more: page.nextCursor, problem: null }))
              setPeople((current) => [...(current ?? []), ...page.people.filter((person) => !(current ?? []).some((known) => known.id === person.id))])
            })
            .catch(() => undefined)
            .finally(() => setLoadingMore(false))
        },
        onOpen: (row) => router.push(reportHref(prefix, row.id)),
        onSelect: setSelected,
        onCopy: (numbers) => void navigator.clipboard?.writeText(numbers.join('\n')),
        onExport: (selection) =>
          downloadText(
            `${t('list.fileName')}.csv`,
            reportsCsv(selection, {
              header: [t('list.col.report'), t('list.csv.received'), t('list.col.source'), t('list.col.customer'), t('list.csv.serial'), t('list.csv.batch'), t('list.csv.style'), t('list.col.accident'), t('list.col.case'), t('list.col.status')],
              source: (code) => t(`source.${code}`),
              status: (code) => t(`status.${code}`),
              outcome: (code) => t(`outcome.${code}`),
            }),
          ),
        onNew: openNew,
        newReport: {
          onDraft: (patch) => setCreating((current) => (current && !current.busy ? { ...current, refusal: null, fields: {}, draft: patchIntake(current.draft, patch) as NewReportDraft } : current)),
          onSubmit: submit,
          onClose: () => setCreating((current) => (current?.busy ? current : null)),
          onScan: (open) => setCreating((current) => (current ? { ...current, scanning: open } : current)),
          onScanned: (code) => setCreating((current) => (current ? { ...current, scanning: false, draft: { ...current.draft, serial: code } } : current)),
        },
      }}
    />
  )
}
