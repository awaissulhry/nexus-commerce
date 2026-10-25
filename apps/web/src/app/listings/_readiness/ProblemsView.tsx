'use client'

/**
 * Listings — the Problems view (step 7 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md): fix by problem, not
 * product by product (the Akeneo / Productsup / Tradebyte / Zentail pattern). One row per problem × destination —
 * "Size chart · Amazon DE · 34 products" — including the channel's messages word for word and "Ready, not listed".
 * Show products goes back to the Products view with `problem=<id>` and a removable chip.
 *
 * The page keeps its filters, search and tiles above (the Products grid stays mounted off stage and keeps the header
 * current); this card reads `GET …/readiness/problems` with the same filters, again on every live refresh
 * (`refreshKey`). At most 500 rows: a DS `NexusGrid` with client rows, the API's order. Keyboard: the DS reading grid's
 * own — Tab into the list, the arrows to Show products, Enter.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { ReadinessProblemRow, ReadinessProblemsPage } from '@nexus/shared/listing-readiness'

import { Button, Spinner, Tag } from '@/design-system/primitives'
import { Banner, EmptyState } from '@/design-system/components'
import { NexusGrid, actionsColumn, numericColumn, type ColDef, type GridDensity, type ICellRendererParams } from '@/design-system/grid'

import { transferApi } from '@/app/products/catalog-transfer/transferApi'
import styles from './ProblemsView.module.css'
import {
  NO_PROBLEMS, PROBLEMS_PATH, cappedWords, listingsUnit, problemChipText, problemFallbackText, problemTag, problemsParams, showProductsLabel,
} from './problemsModel'
import type { ReadinessPageQuery } from './readinessQuery'

/* ── The chip's words (Products, after Show products or from a link) ────────────────────────────────────────────── */

/** Every problem this visit has seen, by id: the chip names it without asking again. */
const knownProblems = new Map<string, string>()
const remember = (rows: readonly ReadinessProblemRow[]) => { for (const row of rows) knownProblems.set(row.id, problemChipText(row)) }

/**
 * The words of the page's problem chip: the row Show products came from; else, for a link, the Problems list under the
 * same filters is asked once; until it answers (or when the problem is gone), what the id itself says.
 */
export function useProblemWords(query: ReadinessPageQuery | null): string | null {
  const id = query?.problem ?? ''
  const params = query && id ? problemsParams(query).toString() : ''
  const [named, setNamed] = useState<{ id: string; words: string } | null>(null)
  useEffect(() => {
    if (!id || knownProblems.has(id)) return
    const controller = new AbortController()
    void transferApi<ReadinessProblemsPage>(`${PROBLEMS_PATH}?${params}`, undefined, controller.signal)
      .then((page) => {
        remember(page.rows)
        const words = knownProblems.get(id)
        if (words && !controller.signal.aborted) setNamed({ id, words })
      })
      .catch(() => { /* the id's own words stay */ })
    return () => controller.abort()
    // Asked once per problem: a filter change keeps the chip's words.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  if (!id) return null
  return knownProblems.get(id) ?? (named?.id === id ? named.words : null) ?? problemFallbackText(id) ?? 'One problem'
}

/* ── Cells ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

type CellParams = ICellRendererParams<ReadinessProblemRow>

function ProblemCell(p: CellParams) {
  const row = p.data
  if (!row) return null
  const tag = problemTag(row)
  return (
    <div className={styles.problem}>
      <span className={styles.label}>{row.label}</span>
      <span className={styles.tags}>
        <Tag tone={tag.tone}>{tag.text}</Tag>
        {row.code ? <Tag title="The channel's own code">{row.code}</Tag> : null}
      </span>
    </div>
  )
}

function WhereCell(p: CellParams) {
  const destination = p.data?.destination
  if (!destination) return null
  return <span className={styles.where} title={destination.note ?? destination.label}>{destination.label}</span>
}

function MessageCell(p: CellParams) {
  return p.data ? <span className={styles.message}>{p.data.message}</span> : null
}

function problemColumns(show: (row: ReadinessProblemRow) => void): ColDef<ReadinessProblemRow>[] {
  const count = (field: 'products' | 'listings', headerName: string, headerTooltip: string): ColDef<ReadinessProblemRow> => ({
    ...numericColumn, colId: field, headerName, headerTooltip, width: 112, minWidth: 96, sortable: true,
    valueGetter: (v) => v.data?.[field] ?? null,
    valueFormatter: (v) => (typeof v.value === 'number' ? v.value.toLocaleString('en') : ''),
    tooltipValueGetter: (v) => (v.data && field === 'listings' ? `${v.data.listings.toLocaleString('en')} ${listingsUnit(v.data)}` : undefined),
  })
  return [
    { colId: 'problem', headerName: 'Problem', width: 240, minWidth: 190, sortable: false, autoHeight: true, cellClass: 'nds-ag-cell',
      valueGetter: (v) => v.data?.label ?? null, cellRenderer: ProblemCell },
    { colId: 'where', headerName: 'Where', width: 180, minWidth: 140, sortable: false, autoHeight: true, cellClass: 'nds-ag-cell',
      valueGetter: (v) => v.data?.destination.label ?? null, cellRenderer: WhereCell },
    { colId: 'message', headerName: 'Message', flex: 1, minWidth: 260, sortable: false, autoHeight: true, cellClass: 'nds-ag-cell',
      valueGetter: (v) => v.data?.message ?? null, cellRenderer: MessageCell },
    count('products', 'Products', 'Rows of the Products view with this problem: products and families'),
    count('listings', 'Listings', 'What the problem touches: listings (one product on one market), or listings on the channel for a channel message'),
    {
      ...actionsColumn<ReadinessProblemRow>({
        prefsLabel: 'Actions',
        primary: { id: 'show', label: 'Show products', onClick: show, ariaLabel: showProductsLabel },
      }),
      sortable: false,
    },
  ]
}

const getRowId = (p: { data: ReadinessProblemRow }) => p.data.id

/* ── The view ───────────────────────────────────────────────────────────────────────────────────────────────────── */

export interface ProblemsViewProps {
  query: ReadinessPageQuery
  /** Bumped by the page's live refresh (events, the 30-second re-read, the tab coming back). */
  refreshKey: number
  density: GridDensity
  /** The latest answer (the toolbar counts it), or null while the first one is on its way. */
  onLoaded: (page: ReadinessProblemsPage | null) => void
  onShowProducts: (row: ReadinessProblemRow) => void
}

export function ProblemsView({ query, refreshKey, density, onLoaded, onShowProducts }: ProblemsViewProps) {
  const params = problemsParams(query).toString()
  const [page, setPage] = useState<ReadinessProblemsPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const loadedRef = useRef(onLoaded)
  loadedRef.current = onLoaded
  const showRef = useRef(onShowProducts)
  showRef.current = onShowProducts

  // New filters start from nothing (the count says "—"); a refresh keeps the rows on screen until the answer lands.
  const shownParams = useRef<string | null>(null)
  useEffect(() => {
    if (shownParams.current !== params) { setPage(null); loadedRef.current(null) }
    const controller = new AbortController()
    void transferApi<ReadinessProblemsPage>(`${PROBLEMS_PATH}?${params}`, undefined, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        remember(next.rows)
        shownParams.current = params
        setPage(next)
        setError(null)
        loadedRef.current(next)
      })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [params, refreshKey, retry])
  useEffect(() => () => loadedRef.current(null), [])

  const columnDefs = useMemo(() => problemColumns((row) => showRef.current(row)), [])

  if (error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={20} />}
        title="Couldn’t load the problems"
        description={error}
        action={<Button size="sm" variant="secondary" onClick={() => { setError(null); setRetry((n) => n + 1) }}>Try again</Button>}
      />
    )
  }
  if (!page) return <EmptyState icon={<Spinner size={16} />} title="Reading the problems…" />
  if (page.rows.length === 0) return <EmptyState title={NO_PROBLEMS} />
  const capped = cappedWords(page)
  return (
    <>
      {capped && <Banner tone="info" className={styles.capped}>{capped}</Banner>}
      <NexusGrid<ReadinessProblemRow>
        domLayout="autoHeight"
        density={density}
        rowData={page.rows}
        columnDefs={columnDefs}
        getRowId={getRowId}
      />
    </>
  )
}
