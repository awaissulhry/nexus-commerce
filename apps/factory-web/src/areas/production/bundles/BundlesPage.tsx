'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { getTicketPrinters } from '../_shared/api'
import { downloadText, useCoalesced, useLive } from '../_shared/hooks'
import { readProblem, writeProblem } from '../_shared/model'
import { getRules } from '../settings/api'
import { bundleTiles, findingsSummary, listBundles, listFindings, reprintTicket, reviewFinding, showWho, type BundleTiles, type Finding, type TrackedBundle } from './api'
import type { BundlesModel, FindingsDialog, ReprintRun } from './list-model'
import { addressOf, addressText, BUNDLES_NAMESPACE, BUNDLES_NAMESPACES, bundlesCanOf, csvCell, isBundleChange, oneHit, reviewProblem, viewQuery, whoProblem, type BundlesAddress, type FindingsAsk, type WhoPurpose } from './model'
import { BundlesView } from './view/BundlesView'

/**
 * `/w/<company>/production/bundles?stuck=true|place=LINE|status=VOID|view=all&q=&check=&checkLine=&checkOp=` (SCR-259):
 * the bundles of the top bar's site, 50 at a time with "Show more", the tiles and the scan-pattern counts of the same
 * scope, live behind "N updates · Show". A scan or an Enter in the search with one hit opens the bundle. A count opens
 * its findings; the review and "Show who" run from there, the names held by the dialog alone and dropped as it closes.
 */
export function BundlesPage() {
  return (
    <WithMessages namespaces={BUNDLES_NAMESPACES}>
      <Container />
    </WithMessages>
  )
}

const part = <T,>(value: T) => ({ value, problem: null })

function Container() {
  const t = useT(BUNDLES_NAMESPACE)
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/bundles\/?$/, '')
  const can = useMemo(() => bundlesCanOf(session.permissions), [session.permissions])
  const address = addressOf(params)
  const siteId = scope.siteId

  const [rows, setRows] = useState<BundlesModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [tiles, setTiles] = useState<BundleTiles | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<BundlesModel['notice']>(null)
  const [summary, setSummary] = useState<BundlesModel['summary']>({ value: null, problem: null })
  const [findings, setFindings] = useState<FindingsDialog | null>(null)
  const [findingsCursor, setFindingsCursor] = useState<string | null>(null)
  const [reprint, setReprint] = useState<ReprintRun | null>(null)
  const readId = useRef(0)
  const scanned = useRef<string | null>(null)
  const dialogKeys = useRef(new Map<string, string>())

  const go = useCallback((next: Partial<BundlesAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`), [router, pathname, address])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const page = await listBundles(api, viewQuery(address.view, address.q, siteId))
      if (id !== readId.current) return
      setRows({ items: page.bundles, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(page.asOf)
      setUpdates(0)
      // A scan with one hit opens the bundle (design bd-grid "search or scan a ticket: one hit opens it").
      // Only the read of what was scanned answers it: a read of the page before the address moved (a reconnect) leaves it waiting.
      const asked = scanned.current
      if (asked !== null && asked.trim() === address.q.trim()) {
        scanned.current = null
        if (oneHit(asked, address.q, page.bundles)) router.push(`${prefix}/production/bundles/${page.bundles[0]!.id}`)
      }
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
    bundleTiles(api, siteId)
      .then((answer) => id === readId.current && setTiles(answer))
      .catch(() => id === readId.current && setTiles(null))
  }, [api, can.view, address.view, address.q, siteId, prefix, router])

  const loadSummary = useCallback(() => {
    if (!can.view) return
    findingsSummary(api, siteId)
      .then((value) => setSummary(part(value)))
      .catch((error: unknown) => setSummary({ value: null, problem: readProblem(error) }))
  }, [api, can.view, siteId])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])
  useEffect(() => loadSummary(), [loadSummary])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listBundles(api, viewQuery(address.view, address.q, siteId, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.bundles.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: `production:${readProblem(error)}` } })
    }
  }, [api, cursor, address.view, address.q, siteId])

  // Live: rows never move under the cursor; the tiles and the counts follow at once.
  const refresh = useCoalesced(() => {
    bundleTiles(api, siteId)
      .then(setTiles)
      .catch(() => undefined)
    loadSummary()
  }, 800)
  const live = useLive(
    (change) => {
      if (!isBundleChange(change.type)) return
      setUpdates((count) => count + 1)
      refresh()
    },
    () => void load(),
    can.view,
  )

  // ---- the findings behind a count ------------------------------------------------------------------------------------------

  const askKey = address.ask ? JSON.stringify(address.ask) : ''
  const readFindings = useCallback(
    async (ask: FindingsAsk, after: string | null = null) => {
      try {
        const page = await listFindings(api, { siteId, kind: ask.kind, ...(ask.lineId ? { lineId: ask.lineId } : {}), ...(ask.operationCode ? { operationCode: ask.operationCode } : {}), cursor: after })
        // A row without a line or an operation is its own count: the API filters by a line or an operation, not by none.
        const own = page.findings.filter((row) => (ask.lineId ? true : row.line === null) && (ask.operationCode ? true : row.operation === null))
        setFindings((current) => (current ? { ...current, rows: { items: [...(after ? (current.rows.items ?? []) : []), ...own], more: page.nextCursor !== null, problem: null } } : current))
        setFindingsCursor(page.nextCursor)
      } catch (error) {
        setFindings((current) => (current ? { ...current, rows: { items: after ? current.rows.items : null, more: false, problem: readProblem(error) } } : current))
      }
    },
    [api, siteId],
  )
  useEffect(() => {
    if (!address.ask) {
      setFindings(null)
      return
    }
    setFindings({ ask: address.ask, rows: { items: null, more: false, problem: null }, busy: false, notice: null, dismiss: null, who: null })
    void readFindings(address.ask)
  }, [askKey, readFindings])

  const took = useCallback((finding: Finding) => {
    setFindings((current) => (current ? { ...current, rows: { ...current.rows, items: current.rows.items?.map((row) => (row.id === finding.id ? finding : row)) ?? null } } : current))
  }, [])

  const review = useCallback(
    async (ids: readonly string[], status: 'REVIEWED' | 'DISMISSED', note?: string) => {
      const items = findings?.rows.items ?? []
      setFindings((current) => (current ? { ...current, busy: true, notice: null } : current))
      let done = 0
      let first: BundlesModel['notice'] = null
      for (const id of ids) {
        const finding = items.find((row) => row.id === id)
        if (!finding) continue
        try {
          took(await reviewFinding(api, id, { status, version: finding.version, ...(note ? { note } : {}) }, newIdempotencyKey()))
          done += 1
        } catch (error) {
          first = first ?? { tone: 'danger', words: reviewProblem(error) }
        }
      }
      setFindings((current) => (current ? { ...current, busy: false, dismiss: null, notice: first ? { tone: 'danger', words: first.words } : { tone: 'success', words: { key: status === 'DISMISSED' ? 'finding.dismissed' : 'finding.reviewed', params: { count: done } } } } : current))
      loadSummary()
    },
    [api, findings, took, loadSummary],
  )

  const openWho = useCallback(
    (finding: Finding | null) => {
      if (!finding) {
        // Closing the dialog drops the names: nothing of them stays on this page.
        setFindings((current) => (current ? { ...current, who: null } : current))
        return
      }
      setFindings((current) => (current ? { ...current, who: { finding, basis: null, busy: false, problem: null, answer: null } } : current))
      if (!can.settings) return
      getRules(api, finding.siteId)
        .then((detail) => {
          const basis = detail.rules.legalBasis
          if (!basis) return
          setFindings((current) => (current?.who?.finding.id === finding.id ? { ...current, who: { ...current.who, basis: { kind: basis.kind, reference: basis.reference, recordedAt: basis.recordedAt } } } : current))
        })
        .catch(() => undefined)
    },
    [api, can.settings],
  )

  const runWho = useCallback(
    (purpose: WhoPurpose, note: string) => {
      const who = findings?.who
      if (!who || who.busy) return
      setFindings((current) => (current?.who ? { ...current, who: { ...current.who, busy: true, problem: null } } : current))
      showWho(api, who.finding.id, { purpose, ...(note ? { note } : {}) })
        .then((answer) => setFindings((current) => (current?.who?.finding.id === who.finding.id ? { ...current, who: { ...current.who, busy: false, answer } } : current)))
        .catch((error: unknown) => setFindings((current) => (current?.who ? { ...current, who: { ...current.who, busy: false, problem: whoProblem(error) } } : current)))
    },
    [api, findings?.who],
  )

  // ---- reprint ----------------------------------------------------------------------------------------------------------------

  const openReprint = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      if (picked.length === 0) return
      dialogKeys.current = new Map(picked.map((row) => [row.id, newIdempotencyKey()]))
      setReprint({ rows: picked.map((row) => ({ id: row.id, code: row.code })), printers: { value: null, problem: null }, running: false, done: false, results: {} })
      getTicketPrinters(api, picked[0]!.workOrder.id)
        .then((value) => setReprint((current) => (current ? { ...current, printers: part(value) } : current)))
        .catch((error: unknown) => setReprint((current) => (current ? { ...current, printers: { value: null, problem: readProblem(error) } } : current)))
    },
    [api, rows.items],
  )

  const runReprint = useCallback(
    async (reason: string, printerId: string | null) => {
      const run = reprint
      if (!run || run.running) return
      setReprint({ ...run, running: true })
      const results: ReprintRun['results'] = {}
      for (const row of run.rows) {
        try {
          const answer = await reprintTicket(api, row.id, { reason, printerId }, dialogKeys.current.get(row.id) ?? newIdempotencyKey())
          results[row.id] = { state: 'done', code: answer.bundle.code, pdf: printerId === null }
        } catch (error) {
          const words = writeProblem(error, 'bundle')
          results[row.id] = { state: 'failed', words: { ...words, key: `production:${words.key}` } }
        }
        setReprint((current) => (current ? { ...current, results: { ...results } } : current))
      }
      setReprint((current) => (current ? { ...current, running: false, done: true, results: { ...results } } : current))
      void load()
    },
    [api, reprint, load],
  )

  // Export N: the selected rows as CSV (this list has no API export source yet).
  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked: TrackedBundle[] = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = [t('col.bundle'), t('col.workOrder'), t('col.style'), t('col.colour'), t('col.size'), t('col.part'), t('col.pieces'), t('col.status'), t('col.replaced')]
      const lines = picked.map((row) => [row.code, row.workOrder.number, row.style.code, row.colourwayCode, row.size, row.part, row.quantity, t(`status.${row.status}`), row.replacedCodes.join(' ')])
      downloadText(`${t('list.fileName')}.csv`, [header, ...lines].map((line) => line.map(csvCell).join(';')).join('\n'))
    },
    [rows.items, t],
  )

  const model: BundlesModel = { prefix, can, view: address.view, q: address.q, rows, tiles, asOf, live, updates, notice, summary, findings, reprint }

  return (
    <BundlesView
      model={model}
      actions={{
        onView: (view) => go({ view }),
        onSearch: (q) => go({ q }),
        onScan: (q) => {
          scanned.current = q
          if (q.trim() === address.q.trim()) void load()
          else go({ q })
        },
        onMore: () => void more(),
        onRetry: () => void load(),
        onRetrySummary: loadSummary,
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/production/bundles/${id}`),
        onDismissNotice: () => setNotice(null),
        onReprintMany: openReprint,
        onRunReprint: (reason, printerId) => void runReprint(reason, printerId),
        onCloseReprint: () => setReprint(null),
        onExport: exportRows,
        onAsk: (ask) => go({ ask }),
        onMoreFindings: () => {
          if (address.ask && findingsCursor) void readFindings(address.ask, findingsCursor)
        },
        onRetryFindings: () => {
          if (address.ask) void readFindings(address.ask)
        },
        onReviewed: (ids) => void review(ids, 'REVIEWED'),
        onDismiss: (finding) => setFindings((current) => (current ? { ...current, dismiss: finding } : current)),
        onSendDismiss: (note) => {
          if (findings?.dismiss) void review([findings.dismiss.id], 'DISMISSED', note)
        },
        onWho: openWho,
        onShowWho: runWho,
      }}
    />
  )
}
