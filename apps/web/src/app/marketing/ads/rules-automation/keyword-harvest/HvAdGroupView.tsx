'use client'

/**
 * U7 — the Keyword Harvest tab's **Ad Group View**, the second half of H10's pill.
 *
 * H10 shows, per harvest rule, the ad-group mapping the rule was built with: which ad groups it
 * reads search terms FROM, which it creates targets IN, and what it creates. Its column set is
 * known from the app bundle (study §5.3): "Ad group Type · Ad Group · Campaign · Of Target ·
 * Harvest Rule · Keyword BPE · Negative Keyword · Negative Targets".
 *
 * 🔴 Two deliberate departures, both because inventing a column is worse than omitting one:
 * · **"Of Target" is not reproduced.** Its semantics were not recoverable — the recording never
 *   loaded this grid and the bundle gives only the label. A column whose meaning we are guessing at
 *   is the decorative-column class this programme is removing.
 * · **"Keyword BPE" renders P/E/ASIN, not B/P/E.** Our harvest builder's positive match types are
 *   Phrase, Exact and Product (`MATCH_TYPES_POS`); it cannot create a Broad target, so a B badge
 *   would describe a capability we do not have.
 *
 * 🔴 **Where the rows come from, and why there are none yet.** A mapping is written by the BUILDER
 * (`actions[0].mappings`). Measured on prod 2026-08-18: all five harvest rules are ENGINE rules —
 * `harvest_and_negate` / `promote_to_exact` with threshold parameters (`minOrders`, `windowDays`,
 * `minSpendCents`, `graduationBidEur`) and **no mappings at all**. They harvest by threshold across
 * the account rather than along a mapping. So this view is empty today, and it says exactly that
 * instead of rendering an empty table that implies data is missing. It fills itself the moment a
 * harvest rule is created in the builder.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ruleBelongsToTab } from '../_shared/tabs'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { NoDataIllus } from '../_shared/NoDataIllus'

const BUILDER = '/marketing/ads/rules-automation/builder/keyword-harvesting'

interface MappedGroup {
  id: string
  name: string
  campaignId: string
  campaignName: string | null
  adProduct: string | null
  status: string
  /** "Look for Search Terms in These Ad Groups" — the source half of the mapping. */
  look?: boolean
  types?: { P?: boolean; E?: boolean; product?: boolean }
}

interface Row {
  key: string
  adGroup: string
  type: string
  campaign: string
  role: 'Source' | 'Destination'
  ruleId: string
  ruleName: string
  creates: string[]
  negates: string[]
}

const TYPE_LABEL: Record<string, string> = { P: 'Phrase', E: 'Exact', product: 'Product (ASIN)' }
const badgeOf = (t: string) => (t === 'product' ? 'ASIN' : t)

export function HvAdGroupView() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** Rules that ARE harvest rules but carry no mapping — the honest reason the table is empty. */
  const [unmapped, setUnmapped] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => {
        if (!alive) return
        const all = (Array.isArray(j?.rules) ? j.rules : Array.isArray(j?.items) ? j.items : []) as Array<Record<string, unknown>>
        const mine = all.filter((r) => ruleBelongsToTab(r.actions, 'keyword-harvest'))
        const out: Row[] = []
        const bare: Array<{ id: string; name: string }> = []
        for (const rule of mine) {
          const a0 = (Array.isArray(rule.actions) ? rule.actions[0] : null) as Record<string, unknown> | null
          const blocks = (Array.isArray(a0?.mappings) ? a0!.mappings : []) as Array<{ groups?: MappedGroup[] }>
          const groups = blocks.flatMap((b) => b.groups ?? [])
          if (!groups.length) { bare.push({ id: String(rule.id), name: String(rule.name ?? 'Untitled') }); continue }
          // The rule-level "negate the harvested term in its source" switch — our model holds this
          // per rule, not per ad group, so it is reported on every row of that rule and nowhere
          // implied to be a per-ad-group choice.
          const negateInSource = a0?.negateInSource === true
          for (const g of groups) {
            const creates = (['P', 'E', 'product'] as const).filter((k) => g.types?.[k])
            out.push({
              key: `${rule.id}:${g.id}`,
              adGroup: g.name,
              type: g.adProduct ?? '—',
              campaign: g.campaignName ?? g.campaignId,
              role: g.look ? 'Source' : 'Destination',
              ruleId: String(rule.id),
              ruleName: String(rule.name ?? 'Untitled'),
              creates: g.look ? [] : creates.map(badgeOf),
              negates: g.look && negateInSource ? ['E'] : [],
            })
          }
        }
        setRows(out); setUnmapped(bare); setErr(null)
      })
      .catch((e) => { if (alive) setErr((e as Error).message || 'failed') })
    return () => { alive = false }
  }, [])

  const columns: GridColumn<Row>[] = useMemo(() => [
    { key: 'type', label: 'Type', metric: false, render: (r) => <span className="cp-badge prod">{r.type}</span> },
    { key: 'campaign', label: 'Campaign', metric: false, render: (r) => <span className="h10-nt-crit" title={r.campaign}>{r.campaign}</span> },
    {
      key: 'role', label: 'Role', metric: false,
      render: (r) => (
        <span
          className={`h10-bd7-posture ${r.role === 'Source' ? 'observe' : 'propose'}`}
          title={r.role === 'Source'
            ? 'Search terms are read FROM this ad group.'
            : 'New targets are created IN this ad group.'}
        >{r.role}</span>
      ),
    },
    {
      key: 'rule', label: 'Harvest Rule', metric: false,
      render: (r) => <a className="h10-nt-name" href={`${BUILDER}?ruleId=${r.ruleId}`} title={r.ruleName}>{r.ruleName}</a>,
    },
    {
      key: 'creates', label: 'Creates', metric: false, sortable: false,
      render: (r) => (r.creates.length
        ? <span className="h10-hv-badges">{r.creates.map((t) => <span key={t} className="h10-hv-mt" title={TYPE_LABEL[t === 'ASIN' ? 'product' : t]}>{t}</span>)}</span>
        : <span className="h10-bd8-muted">—</span>),
    },
    {
      key: 'negates', label: 'Negates', metric: false, sortable: false,
      render: (r) => (r.negates.length
        ? <span className="h10-hv-badges">{r.negates.map((t) => <span key={t} className="h10-hv-mt neg" title="The harvested term is negated in its source ad group">{t}</span>)}</span>
        : <span className="h10-bd8-muted">—</span>),
    },
  ], [])

  const filters: GridFilter[] = useMemo(() => {
    if (!rows?.length) return []
    const uniq = (f: (r: Row) => string) => [...new Set(rows.map(f))].filter(Boolean).sort()
    return [
      { key: 'campaign', label: 'Campaign', kind: 'multiselect', searchable: true, options: uniq((r) => r.campaign).map((v) => ({ value: v, label: v })), value: (r) => (r as Row).campaign },
      { key: 'rule', label: 'Harvest Rule', kind: 'multiselect', searchable: true, options: uniq((r) => r.ruleName).map((v) => ({ value: v, label: v })), value: (r) => (r as Row).ruleName },
      { key: 'role', label: 'Role', kind: 'select', options: [{ value: 'Source', label: 'Source' }, { value: 'Destination', label: 'Destination' }], value: (r) => (r as Row).role },
    ]
  }, [rows])

  const empty = err != null ? (
    <span className="h10-rr-empty">
      <b><AlertTriangle size={14} aria-hidden /> The mappings failed to load {err}</b>
      <span className="sub">This is a failed read, not an empty mapping. Reload the page.</span>
    </span>
  ) : (
    <span className="h10-rr-empty">
      <NoDataIllus size={104} />
      <b>No ad-group mapping to show</b>
      <span className="sub">
        {unmapped.length
          ? <>The {unmapped.length} harvest {unmapped.length === 1 ? 'rule' : 'rules'} here {unmapped.length === 1 ? 'is an engine rule' : 'are engine rules'}: they harvest by threshold across the account rather than along an ad-group mapping, so there is nothing to map. A mapping appears here when you build a harvest rule with one.</>
          : <>A mapping appears here once a harvest rule is created with source and destination ad groups.</>}
      </span>
      <a className="h10-am-btn primary" href={BUILDER}>Create Rule</a>
    </span>
  )

  return (
    <AdsDataGrid<Row>
      rows={rows ?? []}
      loading={rows == null && err == null}
      rowId={(r) => r.key}
      noun="Ad Group"
      firstColLabel="Ad Group"
      renderFirst={(r) => <span className="h10-nt-namew h10-rg-namew"><span className="h10-nt-name" title={r.adGroup}>{r.adGroup}</span></span>}
      firstSortValue={(r) => r.adGroup}
      columns={columns}
      filters={filters}
      filtersDefaultOpen={false}
      customizable={false}
      searchable
      searchPlaceholder="Search ad groups…"
      searchValue={(r) => `${r.adGroup} ${r.campaign} ${r.ruleName}`}
      pagerCentered
      emptyNode={empty}
      toolbarRight={<a className="h10-am-btn primary" href={BUILDER}>Rule <ExternalLink size={12} aria-hidden /></a>}
    />
  )
}
