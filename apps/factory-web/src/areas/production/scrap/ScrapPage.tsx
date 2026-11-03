'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { downloadText, useCoalesced, useLive } from '../_shared/hooks'
import type { Replacement } from '../cutting/api'
import { romeDayStart } from '../cutting/model'
import { approveReduction, askReplacement, getScrap, openReductions, refuseReduction, type ScrapRow, type ScrapTiles } from './api'
import { addressOf, addressText, csvOf, leftToReplace, periodFrom, phrase, readProblem, replaceBody, replaceHeld, SCRAP_NAMESPACE, scrapCanOf, writeProblem, type ScrapAddress } from './model'
import type { ReplaceDraftModel } from './view/ScrapDialogs'
// B-W2b-126: second quality (MES-133) and a rework's repair (MES-132).
import { getDowngradeOptions, getDowngrades, getRepair, postDowngrade, withdrawDowngrade } from './api'
import { downgradeBody, downgradeHeld, emptyDowngradeDraft, withDowngrades, type SecondTotals } from './model'
import type { DowngradeModel, RepairModel } from './view/SecondDialogs'
import { ScrapView, type ScrapModel } from './view/ScrapView'

const TIME_ZONE = 'Europe/Rome'
const PAGE = 50

/**
 * `/w/<company>/production/scrap` (SCR-140): the latest rows of the period (`?period=`, at most 500) with the tiles, the
 * open lower-quantity requests (to decide them), the filters of the address over those rows (`?view=` the tiles' saved
 * filters, `?kind=`, `?group=` a pareto bar in the `?by=` dimension, `?q=`), 50 shown at a time, the row's detail
 * (`?open=`) and Replace scrapped quantity (`?replace=`), and live scrap, rework and replacement events behind "N
 * updates · Show".
 */
export function ScrapPage() {
  return (
    <WithMessages namespaces={[SCRAP_NAMESPACE, 'lists']}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const t = useT(SCRAP_NAMESPACE)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/scrap\/?$/, '')
  const can = useMemo(() => scrapCanOf(session.permissions), [session.permissions])
  const address = addressOf(params)

  const [rows, setRows] = useState<ScrapModel['rows']>({ items: null, problem: null })
  const [tiles, setTiles] = useState<ScrapTiles | null>(null)
  const [reductions, setReductions] = useState<readonly Replacement[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [slow, setSlow] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const [chartOpen, setChartOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<ScrapModel['problem']>(null)
  const [notice, setNotice] = useState<ScrapModel['notice']>(null)
  const [replace, setReplace] = useState<ReplaceDraftModel | null>(null)
  const [second, setSecond] = useState<SecondTotals | null>(null)
  const [downgrade, setDowngrade] = useState<DowngradeModel | null>(null)
  const [repair, setRepair] = useState<RepairModel | null>(null)
  const writeKey = useRef<string | null>(null)
  const readId = useRef(0)
  const todayStart = romeDayStart(new Date()).getTime()

  const go = useCallback((next: Partial<ScrapAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`), [router, pathname, address])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const from = periodFrom(address.period, Date.now())
      // B-W2b-126: the downgrades are their own read; a failed one leaves the scrap rows (its tile says "—").
      const [page, open, downgrades] = await Promise.all([getScrap(api, { from }), openReductions(api).catch(() => [] as Replacement[]), getDowngrades(api, { from }).catch(() => null)])
      if (id !== readId.current) return
      setRows({ items: withDowngrades(page.rows, downgrades?.downgrades ?? null), problem: null })
      setTiles(page.tiles)
      setSecond(downgrades?.garments ?? null)
      setReductions(open)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, problem: readProblem(error) })
    }
  }, [api, can.view, address.period])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => setShown(PAGE), [address.view, address.kind, address.group, address.q, address.period])

  useEffect(() => {
    setSlow(false)
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [address.period])

  // Replace scrapped quantity follows the address (`?replace=`).
  useEffect(() => {
    if (address.replace && replace?.rowId !== address.replace) {
      const row = (rows.items ?? []).find((entry) => entry.id === address.replace)
      writeKey.current = newIdempotencyKey()
      setProblem(null)
      setReplace({ rowId: address.replace, draft: { kind: 'RECUT', quantity: String(row ? Math.max(1, leftToReplace(row)) : 1), reason: '' } })
    }
    if (!address.replace && replace) setReplace(null)
  }, [address.replace, rows.items])

  // B-W2b-126: Downgrade to second quality follows the address (`?downgrade=`): what the row can still send, read when it opens.
  useEffect(() => {
    if (!address.downgrade) {
      if (downgrade) setDowngrade(null)
      return
    }
    if (downgrade?.rowId === address.downgrade) return
    const row = (rows.items ?? []).find((entry) => entry.id === address.downgrade)
    if (!row) return
    writeKey.current = newIdempotencyKey()
    setProblem(null)
    setDowngrade({ rowId: row.id, options: null, readProblem: null, draft: emptyDowngradeDraft(null) })
    getDowngradeOptions(api, row.source.type === 'SCAN' ? { sourceScanId: row.source.id } : { reworkOrderId: row.source.id })
      .then((options) => setDowngrade((current) => (current?.rowId === row.id ? { ...current, options, draft: emptyDowngradeDraft(options) } : current)))
      .catch((error: unknown) => setDowngrade((current) => (current?.rowId === row.id ? { ...current, readProblem: readProblem(error) } : current)))
  }, [address.downgrade, rows.items])

  // B-W2b-126: a rework row's detail reads its repair at the repair station.
  useEffect(() => {
    const row = address.open ? (rows.items ?? []).find((entry) => entry.id === address.open) : undefined
    if (!row || row.source.type !== 'REWORK' || row.kind === 'SECOND') {
      if (repair) setRepair(null)
      return
    }
    if (repair?.reworkId === row.source.id && repair.value) return
    setRepair({ reworkId: row.source.id, value: null, problem: null })
    getRepair(api, row.source.id)
      .then((value) => setRepair((current) => (current?.reworkId === row.source.id ? { ...current, value } : current)))
      .catch((error: unknown) => setRepair((current) => (current?.reworkId === row.source.id ? { ...current, problem: readProblem(error) } : current)))
  }, [address.open, rows.items])

  const recount = useCoalesced(() => {
    getScrap(api, { from: periodFrom(address.period, Date.now()) })
      .then((page) => setTiles(page.tiles))
      .catch(() => undefined)
  }, 1200)
  const live = useLive(
    (change) => {
      const scanScrap = change.type === 'production.scan_recorded' && Number(change.fields.scrap ?? change.fields.scrapQuantity ?? 1) > 0
      if (!scanScrap && !/^production\.(rework_|replacement_|scrap_|garments_downgraded|downgrade_withdrawn|repair_scanned)/.test(change.type)) return
      setUpdates((count) => count + 1)
      recount()
    },
    () => void load(),
    can.view,
  )

  // ---- writes -------------------------------------------------------------------------------------------------------------------

  const decide = useCallback(
    async (run: () => Promise<unknown>, done: ScrapModel['notice']) => {
      setBusy(true)
      setProblem(null)
      try {
        await run()
        setNotice(done)
        void load()
      } catch (error) {
        setProblem(writeProblem(error))
        setNotice({ tone: 'danger', words: writeProblem(error) })
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const approve = useCallback(
    (list: readonly Replacement[]) =>
      void decide(async () => {
        for (const reduction of list) await approveReduction(api, reduction.id, { version: reduction.version })
      }, { tone: 'success', words: phrase('notice.approved', { count: list.length }) }),
    [api, decide],
  )

  const refuse = useCallback((reduction: Replacement, note: string) => void decide(() => refuseReduction(api, reduction.id, { version: reduction.version, note }), { tone: 'success', words: phrase('notice.refused') }), [api, decide])

  const ask = useCallback(async () => {
    const row = (rows.items ?? []).find((entry: ScrapRow) => entry.id === replace?.rowId) ?? null
    if (!row || !replace || replaceHeld(row, replace.draft, can, busy)) return
    const key = writeKey.current ?? newIdempotencyKey()
    writeKey.current = key
    setBusy(true)
    setProblem(null)
    try {
      await askReplacement(api, replaceBody(row, replace.draft), key)
      writeKey.current = null
      setReplace(null)
      setNotice({ tone: 'success', words: phrase(`notice.asked.${replace.draft.kind}`, { count: Number(replace.draft.quantity), number: row.workOrder.number }) })
      go({ replace: null })
      void load()
    } catch (error) {
      writeKey.current = newIdempotencyKey()
      setProblem(writeProblem(error))
    } finally {
      setBusy(false)
    }
  }, [api, rows.items, replace, can, busy, go, load])

  // B-W2b-126: the garments go to second quality instead of scrap.
  const downgradeGo = useCallback(async () => {
    const row = (rows.items ?? []).find((entry: ScrapRow) => entry.id === downgrade?.rowId) ?? null
    if (!row || !downgrade?.options || downgradeHeld(downgrade.options, downgrade.draft, can, busy)) return
    const key = writeKey.current ?? newIdempotencyKey()
    writeKey.current = key
    setBusy(true)
    setProblem(null)
    try {
      await postDowngrade(api, downgradeBody(row, downgrade.draft, downgrade.options), key)
      writeKey.current = null
      setDowngrade(null)
      setNotice({ tone: 'success', words: phrase('second.notice.done', { count: Number(downgrade.draft.quantity), number: row.workOrder.number }) })
      go({ downgrade: null })
      void load()
    } catch (error) {
      writeKey.current = newIdempotencyKey()
      setProblem(writeProblem(error))
    } finally {
      setBusy(false)
    }
  }, [api, rows.items, downgrade, can, busy, go, load])

  const withdraw = useCallback(
    (row: ScrapRow, reason: string) => {
      const target = row.downgrade
      if (!target) return
      void decide(() => withdrawDowngrade(api, target.id, { version: target.version, reason }), { tone: 'success', words: phrase('second.notice.withdrawn', { count: target.quantity, number: row.workOrder.number }) })
    },
    [api, decide],
  )

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = ['date', 'workOrder', 'bundle', 'operation', 'size', 'part', 'pieces', 'kind', 'reason', 'lot', 'replacement', 'station', ...(can.cost ? ['value', 'currency'] : [])].map((column) => t(`csv.${column}`))
      downloadText(`scrap-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(picked, header, locale, can.cost))
    },
    [rows.items, can.cost, t, locale],
  )

  const model: ScrapModel = {
    prefix,
    can,
    me: session.user.id,
    address,
    timeZone: TIME_ZONE,
    todayStart,
    rows,
    tiles,
    reductions,
    asOf,
    live,
    updates,
    slow,
    shown,
    chartOpen,
    busy,
    problem: address.replace || address.open || address.downgrade ? problem : null,
    notice,
    replace: address.replace ? replace : null,
    second,
    downgrade: address.downgrade ? downgrade : null,
    repair,
  }

  return (
    <ScrapView
      model={model}
      actions={{
        onAddress: (next) => {
          setProblem(null)
          go(next)
        },
        onMore: () => setShown((current) => current + PAGE),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onChart: setChartOpen,
        onApprove: approve,
        onRefuse: refuse,
        onReplace: (rowId) => go({ replace: rowId, open: rowId ? null : address.open }),
        onReplaceDraft: (draft) => setReplace((current) => (current ? { ...current, draft } : current)),
        onAsk: () => void ask(),
        onDowngrade: (rowId) => go({ downgrade: rowId, open: rowId ? null : address.open }),
        onDowngradeDraft: (draft) => setDowngrade((current) => (current ? { ...current, draft } : current)),
        onDowngradeGo: () => void downgradeGo(),
        onWithdraw: withdraw,
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
