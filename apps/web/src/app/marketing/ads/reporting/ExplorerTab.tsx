'use client'

/**
 * GX.3 — the Explorer: where the money went, traced down.
 *
 * Market → Portfolio → Campaign → { Product | Target }, one level per click, every level
 * reconciling against its parent and every row linking to the thing it names.
 *
 * ── Why this lives on Reporting and not the Ad Manager ────────────────────────
 *
 * The plan said the Ad Manager would get the tree. It should not — yet — and the reason is
 * structural rather than aesthetic. `CampaignsGrid` is 2,114 lines and the last ads grid still
 * rendering its own `<table>`; adopting `WorkspaceGrid` there is a DATA migration, because two
 * pieces of persisted operator state (`h10-am-preset-lib`, `h10-am-columns-v5`) have bespoke
 * shapes and the failure mode is an operator's saved views silently resetting. It also renders
 * zero rows outside production, so none of it can be verified in pixels first.
 *
 * The split is also the honest one. The Ad Manager is the EXECUTION grid: its rows are things
 * you change — bids, budgets, states — in bulk. This is an ANALYSIS surface: its rows are things
 * you read and click through, and it never writes. Putting a read-only tree inside a bulk-edit
 * grid would blur what selecting a row means.
 *
 * ── The two things that make it trustworthy ───────────────────────────────────
 *
 * 1. **The remainder is a row.** Where children do not reach their parent, the difference is its
 *    own line with the reason on it. Nothing is left for the eye to subtract.
 * 2. **A campaign expands into products OR targets, never both nested.** Each accounts for ~100%
 *    of the same spend, so nesting one inside the other would count that spend twice. The toggle
 *    sits on the campaign row, which is the only level where the decomposition forks.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { Card } from '@/design-system/components/Card'
import { Pill } from '@/design-system/primitives/Pill'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { AdsDataGrid, type GridColumn, type GridHierarchy } from '../campaigns/_grid/AdsDataGrid'
import {
  fetchHierarchy, insertChildren, removeChildren,
  type Decompose, type FlatNode, type HierarchyResult,
} from './hierarchy-api'
import { fmtCount, fmtMoney, fmtShare } from './strategy-api'
import { Caveats, ProvenanceStrip, TabState } from './StrategyBits'

/** The window the tree opens on. Wide enough to hold a trend, short enough to still be current. */
const WINDOW_DAYS = 56

function fmtMetric(v: number | null, format: string): string {
  if (v == null) return '—'
  if (format === 'money') return fmtMoney(v)
  if (format === 'pct') return fmtShare(v, 1)
  if (format === 'ratio') return v.toFixed(2)
  return fmtCount(v)
}

export function ExplorerTab({ market }: { market: string }) {
  const [rows, setRows] = useState<FlatNode[]>([])
  const [meta, setMeta] = useState<HierarchyResult | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [decompose, setDecompose] = useState<Decompose>('product')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [caveats, setCaveats] = useState<string[]>([])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const win = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - WINDOW_DAYS * 86_400_000)
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
  }, [])

  // Root load. Changing market or the window collapses everything — a tree whose branches were
  // fetched under different filters is a tree whose children no longer belong to their parents.
  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setExpanded(new Set())
    fetchHierarchy({
      level: 'root', from: win.from, to: win.to, decompose,
      marketplaces: market === 'all' ? [] : [market],
    }, ac.signal)
      .then((r) => {
        setMeta(r)
        setCaveats(r.caveats)
        setRows(r.nodes.map((n) => ({ ...n, depth: 0, path: [n.id], decompose: null })))
        setError(null)
      })
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setError((e as Error).message) })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
    // `decompose` is deliberately NOT a dependency: switching it re-expands the open campaigns
    // rather than throwing the whole tree away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, win, nonce])

  const loadChildren = useCallback(async (node: FlatNode, how: Decompose) => {
    const level = node.kind === 'market' ? 'market' : node.kind === 'portfolio' ? 'portfolio' : 'campaign'
    setLoadingIds((s) => new Set(s).add(node.id))
    try {
      const r = await fetchHierarchy({
        level, parentId: node.id, from: win.from, to: win.to, decompose: how,
        marketplaces: market === 'all' ? [] : [market],
      })
      const kids: FlatNode[] = r.nodes.map((n) => ({
        ...n, depth: node.depth + 1, path: [...node.path, n.id],
        decompose: node.kind === 'campaign' ? how : null,
      }))
      setRows((cur) => insertChildren(cur, node.id, kids))
      // Only ADD caveats — a level's caveat stays true while its rows are on screen.
      setCaveats((cur) => [...new Set([...cur, ...r.caveats])])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoadingIds((s) => { const n = new Set(s); n.delete(node.id); return n })
    }
  }, [win, market])

  const onToggle = useCallback((node: FlatNode, next: boolean) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (next) n.add(node.id); else n.delete(node.id)
      return n
    })
    if (next) void loadChildren(node, decompose)
    else setRows((cur) => removeChildren(cur, node.id))
  }, [loadChildren, decompose])

  /** Switching the decomposition re-expands every OPEN campaign the other way. */
  const switchDecompose = useCallback((next: Decompose) => {
    setDecompose(next)
    const open = rows.filter((r) => r.kind === 'campaign' && expanded.has(r.id))
    setRows((cur) => open.reduce((acc, n) => removeChildren(acc, n.id), cur))
    for (const n of open) void loadChildren(n, next)
  }, [rows, expanded, loadChildren])

  const columns: GridColumn<FlatNode>[] = useMemo(() => (meta?.columns ?? []).map((c) => ({
    key: c.id,
    label: c.label,
    tip: c.help,
    metric: true,
    render: (r: FlatNode) => fmtMetric(r.metrics[c.id] ?? null, c.format),
  })), [meta])

  const hierarchy: GridHierarchy<FlatNode> = useMemo(() => ({
    depthOf: (r) => r.depth,
    expandableOf: (r) => r.expandable,
    expanded,
    loading: loadingIds,
    onToggle,
    isRemainder: (r) => r.kind === 'remainder',
  }), [expanded, loadingIds, onToggle])

  if (error || (loading && !meta)) return <TabState loading={loading} error={error} onRetry={reload} />
  if (!meta) return null

  const openCampaigns = rows.some((r) => r.kind === 'campaign' && expanded.has(r.id))

  return (
    <div className="rpx">
      <ProvenanceStrip
        source="Ads daily performance · campaign, product-ad and target grains"
        grain="market → portfolio → campaign → product or target"
        held={`${win.from} → ${win.to}`}
        markets={[]}
        extra={(
          <>
            <span className="k">Campaign opens into</span>
            <SegmentedControl
              value={decompose}
              onChange={(v) => switchDecompose(v as Decompose)}
              options={[{ value: 'product', label: 'Products' }, { value: 'target', label: 'Targets' }]}
              ariaLabel="What a campaign expands into"
            />
          </>
        )}
      />

      <Card
        header="Where the money went"
        description="Every level adds up to the one above it. Where it does not, the difference is its own row rather than a gap you have to notice."
        headerAction={openCampaigns
          ? <Pill tone="neutral">Campaigns open into {decompose === 'product' ? 'products' : 'targets'}</Pill>
          : undefined}
      >
        <AdsDataGrid<FlatNode>
          rows={rows}
          loading={loading}
          rowId={(r) => r.id}
          noun="Row"
          firstColLabel={meta.childLabel}
          firstSortValue={(r) => r.label}
          renderFirst={(r) => (
            <span className="gx-node">
              {r.href
                ? <Link href={r.href} className="gx-open" onClick={(e) => e.stopPropagation()}>{r.label}</Link>
                : <span className={r.kind === 'remainder' ? 'gx-rem' : 'gx-plain'}>{r.label}</span>}
              {r.sub && <span className="gx-sub">{r.sub}</span>}
              {r.href && <ChevronRight size={11} className="gx-go" aria-hidden />}
            </span>
          )}
          columns={columns}
          hierarchy={hierarchy}
          selectable={false}
          showTotal={false}
          customizable={false}
          emptyLabel="No spend in this window."
        />
      </Card>

      <Caveats items={caveats} title="How to read this tree" />
    </div>
  )
}
