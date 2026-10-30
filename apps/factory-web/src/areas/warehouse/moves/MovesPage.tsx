'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey } from '../../../lib/api/client'
import { formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadText, useLive } from '../../_shared/buying/hooks'
import { explainFigure, ledgerCounts, ledgerMove, listLocations, readLedger, reverseMove, stockOverview, type Explain, type LedgerCounts, type LedgerRow, type MoveDetail } from '../../_shared/stock/api'
import { csvOf, readProblem, stockCan, TIME_ZONE } from '../../_shared/stock/model'
import { StockMessages } from '../../_shared/stock/parts'
import { useAdjust } from '../stock/adjust/useAdjust'
import type { SiteChoice } from '../stock/model'
import { explainsFigure, ledgerQueryOf, movesAddressOf, movesQueryString, reverseProblemKey, type Loaded, type MovesAddress, type MovesPageModel, type ReverseModel } from './model'
import { MovesView } from './view/MovesView'

const PAGE = 500

/**
 * `/w/<company>/warehouse/moves` (SCR-064): the filters in the address (`?site=&item=&colour=&lot=&hide=&location=
 * &reasons=&period=&note=&reversed=&open=`); reads the ledger newest first (`GET /inventory/ledger`, pages of 500 by
 * cursor as the grid nears its end), the tiles' counts, and "why is it this number" for one stock key
 * (`GET /inventory/stock/explain`); the move in its detail (`?open=`, `GET /inventory/ledger/:id`); a reversal posted
 * with ONE Idempotency-Key per dialog; Adjust stock through the shared dialog. Live inventory.moved → "N new moves ·
 * Show" (rows never insert under the reader).
 */
export function MovesPage() {
  return (
    <StockMessages extra={['warehouse-stock']}>
      <MovesContainer />
    </StockMessages>
  )
}

function MovesContainer() {
  const t = useT('warehouse-stock')
  const s = useT('stock')
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/warehouse\/moves\/?$/, '')
  const can = useMemo(() => stockCan(session.permissions), [session.permissions])
  const address = useMemo(() => movesAddressOf(params), [params])
  const listKey = useMemo(() => movesQueryString({ ...address, open: null }), [address])

  const [rows, setRows] = useState<LedgerRow[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [closing, setClosing] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [counts, setCounts] = useState<LedgerCounts | null>(null)
  const [explain, setExplain] = useState<Loaded<Explain> | null>(null)
  const [detail, setDetail] = useState<Loaded<MoveDetail> | null>(null)
  const [reverse, setReverse] = useState<ReverseModel | null>(null)
  const [sites, setSites] = useState<SiteChoice[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<MovesPageModel['notice']>(null)
  const readId = useRef(0)
  const reverseKey = useRef<string | null>(null)

  const go = useCallback(
    (next: Partial<MovesAddress>) => {
      const qs = movesQueryString({ ...address, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`)
    },
    [address, pathname, router],
  )

  useEffect(() => {
    if (!can.locationsView) return
    listLocations(api, {})
      .then((answer) => setSites(answer.sites.filter((site) => !session.company || site.companyId === session.company.id).map(({ id, code, name }) => ({ id, code, name }))))
      .catch(() => setSites([]))
  }, [api, can.locationsView, session.company])

  const load = useCallback(async () => {
    if (!can.stockView) return
    const id = ++readId.current
    ledgerCounts(api, address.site)
      .then((answer) => id === readId.current && setCounts(answer))
      .catch(() => setCounts(null))
    if (explainsFigure(address)) {
      setExplain({ status: 'loading' })
      explainFigure(api, { siteId: address.site!, itemId: address.item!, itemColourId: address.colour, lotId: address.lot, hideId: address.hide, locationId: address.location })
        .then((value) => id === readId.current && setExplain({ status: 'ready', value }))
        .catch((error: unknown) => id === readId.current && setExplain({ status: 'error', problem: readProblem(error) }))
    } else setExplain(null)
    try {
      const page = await readLedger(api, ledgerQueryOf(address, new Date(), null, PAGE))
      if (id !== readId.current) return
      setRows(page.moves)
      setCursor(page.nextCursor)
      setClosing(page.closing)
      setProblem(null)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows(null)
      setProblem(readProblem(error))
    }
    // The list reads again only when its filters change (not when a move opens).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, can.stockView, listKey])

  useEffect(() => {
    setRows(null)
    setCursor(null)
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    const id = readId.current
    try {
      const page = await readLedger(api, ledgerQueryOf(address, new Date(), cursor, PAGE))
      if (id !== readId.current) return
      setRows((current) => [...(current ?? []), ...page.moves.filter((row) => !current?.some((seen) => seen.id === row.id))])
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', key: readProblem(error) === 'problem.offline' ? 'mv.notice.moreOffline' : 'mv.notice.moreFailed' })
    } finally {
      setLoadingMore(false)
    }
  }, [api, address, cursor, loadingMore])

  const openId = address.open
  const loadDetail = useCallback(() => {
    if (!openId) {
      setDetail(null)
      return
    }
    setDetail({ status: 'loading' })
    ledgerMove(api, openId)
      .then((value) => setDetail({ status: 'ready', value }))
      .catch((error: unknown) => setDetail({ status: 'error', problem: readProblem(error) }))
  }, [api, openId])
  useEffect(loadDetail, [loadDetail])

  const live = useLive(
    (change) => {
      if (change.type === 'inventory.moved') setUpdates((count) => count + 1)
    },
    () => void load(),
    can.stockView,
  )

  const adjust = useAdjust(api, can.cost, (words) => {
    setNotice({ tone: 'success', key: words.key, params: words.params })
    void load()
  })

  const startAdjust = useCallback(async () => {
    if (!address.site || !address.item) return
    try {
      const answer = await stockOverview(api, { siteId: address.site, itemId: address.item, itemColourId: address.colour, lotId: address.lot, hideId: address.hide, locationId: address.location })
      const places = [...new Set(answer.rows.map((row) => row.location.id))]
      const first = answer.rows[0]
      // One hide or one non-leather key at one place: adjustable here; else Stock, one row at a time.
      const oneHide = new Set(answer.rows.map((row) => row.hide?.id ?? '-')).size === 1
      if (!first || places.length !== 1 || (first.item.tracking === 'HIDE' && !(oneHide && first.hide))) {
        setNotice({ tone: 'danger', key: first ? 'mv.notice.adjustSeveral' : 'mv.notice.adjustNone', params: { count: places.length } })
        return
      }
      const onHand = answer.rows.reduce((sum, row) => sum + Number(row.onHand), 0).toFixed(4)
      adjust.open({ siteId: first.siteId, siteCode: first.siteCode, item: first.item, colour: first.colour, lot: first.lot ? { id: first.lot.id, code: first.lot.code } : null, hide: first.hide, location: first.location, onHand })
    } catch (error) {
      setNotice({ tone: 'danger', key: readProblem(error) === 'problem.offline' ? 'mv.notice.moreOffline' : 'mv.notice.adjustFailed' })
    }
  }, [api, address, adjust])

  const postReverse = useCallback(() => {
    const current = reverse
    if (!current || current.posting || !current.note.trim() || !reverseKey.current) return
    setReverse({ ...current, posting: true, problem: null })
    reverseMove(api, current.move.id, current.note.trim(), reverseKey.current)
      .then(() => {
        setReverse(null)
        setNotice({ tone: 'success', key: 'rev.done', params: { reason: s(`reason.${current.move.reason}`), material: current.move.item.code } })
        void load()
        loadDetail()
      })
      .catch((error: unknown) => {
        const key = isApiError(error) ? reverseProblemKey(error.kind, error.code, error.issues.length > 0) : 'rev.problem.write'
        setReverse((now) => (now ? { ...now, posting: false, problem: { key } } : now))
      })
  }, [api, reverse, load, loadDetail, s])

  const exportRows = useCallback(
    (picked: LedgerRow[]) => {
      const place = { locale, timeZone: TIME_ZONE }
      const side = (value: LedgerRow['from']) => (value.location ? value.location.code : s(`side.${value.kind}`))
      const header = ['when', 'recorded', 'reason', 'material', 'colour', 'lot', 'hide', 'from', 'to', 'quantity', 'unit', 'baseQuantity', 'delta', 'document', 'reference', 'note', 'postedBy', 'reversalOf', 'reversedBy', ...(can.cost ? ['method', 'value', 'currency'] : [])].map((column) => t(`mv.csv.${column}`))
      const csvRows = picked.map((row) => [
        formatDateTime(row.occurredAt, place),
        formatDateTime(row.createdAt, place),
        s(`reason.${row.reason}`),
        row.item.code,
        row.colour?.code ?? '',
        row.lot?.code ?? '',
        row.hide?.code ?? '',
        side(row.from),
        side(row.to),
        row.quantity,
        s(`uom.${row.uom}`),
        row.baseQuantity,
        row.delta,
        row.document?.number ?? '',
        row.reference ?? '',
        row.note ?? '',
        row.postedBy.audience === 'FLOOR' ? s('postedBy.FLOOR', { device: row.postedBy.device?.name ?? '' }) : row.postedBy.audience === 'SYSTEM' ? s('postedBy.SYSTEM') : (row.postedBy.name ?? ''),
        row.reversalOfId ?? '',
        row.reversedById ?? '',
        ...(can.cost ? [row.valuation ? t(`mv.method.${row.valuation.method}`) : '', row.valuation?.valueAmount !== undefined ? (row.valuation.valueAmount / 100).toFixed(2) : '', row.valuation?.currency ?? ''] : []),
      ])
      downloadText(`movements-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, csvRows))
    },
    [can.cost, locale, s, t],
  )

  const model: MovesPageModel = {
    prefix,
    can,
    address,
    sites,
    rows,
    problem,
    loadingMore,
    done: rows !== null && cursor === null,
    closing,
    counts,
    explain,
    asOf,
    live,
    updates,
    timeZone: TIME_ZONE,
    notice,
    detail,
    reverse,
    adjust: adjust.model,
  }

  return (
    <MovesView
      model={model}
      adjustActions={adjust.actions}
      actions={{
        onAddress: go,
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => void load(),
        onOpen: (id) => go({ open: id }),
        onRetryDetail: loadDetail,
        onReverse: (move) => {
          reverseKey.current = move ? newIdempotencyKey() : null
          setReverse(move ? { move, note: '', posting: false, problem: null } : null)
        },
        onReverseNote: (note) => setReverse((current) => (current ? { ...current, note, problem: null } : current)),
        onPostReverse: postReverse,
        onAdjust: () => void startAdjust(),
        onExport: exportRows,
        onNotice: () => setNotice(null),
      }}
    />
  )
}
