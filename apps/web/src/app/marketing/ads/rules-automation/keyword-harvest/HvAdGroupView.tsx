'use client'

/**
 * The Keyword Harvest tab's **Ad Group View** — H10's second half, rebuilt in HV-R P3a.
 *
 * 🔴 **What was wrong with it.** U7 derived every row from `actions[0].mappings`, which only a
 * BUILDER rule writes. Measured on prod 2026-08-20: **all five harvest rules in this account are
 * ENGINE rules with zero mappings**, so the view rendered **0 rows** and structurally always would
 * have. The empty state was honest and well-written and still left half the page useless.
 *
 * The operator's study says what this view is for, and it is not a mirror of the rule list:
 *
 *   > "it might show you 200 rows of data. Its primary function is to manage **where** the rules
 *   > are applied… you do it here by detaching the rule from that specific ad group."
 *
 * So the rows are now every ad group that can SOURCE a harvest — 122 of them
 * (`GET /advertising/harvest-pathways`) — and the interesting row is the one with no rule on it.
 *
 * 🔴 **"Not assigned" would have been a lie on every row.** The five engine rules carry neither
 * `mappings` nor `sources`, which does not mean they reach nothing — it means they harvest by
 * threshold **across the whole account**, so they reach every ad group here. A row therefore
 * reports its REACH: a rule mapped to it specifically, or the account-wide rules that cover it, or
 * genuinely nothing. Rendering those three the same is the defect this page has been correcting
 * all day ([[reference_fleet_stale_constant_class]]).
 *
 * ⚠ Still read-only. P3b adds the Assigned-Rule dropdown and the per-pathway toggle, and the
 * `AdsHarvestAssignment` table behind them. Nothing here writes.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ruleBelongsToTab } from '../_shared/tabs'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { NoDataIllus } from '../_shared/NoDataIllus'

const BUILDER = '/marketing/ads/rules-automation/builder/keyword-harvesting'

interface PathwayAdGroup {
  id: string
  name: string
  campaignId: string
  campaignName: string
  campaignStatus: string | null
  campaignTargeting: string | null
  marketplace: string | null
  adProduct: string | null
  adGroupStatus: string | null
  role: 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT' | null
  matchTypes: string[]
  targetCount: number
  externalAdGroupId: string | null
}
interface Pathways {
  sources: PathwayAdGroup[]
  destinations: PathwayAdGroup[]
  totals: { adGroups: number; sources: number; destinations: number; neither: number; sourcesLive: number }
}

/** How a rule reaches an ad group — three different facts, three different cells. */
type Reach = 'mapped' | 'account' | 'none'

interface ReachingRule {
  id: string
  name: string
  reach: Reach
  enabled: boolean
  /** builder mapping only: what it creates / negates in this ad group */
  creates: string[]
  negates: string[]
  destinations: string[]
}

interface Row {
  key: string
  adGroup: string
  role: string
  adProduct: string
  campaign: string
  campaignPaused: boolean
  market: string
  targets: number
  local: boolean
  rules: ReachingRule[]
  /** the strongest reach any rule has on this ad group — drives the cell and the filter */
  reach: Reach
  destination: string[]
  creates: string[]
  negates: string[]
}

const ROLE_LABEL: Record<string, string> = { AUTO: 'Auto', BROAD: 'Broad', PHRASE: 'Phrase', EXACT: 'Exact' }
const PRODUCT_LABEL: Record<string, string> = {
  SPONSORED_PRODUCTS: 'SP', SPONSORED_BRANDS: 'SB', SPONSORED_DISPLAY: 'SD',
}
const TYPE_LABEL: Record<string, string> = { P: 'Phrase', E: 'Exact', product: 'Product (ASIN)' }
const badgeOf = (t: string) => (t === 'product' ? 'ASIN' : t)

export function HvAdGroupView() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [totals, setTotals] = useState<Pathways['totals'] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const base = getBackendUrl()
    // Both in parallel: the pathways are ~290 ad groups and the rules are 51 — neither should wait
    // on the other, and a failure in either must not read as "no ad groups".
    Promise.all([
      fetch(`${base}/api/advertising/harvest-pathways`, { cache: 'no-store' })
        .then((r) => { if (!r.ok) throw new Error(`pathways (${r.status})`); return r.json() as Promise<Pathways> }),
      fetch(`${base}/api/advertising/automation-rules`, { cache: 'no-store' })
        .then((r) => { if (!r.ok) throw new Error(`rules (${r.status})`); return r.json() }),
    ])
      .then(([paths, rulesJson]) => {
        if (!alive) return
        const all = (Array.isArray(rulesJson?.rules) ? rulesJson.rules : Array.isArray(rulesJson?.items) ? rulesJson.items : []) as Array<Record<string, unknown>>
        const harvest = all.filter((r) => ruleBelongsToTab(r.actions, 'keyword-harvest'))

        /**
         * 🔴 A rule with neither `mappings` nor `sources` is ACCOUNT-WIDE, not unscoped-and-inert.
         * `harvest_and_negate` harvests by threshold across everything, which is precisely why the
         * old "no mapping ⇒ nothing to show" reading produced an empty page over five live rules.
         */
        const perAdGroup = new Map<string, ReachingRule[]>()
        const accountWide: ReachingRule[] = []
        for (const rule of harvest) {
          const acts = (Array.isArray(rule.actions) ? rule.actions : []) as Array<Record<string, unknown>>
          const a0 = acts.find((a) => ['harvest_and_negate', 'promote_to_exact', 'keyword-harvesting'].includes(String(a?.type))) ?? acts[0] ?? null
          const id = String(rule.id)
          const name = String(rule.name ?? 'Untitled')
          const enabled = rule.enabled !== false
          const blocks = (Array.isArray(a0?.mappings) ? a0!.mappings : []) as Array<{ groups?: Array<Record<string, unknown>> }>
          const groups = blocks.flatMap((b) => b.groups ?? [])
          // AT.4a's wizard scope — a different shape for the same idea, and it also binds.
          const sources = (Array.isArray(a0?.sources) ? a0!.sources : []) as Array<Record<string, unknown>>
          const negateInSource = a0?.negateInSource === true

          if (!groups.length && !sources.length) {
            accountWide.push({ id, name, reach: 'account', enabled, creates: [], negates: [], destinations: [] })
            continue
          }
          const destinations = groups
            .filter((g) => (['P', 'E', 'product'] as const).some((k) => (g.types as Record<string, unknown> | undefined)?.[k]))
            .map((g) => String(g.name ?? ''))
            .filter(Boolean)
          for (const g of groups) {
            const gid = String(g.id ?? '')
            if (!gid || g.look !== true) continue
            const creates = (['P', 'E', 'product'] as const).filter((k) => (g.types as Record<string, unknown> | undefined)?.[k]).map(badgeOf)
            perAdGroup.set(gid, [...(perAdGroup.get(gid) ?? []), {
              id, name, reach: 'mapped', enabled, creates,
              negates: negateInSource ? ['E'] : [],
              destinations,
            }])
          }
          for (const s of sources) {
            const gid = String(s.adGroupId ?? '')
            if (!gid || s.harvestFrom !== true) continue
            perAdGroup.set(gid, [...(perAdGroup.get(gid) ?? []), {
              id, name, reach: 'mapped', enabled,
              creates: (Array.isArray(s.graduate) ? s.graduate : []).map(String),
              negates: (Array.isArray(s.negate) ? s.negate : []).map(String),
              destinations: [],
            }])
          }
        }

        const out: Row[] = paths.sources.map((ag) => {
          const mapped = perAdGroup.get(ag.id) ?? []
          const rules = [...mapped, ...accountWide]
          const reach: Reach = mapped.length ? 'mapped' : accountWide.length ? 'account' : 'none'
          return {
            key: ag.id,
            adGroup: ag.name,
            role: ag.role ? ROLE_LABEL[ag.role] ?? ag.role : '—',
            adProduct: ag.adProduct ? PRODUCT_LABEL[ag.adProduct] ?? ag.adProduct : '—',
            campaign: ag.campaignName || ag.campaignId,
            campaignPaused: ag.campaignStatus !== 'ENABLED',
            market: ag.marketplace ?? '—',
            targets: ag.targetCount,
            local: ag.externalAdGroupId == null,
            rules,
            reach,
            destination: [...new Set(mapped.flatMap((r) => r.destinations))],
            creates: [...new Set(mapped.flatMap((r) => r.creates))],
            negates: [...new Set(mapped.flatMap((r) => r.negates))],
          }
        })
        setRows(out); setTotals(paths.totals); setErr(null)
      })
      .catch((e) => { if (alive) setErr((e as Error).message || 'failed') })
    return () => { alive = false }
  }, [])

  const columns: GridColumn<Row>[] = useMemo(() => [
    {
      key: 'role', label: 'Ad group Type', metric: false,
      tip: 'What this ad group targets with — auto, broad or phrase. All three surface customer queries their targets did not name literally, which is what makes them harvestable. An exact ad group is not a source: its search terms are the keyword itself.',
      render: (r) => (
        <span className="h10-hv-badges">
          <span className="cp-badge prod" title={`Sponsored ${r.adProduct === 'SP' ? 'Products' : r.adProduct === 'SB' ? 'Brands' : r.adProduct === 'SD' ? 'Display' : r.adProduct}`}>{r.adProduct}</span>
          <span className="h10-hv-mt" title={`Classified ${r.role} from the targets actually in this ad group, not from its name.`}>{r.role}</span>
        </span>
      ),
    },
    {
      key: 'campaign', label: 'Campaign', metric: false,
      render: (r) => (
        <span className="h10-nt-namew"><span className="h10-nt-name" title={r.campaign}>{r.campaign}</span>
          {r.campaignPaused && <span className="h10-bd7-posture off" title="This campaign is not ENABLED, so nothing is being harvested from it right now however its rules are set.">paused</span>}
        </span>
      ),
    },
    { key: 'market', label: 'Market', metric: false, render: (r) => <span className="h10-rg-thr">{r.market}</span> },
    {
      key: 'targets', label: 'Targets', metric: true, sortable: true, sortValue: (r) => r.targets,
      tip: 'Positive targets currently in this ad group.',
      render: (r) => <span className="h10-rg-thr">{r.targets.toLocaleString('en-IE')}</span>,
    },
    {
      key: 'reach', label: 'Harvest Rule', metric: false, sortable: true, sortValue: (r) => (r.reach === 'mapped' ? 2 : r.reach === 'account' ? 1 : 0),
      tip: 'Which rules harvest from this ad group — one mapped to it specifically, or the account-wide rules that cover every ad group.',
      render: (r) => {
        if (r.reach === 'mapped') {
          const m = r.rules.filter((x) => x.reach === 'mapped')
          return (
            <span className="h10-hv-badges">
              {m.map((x) => <a key={x.id} className="h10-nt-name" href={`${BUILDER}?ruleId=${x.id}`} title={`“${x.name}” is mapped to this ad group specifically.`}>{x.name}</a>)}
            </span>
          )
        }
        if (r.reach === 'account') {
          const live = r.rules.filter((x) => x.enabled)
          return (
            <span
              className={`h10-rg-thr${live.length ? '' : ' none'}`}
              title={`${r.rules.length} harvest ${r.rules.length === 1 ? 'rule' : 'rules'} harvest by threshold across the whole account, so ${r.rules.length === 1 ? 'it reaches' : 'they reach'} this ad group without naming it: ${r.rules.map((x) => `${x.name}${x.enabled ? '' : ' (disabled)'}`).join(', ')}. ${live.length ? `${live.length} of them ${live.length === 1 ? 'is' : 'are'} enabled.` : 'None of them is enabled, so nothing reaches this ad group today.'}`}
            >{r.rules.length} account-wide{live.length ? '' : ' (all off)'}</span>
          )
        }
        return <span className="h10-rg-thr none" title="No harvest rule reaches this ad group — no rule is mapped to it and none runs account-wide.">Not assigned</span>
      },
    },
    {
      key: 'destination', label: 'Destination', metric: false, sortable: false,
      tip: 'The ad group a harvested term is created in. Only a mapped rule names one; an account-wide rule resolves its destination per term when it runs.',
      render: (r) => (r.destination.length
        ? <span className="h10-nt-crit" title={r.destination.join(', ')}>{r.destination.join(', ')}</span>
        : r.reach === 'account'
          ? <span className="h10-rg-thr none" title="An account-wide rule picks the destination per term when it runs, from the harvest destination resolver — it is not fixed per ad group, so there is nothing to name here in advance.">Resolved per term</span>
          : <span className="h10-rg-thr none" title="No rule reaches this ad group, so nothing is being created anywhere from it.">—</span>),
    },
    {
      key: 'creates', label: 'Creates', metric: false, sortable: false,
      render: (r) => (r.creates.length
        ? <span className="h10-hv-badges">{r.creates.map((t) => <span key={t} className="h10-hv-mt" title={`Creates a ${TYPE_LABEL[t === 'ASIN' ? 'product' : t] ?? t} target`}>{t}</span>)}</span>
        : r.reach === 'account'
          ? <span className="h10-hv-badges"><span className="h10-hv-mt" title="Account-wide harvest rules graduate a converting term to EXACT.">E</span></span>
          : <span className="h10-rg-thr none">—</span>),
    },
    {
      key: 'negates', label: 'Negates', metric: false, sortable: false,
      tip: 'H10 calls this Search Term Isolation: the harvested term is added as a negative in its source ad group so the source stops competing with the new target.',
      render: (r) => (r.negates.length
        ? <span className="h10-hv-badges">{r.negates.map((t) => <span key={t} className="h10-hv-mt neg" title="The harvested term is negated here, in its source">{t}</span>)}</span>
        : <span className="h10-rg-thr none" title="Nothing is negated at source, so this ad group keeps competing for a term after it has been promoted elsewhere.">—</span>),
    },
  ], [])

  /**
   * The Filters card H10 keeps above this grid. Built from the ROSTER rather than from the visible
   * rows, and rendered whether or not there are any — the U7 version built its options from `rows`,
   * so with zero rows there was no filter bar at all.
   */
  const filters: GridFilter[] = useMemo(() => {
    const src = rows ?? []
    const uniq = (f: (r: Row) => string) => [...new Set(src.map(f))].filter(Boolean).sort()
    return [
      { key: 'campaign', label: 'Source Campaign', kind: 'multiselect', searchable: true, options: uniq((r) => r.campaign).map((v) => ({ value: v, label: v })), value: (r) => (r as Row).campaign },
      { key: 'destination', label: 'Destination Campaign', kind: 'multiselect', searchable: true, options: [...new Set(src.flatMap((r) => r.destination))].sort().map((v) => ({ value: v, label: v })), value: (r) => (r as Row).destination.join(', ') },
      { key: 'rule', label: 'Harvest Rule', kind: 'multiselect', searchable: true, options: [...new Set(src.flatMap((r) => r.rules.map((x) => x.name)))].sort().map((v) => ({ value: v, label: v })), value: (r) => (r as Row).rules.map((x) => x.name).join(', ') },
      { key: 'role', label: 'Ad group Type', kind: 'multiselect', options: uniq((r) => r.role).map((v) => ({ value: v, label: v })), value: (r) => (r as Row).role },
      { key: 'market', label: 'Market', kind: 'multiselect', options: uniq((r) => r.market).map((v) => ({ value: v, label: v })), value: (r) => (r as Row).market },
      {
        key: 'reach', label: 'Assignment', kind: 'select',
        options: [{ value: 'mapped', label: 'Mapped to a rule' }, { value: 'account', label: 'Account-wide only' }, { value: 'none', label: 'Not assigned' }],
        value: (r) => (r as Row).reach,
      },
      {
        key: 'status', label: 'Campaign status', kind: 'select',
        options: [{ value: 'live', label: 'Enabled' }, { value: 'paused', label: 'Not enabled' }],
        value: (r) => ((r as Row).campaignPaused ? 'paused' : 'live'),
      },
    ]
  }, [rows])

  const empty = err != null ? (
    <span className="h10-rr-empty">
      <b><AlertTriangle size={14} aria-hidden /> The ad groups failed to load — {err}</b>
      <span className="sub">This is a failed read, not an empty account. Reload the page.</span>
    </span>
  ) : (
    <span className="h10-rr-empty">
      <NoDataIllus size={104} />
      <b>No ad group can source a harvest</b>
      <span className="sub">
        A harvest reads search terms from auto, broad and phrase ad groups. This account has none of
        those with targets in them, so there is nothing to harvest from — that is an account-shape
        finding, not a missing rule.
      </span>
    </span>
  )

  return (
    <AdsDataGrid<Row>
      rows={rows ?? []}
      loading={rows == null && err == null}
      rowId={(r) => r.key}
      noun="Ad Group"
      firstColLabel="Ad Group"
      renderFirst={(r) => (
        <span className="h10-nt-namew h10-rg-namew">
          <span className="h10-nt-name" title={r.adGroup}>{r.adGroup}</span>
          {r.local && <span className="h10-bd7-posture off" title="This ad group has never reached Amazon — it has no external id, so nothing can be harvested from it live.">local only</span>}
        </span>
      )}
      firstSortValue={(r) => r.adGroup}
      columns={columns}
      filters={filters}
      filtersDefaultOpen
      customizable={false}
      searchable
      searchPlaceholder="Search ad groups, campaigns or rules…"
      searchValue={(r) => `${r.adGroup} ${r.campaign} ${r.rules.map((x) => x.name).join(' ')}`}
      pagerCentered
      emptyNode={empty}
      /* The roster, stated once — 122 of 289, and only 51 of those in a live campaign. Without it
         the grid reads as "here are 122 ad groups" and hides that two thirds are not running. */
      toolbarLeft={totals
        ? <span className="h10-hv-roster">{totals.sources} of {totals.adGroups} ad groups can source a harvest · <b>{totals.sourcesLive}</b> in an enabled campaign · {totals.destinations} can receive one</span>
        : null}
      toolbarRight={<a className="h10-am-btn primary" href={BUILDER}>Rule <ExternalLink size={12} aria-hidden /></a>}
    />
  )
}
