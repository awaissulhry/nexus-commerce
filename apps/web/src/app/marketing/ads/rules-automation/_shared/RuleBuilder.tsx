'use client'

/**
 * Shared full-screen "Create Rule" builder, pixel-matched to Helium 10 Ads / Adtomic.
 *
 * One component drives every rule type (Negative Targeting · Keyword Harvesting · Budget ·
 * Bid · …) — the Keyword-Harvest session plugs its type in via `slug` + the section config.
 * Layout mirrors the AiGoalBuilder takeover: a fixed top bar (✕ · type title · Learn ·
 * Create Rule) + a left scroll-spy step nav + a single scrolling content pane whose sections
 * are the steps (Rule Name · {Setup} · Criteria · Search Terms · Advanced Settings · Control).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { X, Video, Plus, Trash2, Copy, MousePointerClick, Check, Search, Info, ChevronDown, Package, Eye } from 'lucide-react'
import { H10Select, HoverCard } from '../../campaigns/FilterDropdown'
import { ruleTypeBySlug } from './ruleTypes'
import { getBackendUrl } from '@/lib/backend-url'

// ── option catalogs (verbatim H10 copy where captured) ──
const METRICS = ['Sales', 'ACOS', 'ROAS', 'Clicks', 'Impressions', 'CVR', 'CTR', 'CPC', 'PPC Orders', 'Spend', 'Orders'].map((m) => ({ value: m, label: m }))
const OPERATORS = [
  { value: 'eq', label: 'Equal to =' },
  { value: 'ne', label: 'Not equal to ≠' },
  { value: 'gt', label: 'Greater than >' },
  { value: 'gte', label: 'Greater than or equal to >=' },
  { value: 'lt', label: 'Less than <' },
  { value: 'lte', label: 'Less than or equal to <=' },
]
const LOOKBACK = ['Last 7 Days', 'Last 14 Days', 'Last 30 Days', 'Last 60 Days', 'Last 90 Days', 'Lifetime'].map((l) => ({ value: l, label: l }))
// H10 "Lookback period … Exclude <recent window>" — keep the most-recent N days out of the window.
const EXCLUDE = ['None', 'Last 1 Day', 'Last 3 Days', 'Last 7 Days', 'Last 14 Days', 'Last 30 Days'].map((l) => ({ value: l, label: l }))
const FREQUENCY = ['Custom', 'Daily', 'Weekly', 'Monthly', 'Hourly'].map((f) => ({ value: f, label: f }))
const INTERVAL = ['Days', 'Weeks', 'Months'].map((i) => ({ value: i, label: i }))
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ value: d, label: d }))
// per-metric value unit (€ for money, % for rate metrics, plain count otherwise) — matches H10
const METRIC_UNIT: Record<string, 'eur' | 'pct' | ''> = {
  Sales: 'eur', Spend: 'eur', CPC: 'eur',
  ACOS: 'pct', CTR: 'pct', CVR: 'pct',
  ROAS: '', Clicks: '', Impressions: '', 'PPC Orders': '', Orders: '',
}
// builder slug → backend automation-rule trigger (the create payload)
const TRIGGER_BY_SLUG: Record<string, string> = {
  'negative-targeting': 'SEARCH_TERM_WASTING',
  'keyword-harvesting': 'SEARCH_TERM_CONVERTING',
  bid: 'KEYWORD_HIGH_ACOS',
  budget: 'CAMPAIGN_PERFORMANCE_BUDGET',
  'dayparting-schedule': 'SCHEDULE',
  'budget-schedule': 'SCHEDULE',
  placement: 'CAMPAIGN_PERFORMANCE_BUDGET',
}
// friendly match-type label for the negative preview (raw API gives EXACT/PHRASE/BROAD or TARGETING_EXPRESSION*)
const matchLabel = (m?: string): string => {
  if (!m) return '—'
  if (m === 'EXACT') return 'Exact'
  if (m === 'PHRASE') return 'Phrase'
  if (m === 'BROAD') return 'Broad'
  if (/TARGETING_EXPRESSION/.test(m)) return 'Auto'
  return m
}
const TIMES = Array.from({ length: 24 }, (_, h) => {
  const hh = String(h).padStart(2, '0')
  const ampm = h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`
  return { value: `${hh}:00`, label: `${ampm} (${hh}:00)` }
})
const TIMEZONES = [
  { value: 'pst', label: 'PST/PDT - Pacific Standard/Daylight Time, Los Angeles' },
  { value: 'est', label: 'EST/EDT - Eastern Standard/Daylight Time, New York' },
  { value: 'utc', label: 'UTC - Coordinated Universal Time' },
  { value: 'cet', label: 'CET/CEST - Central European Time, Rome' },
]
// target match types — the maroon P / E / 📦 circles in the "What targets" header.
// Glyphs are identical for both rule types (the 3rd is a package/Product-ASIN icon, not "M");
// only the hover copy differs (negative vs positive).
interface MatchType { key: string; product?: boolean; tip: string }
const MATCH_TYPES_NEG: MatchType[] = [
  { key: 'P', tip: 'Negative Phrase' },
  { key: 'E', tip: 'Negative Exact' },
  { key: 'product', product: true, tip: 'Negative Product (ASIN)' },
]
const MATCH_TYPES_POS: MatchType[] = [
  { key: 'P', tip: 'Phrase' },
  { key: 'E', tip: 'Exact' },
  { key: 'product', product: true, tip: 'Product (ASIN)' },
]

// Ad-group selection (H2): the "Add Ad Group" popover → the populated left/right two-panel.
interface AdGroupItem { id: string; name: string; campaignId: string; campaignName: string | null; status: string; campaignStatus: string | null; adProduct: string | null; portfolioId: string | null }
interface SelGroup extends AdGroupItem { look: boolean; types: { P: boolean; E: boolean; product: boolean } }
// H3 — a rule can hold multiple source→target "Ad Group Mapping" blocks (Harvest; Negative uses one).
interface MapBlock { id: number; groups: SelGroup[] }
let _bid = 1

interface Condition { metric: string; op: string; value: string }
interface CriteriaGroup { id: number; conditions: Condition[]; lookback: string; exclude: string }
let _cid = 1
// Harvest seeds "PPC Orders ≥ 1" (converting); Negative (+others) seed "Sales = 0" (non-converting).
const defaultCondition = (slug: string): Condition => (slug === 'keyword-harvesting' ? { metric: 'PPC Orders', op: 'gte', value: '1' } : { metric: 'Sales', op: 'eq', value: '0' })
const newGroup = (slug: string): CriteriaGroup => ({ id: _cid++, conditions: [defaultCondition(slug)], lookback: 'Last 60 Days', exclude: 'Last 3 Days' })

// per-type Rule Setup config — Negative vs Positive/Harvest differ in heading, copy,
// targets-panel title, and whether Harvest's "Ad Group Mapping" button + info banner show.
const SETUP: Record<string, { nav: string; desc: string; targetsTitle: string; matchTypes: MatchType[]; mapping?: boolean; banner?: string }> = {
  'negative-targeting': {
    nav: 'Negative Rule Setup',
    desc: 'Add related Ad Groups in any order and select which ones you’d like Nexus Ads to use to find non-converting search terms/ASINs. For each Ad Group, you can then decide which type of target you want to create when it finds a non-converting search term/ASIN.',
    targetsTitle: 'Create New Negative Targets',
    matchTypes: MATCH_TYPES_NEG,
  },
  'keyword-harvesting': {
    nav: 'Positive Rule Setup',
    desc: 'Add related Ad Groups in any order and select which ones you’d like Nexus Ads to use to find converting search terms/ASINs. For each Ad Group, you can then decide which type of target you want to create when it finds a converting search term/ASIN.',
    targetsTitle: 'Create New Targets',
    matchTypes: MATCH_TYPES_POS,
    mapping: true,
    banner: 'Nexus Ads is checking for search terms that hit the specified criteria per ad group, and not aggregating performance metrics across all selected ad groups',
  },
}
const setupFor = (slug: string) => SETUP[slug] ?? SETUP['negative-targeting']

// Adtomic-style atom mark (two crossing orbits + nucleus) — our own SVG that matches the
// builder top-bar glyph in the recording more closely than lucide's 3-orbit Atom.
function AtomMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ic">
      <g transform="rotate(45 12 12)"><ellipse cx="12" cy="12" rx="10.4" ry="4.3" stroke="#1f6fde" strokeWidth="1.7" /></g>
      <g transform="rotate(-45 12 12)"><ellipse cx="12" cy="12" rx="10.4" ry="4.3" stroke="#1f6fde" strokeWidth="1.7" /></g>
      <circle cx="12" cy="12" r="2.5" fill="#0b1f44" />
    </svg>
  )
}

const STEPS_FOR = (slug: string): Array<{ id: string; label: string }> => {
  const setupLabel = SETUP[slug]?.nav ?? 'Rule Setup'
  return [
    { id: 'rule-name', label: 'Rule Name' },
    { id: 'setup', label: setupLabel },
    { id: 'criteria', label: 'Criteria' },
    { id: 'search-terms', label: 'Search Terms' },
    { id: 'advanced', label: 'Advanced Settings' },
    { id: 'control', label: 'Control' },
  ]
}

export function RuleBuilder({ slug }: { slug: string }) {
  const router = useRouter()
  const ruleId = useSearchParams().get('ruleId')
  const isEdit = !!ruleId
  const rt = ruleTypeBySlug(slug)
  const steps = STEPS_FOR(slug)
  const setup = setupFor(slug)
  const isHarvest = slug === 'keyword-harvesting' // harvest-only features (bid · negate-in-source · Preview) gate on this
  const close = useCallback(() => router.push('/marketing/ads/rules-automation'), [router])

  const [ruleName, setRuleName] = useState('')
  const [groups, setGroups] = useState<CriteriaGroup[]>(() => [newGroup(slug)])
  const [searchMode, setSearchMode] = useState<'contains' | 'not'>('contains')
  const [searchText, setSearchText] = useState('')
  const [searchTerms, setSearchTerms] = useState<Array<{ term: string; op: 'contains' | 'not' }>>([])
  const addSearchTerms = () => {
    const terms = searchText.split(/[\n,]/).map((t) => t.trim()).filter(Boolean)
    if (!terms.length) return
    setSearchTerms((cur) => { const have = new Set(cur.map((x) => `${x.op}::${x.term.toLowerCase()}`)); return [...cur, ...terms.filter((t) => !have.has(`${searchMode}::${t.toLowerCase()}`)).map((t) => ({ term: t, op: searchMode }))] })
    setSearchText('')
  }
  const [frequency, setFrequency] = useState('Daily')
  const [everyN, setEveryN] = useState('')
  const [interval, setInterval] = useState('Weeks')
  const [onDay, setOnDay] = useState('Monday')
  const [time, setTime] = useState('00:00')
  const [timezone, setTimezone] = useState('pst')
  const [dedupe, setDedupe] = useState(true)
  const [control, setControl] = useState<'manual' | 'automate'>('manual')
  // ── ad-group mapping blocks (H3): Harvest can hold multiple source→target mappings; Negative
  //    always has one. Each block carries its own selected ad groups + per-group target types. ──
  const [blocks, setBlocks] = useState<MapBlock[]>([{ id: 1, groups: [] }])
  const [openPop, setOpenPop] = useState<number | null>(null)
  const [setupCollapsed, setSetupCollapsed] = useState(false)
  const updateBlock = (bid: number, fn: (b: MapBlock) => MapBlock) => setBlocks((bs) => bs.map((b) => (b.id === bid ? fn(b) : b)))
  const addBlock = () => setBlocks((bs) => [...bs, { id: ++_bid, groups: [] }])
  const removeBlock = (bid: number) => setBlocks((bs) => (bs.length > 1 ? bs.filter((b) => b.id !== bid) : bs))
  const addGroups = (bid: number, items: AdGroupItem[]) => updateBlock(bid, (b) => { const have = new Set(b.groups.map((g) => g.id)); return { ...b, groups: [...b.groups, ...items.filter((i) => !have.has(i.id)).map((i) => ({ ...i, look: true, types: { P: true, E: true, product: false } }))] } })
  const removeGroup = (bid: number, id: string) => updateBlock(bid, (b) => ({ ...b, groups: b.groups.filter((g) => g.id !== id) }))
  const toggleLook = (bid: number, id: string) => updateBlock(bid, (b) => ({ ...b, groups: b.groups.map((g) => (g.id === id ? { ...g, look: !g.look } : g)) }))
  const toggleType = (bid: number, id: string, t: 'P' | 'E' | 'product') => updateBlock(bid, (b) => ({ ...b, groups: b.groups.map((g) => (g.id === id ? { ...g, types: { ...g.types, [t]: !g.types[t] } } : g)) }))
  const [creating, setCreating] = useState(false)
  // ── H7 best-in-class (beyond the recording) ──
  const [negateInSource, setNegateInSource] = useState(false)
  const [bidMode, setBidMode] = useState<'suggested' | 'fixed'>('suggested')
  const [bidValue, setBidValue] = useState('')
  const [brandExclude, setBrandExclude] = useState('')
  const [competitorOnly, setCompetitorOnly] = useState(false)
  // ── N2 negative-targeting best-in-class (negative-only) ──
  const [protectConverting, setProtectConverting] = useState(true)
  const [protectDays, setProtectDays] = useState('30')
  const [negationLevel, setNegationLevel] = useState<'adgroup' | 'campaign' | 'both'>('adgroup')
  const [preview, setPreview] = useState<{ open: boolean; loading: boolean; terms: Array<{ term: string; orders?: number; spend?: number; clicks?: number; matchType?: string }> } | null>(null)
  // Live, read-only preview — harvest shows converting terms, negative shows wasting terms.
  const runPreview = useCallback(async () => {
    setPreview({ open: true, loading: true, terms: [] })
    try {
      const lb = groups[0]?.lookback ?? 'Last 60 Days'
      const windowDays = Number((lb.match(/\d+/) ?? ['60'])[0]) || 60
      const all = groups.flatMap((g) => g.conditions)
      const sc = all.find((c) => c.metric === 'Spend')
      if (isHarvest) {
        const oc = all.find((c) => c.metric === 'PPC Orders' || c.metric === 'Orders')
        const minOrders = oc ? Math.max(1, Math.round(Number(oc.value) || 1)) : 1
        const qs = new URLSearchParams({ windowDays: String(windowDays), minOrders: String(minOrders), ...(sc ? { minSpendCents: String(Math.round((Number(sc.value) || 0) * 100)) } : {}) })
        const j = await fetch(`${getBackendUrl()}/api/advertising/harvest/preview?${qs}`).then((r) => r.json()).catch(() => ({}))
        const raw = (j.candidates ?? j.terms ?? j.items ?? (Array.isArray(j) ? j : [])) as Array<Record<string, unknown>>
        setPreview({ open: true, loading: false, terms: raw.slice(0, 100).map((t) => ({ term: String(t.searchTerm ?? t.term ?? t.query ?? ''), orders: Number(t.orders ?? t.ppcOrders ?? 0) || undefined, spend: t.spendCents != null ? Number(t.spendCents) / 100 : (t.spend != null ? Number(t.spend) : undefined) })).filter((t) => t.term) })
      } else {
        const minSpend = sc ? Math.max(0, Number(sc.value) || 0) : 0
        const qs = new URLSearchParams({ lookbackDays: String(windowDays), minSpend: String(minSpend), limit: '100' })
        const j = await fetch(`${getBackendUrl()}/api/advertising/reports/negative-keyword-candidates?${qs}`).then((r) => r.json()).catch(() => ({}))
        const raw = (j.candidates ?? j.terms ?? j.items ?? (Array.isArray(j) ? j : [])) as Array<Record<string, unknown>>
        setPreview({ open: true, loading: false, terms: raw.slice(0, 100).map((t) => ({ term: String(t.query ?? t.searchTerm ?? t.term ?? ''), matchType: t.matchType ? String(t.matchType) : undefined, clicks: Number(t.totalClicks ?? t.clicks ?? 0) || undefined, spend: t.totalCostUnits != null ? Number(t.totalCostUnits) : (t.spendCents != null ? Number(t.spendCents) / 100 : (t.spend != null ? Number(t.spend) : undefined)) })).filter((t) => t.term) })
      }
    } catch { setPreview({ open: true, loading: false, terms: [] }) }
  }, [groups, isHarvest])
  // Esc closes the Preview modal
  useEffect(() => {
    if (!preview?.open) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null) }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [preview?.open])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState('rule-name')

  // scroll-spy: the section whose top is nearest above the fold is "active"
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const top = el.scrollTop + 140
      let cur = steps[0].id
      for (const s of steps) {
        const node = document.getElementById(`rb-${s.id}`)
        if (node && node.offsetTop <= top) cur = s.id
      }
      setActive(cur)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [steps])

  const goto = (id: string) => {
    const node = document.getElementById(`rb-${id}`)
    const el = scrollRef.current
    if (node && el) el.scrollTo({ top: node.offsetTop - 24, behavior: 'smooth' })
  }

  // criteria mutations
  const addCondition = (gid: number) => setGroups((gs) => gs.map((g) => g.id === gid ? { ...g, conditions: [...g.conditions, { metric: 'Clicks', op: 'gte', value: '' }] } : g))
  const removeCondition = (gid: number, i: number) => setGroups((gs) => gs.map((g) => g.id === gid ? { ...g, conditions: g.conditions.filter((_, j) => j !== i) } : g).filter((g) => g.conditions.length > 0))
  const setCond = (gid: number, i: number, patch: Partial<Condition>) => setGroups((gs) => gs.map((g) => g.id === gid ? { ...g, conditions: g.conditions.map((c, j) => j === i ? { ...c, ...patch } : c) } : g))
  const setLookback = (gid: number, v: string) => setGroups((gs) => gs.map((g) => g.id === gid ? { ...g, lookback: v } : g))
  const addGroup = () => setGroups((gs) => [...gs, newGroup(slug)])
  const dupGroup = (gid: number) => setGroups((gs) => { const g = gs.find((x) => x.id === gid); return g ? [...gs, { ...g, id: _cid++, conditions: g.conditions.map((c) => ({ ...c })) }] : gs })
  const delGroup = (gid: number) => setGroups((gs) => (gs.length > 1 ? gs.filter((g) => g.id !== gid) : gs))
  const setExclude = (gid: number, v: string) => setGroups((gs) => gs.map((g) => g.id === gid ? { ...g, exclude: v } : g))

  const adGroupCount = blocks.reduce((n, b) => n + b.groups.length, 0)
  const criteriaValid = groups.every((g) => g.conditions.length > 0 && g.conditions.every((c) => c.value.trim() !== ''))
  const valid = ruleName.trim().length > 0 && adGroupCount > 0 && criteriaValid

  // ── create the rule (POST /advertising/automation-rules — starts disabled + dry-run) ──
  const submit = useCallback(async () => {
    if (!valid || creating) return
    setCreating(true)
    try {
      const payload = {
        name: ruleName.trim(),
        description: `${rt?.label ?? 'Rule'} — ${isEdit ? 'edited' : 'created'} in Rule Builder`,
        trigger: TRIGGER_BY_SLUG[slug] ?? 'SCHEDULE',
        conditions: groups.map((g) => ({ match: 'all', lookback: g.lookback, exclude: g.exclude, conditions: g.conditions })),
        actions: [{
          type: slug, control, dedupe, negateInSource, bid: { mode: bidMode, value: bidValue }, filters: { brandExclude: brandExclude.split(/[\n,]/).map((t) => t.trim()).filter(Boolean), competitorOnly }, searchTerms, schedule: { frequency, everyN, interval, onDay, time, timezone },
          ...(isHarvest ? {} : { protectConverting, protectDays: Math.max(0, Math.round(Number(protectDays) || 30)), negationLevel }),
          mappings: blocks.map((b) => ({ groups: b.groups.map((g) => ({ id: g.id, name: g.name, campaignId: g.campaignId, campaignName: g.campaignName, status: g.status, adProduct: g.adProduct, portfolioId: g.portfolioId, look: g.look, types: g.types })) })),
        }],
      }
      const base = `${getBackendUrl()}/api/advertising/automation-rules`
      const r = await fetch(isEdit ? `${base}/${ruleId}` : base, { method: isEdit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j?.error == null) router.push('/marketing/ads/rules-automation')
    } finally { setCreating(false) }
  }, [valid, creating, ruleName, rt, slug, groups, control, dedupe, negateInSource, bidMode, bidValue, brandExclude, competitorOnly, isHarvest, protectConverting, protectDays, negationLevel, searchTerms, frequency, everyN, interval, onDay, time, timezone, blocks, isEdit, ruleId, router])

  // ── edit mode: load an existing rule's stored JSON back into the builder ──
  useEffect(() => {
    if (!ruleId) return
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${ruleId}`).then((r) => r.json())
        const rule = j?.rule
        if (!alive || !rule) return
        setRuleName(rule.name ?? '')
        const conds = Array.isArray(rule.conditions) ? rule.conditions : []
        if (conds.length) setGroups(conds.map((c: { conditions?: Condition[]; lookback?: string; exclude?: string }) => ({ id: ++_cid, conditions: Array.isArray(c.conditions) && c.conditions.length ? c.conditions : [defaultCondition(slug)], lookback: c.lookback ?? 'Last 60 Days', exclude: c.exclude ?? 'Last 3 Days' })))
        const a = (Array.isArray(rule.actions) ? rule.actions[0] : null) ?? {}
        setControl(a.control === 'automate' ? 'automate' : 'manual')
        setDedupe(a.dedupe !== false)
        if (typeof a.protectConverting === 'boolean') setProtectConverting(a.protectConverting)
        if (a.protectDays != null) setProtectDays(String(a.protectDays))
        if (a.negationLevel) setNegationLevel(a.negationLevel)
        if (Array.isArray(a.searchTerms)) setSearchTerms(a.searchTerms)
        const s = a.schedule ?? {}
        if (s.frequency) setFrequency(s.frequency)
        if (s.everyN != null) setEveryN(String(s.everyN))
        if (s.interval) setInterval(s.interval)
        if (s.onDay) setOnDay(s.onDay)
        if (s.time) setTime(s.time)
        if (s.timezone) setTimezone(s.timezone)
        const maps = Array.isArray(a.mappings) ? a.mappings : []
        if (maps.length) setBlocks(maps.map((m: { groups?: Array<Partial<SelGroup>> }) => ({ id: ++_bid, groups: (Array.isArray(m.groups) ? m.groups : []).map((g) => ({ id: String(g.id), name: g.name ?? String(g.id), campaignId: g.campaignId ?? '', campaignName: g.campaignName ?? null, status: g.status ?? 'ENABLED', campaignStatus: null, adProduct: g.adProduct ?? null, portfolioId: g.portfolioId ?? null, look: g.look !== false, types: g.types ?? { P: true, E: true, product: false } })) })))
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [ruleId, slug])

  return (
    <div className="h10-rb">
      {/* top bar */}
      <header className="h10-rb-top">
        <div className="l">
          <button type="button" className="x" aria-label="Close" onClick={close}><X size={19} /></button>
          <AtomMark size={20} />
          <b>{isEdit ? 'Edit' : 'Create'} Rule - {rt?.label ?? 'Rule'}</b>
        </div>
        <div className="r">
          <button type="button" className="learn"><Video size={15} /> Learn</button>
          <button type="button" className="learn" onClick={runPreview}><Eye size={15} /> Preview</button>
          <button type="button" className="h10-rb-create" disabled={!valid || creating} onClick={submit}>{creating ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : 'Create Rule')}</button>
        </div>
      </header>

      <div className="h10-rb-body" ref={scrollRef}>
        {/* sticky left step nav */}
        <nav className="h10-rb-nav" role="tablist" aria-label="Rule steps">
          {steps.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={active === s.id} className={`h10-rb-step ${active === s.id ? 'on' : ''}`} onClick={() => goto(s.id)}>{s.label}</button>
          ))}
        </nav>

        {/* scrolling content */}
        <main className="h10-rb-main">
          <div className="h10-rb-wrap">
            {/* ── Rule Name ── */}
            <section id="rb-rule-name" className="h10-rb-sec">
              <h2>Rule Name</h2>
              <input className="h10-rb-input rn" value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="Enter a rule name" aria-label="Rule name" />
            </section>

            {/* ── Negative Rule Setup ── */}
            <section id="rb-setup" className="h10-rb-sec">
              <div className="h10-rb-setuphd">
                <h2>{steps[1].label}</h2>
                {setup.mapping && <div className="maprow">
                  <button type="button" className="h10-rb-btn primary" onClick={addBlock}><Plus size={14} /> Ad Group Mapping</button>
                  <button type="button" className="chevbtn" aria-label={setupCollapsed ? 'Expand' : 'Collapse'} aria-expanded={!setupCollapsed} onClick={() => setSetupCollapsed((v) => !v)}><ChevronDown size={18} className={`chev ${setupCollapsed ? 'up' : ''}`} /></button>
                </div>}
              </div>
              <p className="h10-rb-desc">{setup.desc}</p>
              {setup.banner && <div className="h10-rb-banner"><Info size={16} /><span>{setup.banner}</span></div>}

              {!setupCollapsed && blocks.map((block, bi) => (
                <MappingBlock
                  key={block.id}
                  block={block}
                  setup={setup}
                  index={bi}
                  isMulti={blocks.length > 1}
                  popOpen={openPop === block.id}
                  onTogglePop={() => setOpenPop((cur) => (cur === block.id ? null : block.id))}
                  onClosePop={() => setOpenPop(null)}
                  onAdd={(items) => addGroups(block.id, items)}
                  onRemoveGroup={(id) => removeGroup(block.id, id)}
                  onToggleLook={(id) => toggleLook(block.id, id)}
                  onToggleType={(id, t) => toggleType(block.id, id, t)}
                  onRemoveBlock={() => removeBlock(block.id)}
                />
              ))}
            </section>

            {/* ── Criteria ── */}
            <section id="rb-criteria" className="h10-rb-sec">
              <h2>Criteria</h2>
              <p className="h10-rb-desc">Set up the performance criteria and actions</p>

              {groups.map((g, gi) => (
                <div className="h10-rb-card crit" key={g.id}>
                  <div className="h10-rb-card-h">
                    <b>Criteria {gi + 1}</b>
                    <span className="acts">
                      <button type="button" aria-label="Duplicate criteria" onClick={() => dupGroup(g.id)}><Copy size={15} /></button>
                      <button type="button" aria-label="Delete criteria" onClick={() => delGroup(g.id)}><Trash2 size={15} /></button>
                    </span>
                  </div>
                  <div className="h10-rb-conds">
                    {g.conditions.map((c, i) => (
                      <div className="cond" key={i}>
                        <span className={`pill ${i === 0 ? 'if' : 'and'}`}>{i === 0 ? 'IF' : 'AND'}</span>
                        <H10Select width={300} options={METRICS} value={c.metric} onChange={(v) => setCond(g.id, i, { metric: v })} ariaLabel="Metric" />
                        <H10Select width={300} options={OPERATORS} value={c.op} onChange={(v) => setCond(g.id, i, { op: v })} ariaLabel="Operator" />
                        {(() => { const u = METRIC_UNIT[c.metric] ?? ''; return (
                          <span className={`h10-rb-val ${u === 'pct' ? 'hassf' : ''}`}>
                            {u === 'eur' && <span className="pf">€</span>}
                            <input inputMode="decimal" value={c.value} onChange={(e) => setCond(g.id, i, { value: e.target.value })} aria-label="Value" />
                            {u === 'pct' && <span className="sf">%</span>}
                          </span>
                        ) })()}
                        <button type="button" className="rm" aria-label="Remove condition" onClick={() => removeCondition(g.id, i)}><X size={16} /></button>
                      </div>
                    ))}
                    <button type="button" className="h10-rb-addand" onClick={() => addCondition(g.id)}><Plus size={13} /> AND</button>
                  </div>
                  <div className="h10-rb-lookback">
                    <label>Lookback period <i>*</i></label>
                    <div className="lbrow">
                      <H10Select width={220} options={LOOKBACK} value={g.lookback} onChange={(v) => setLookback(g.id, v)} ariaLabel="Lookback period" />
                      <span className="exc">Exclude</span>
                      <H10Select width={180} options={EXCLUDE} value={g.exclude} onChange={(v) => setExclude(g.id, v)} ariaLabel="Exclude period" />
                    </div>
                  </div>
                </div>
              ))}
              <button type="button" className="h10-rb-btn primary addcrit" onClick={addGroup}><Plus size={14} /> Criteria</button>
            </section>

            {/* ── Search Terms ── */}
            <section id="rb-search-terms" className="h10-rb-sec">
              <h2>Search Terms</h2>
              <p className="h10-rb-desc">Isolate specific search terms using the &ldquo;contains&rdquo; or &ldquo;does not contain&rdquo; operator.</p>
              <div className="h10-rb-st">
                <div className="left">
                  <div className="strow">
                    <span className="l">Only suggest if search term:</span>
                    <label className="rad"><input type="radio" name="stmode" checked={searchMode === 'contains'} onChange={() => setSearchMode('contains')} /> Contains</label>
                    <label className="rad"><input type="radio" name="stmode" checked={searchMode === 'not'} onChange={() => setSearchMode('not')} /> Does Not Contain</label>
                  </div>
                  <textarea className="h10-rb-ta" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Enter or paste search terms here" aria-label="Search terms" />
                  <div className="staction"><button type="button" className="h10-rb-btn ghost" disabled={!searchText.trim()} onClick={addSearchTerms}>Add Search Terms</button></div>
                </div>
                <div className="right">
                  <div className="sth"><b>{searchTerms.length} Search Terms Added</b><button type="button" className="h10-rb-btn ghost sm" disabled={!searchTerms.length} onClick={() => setSearchTerms([])}><Trash2 size={13} /> Remove All</button></div>
                  <div className="sttable">
                    <div className="thr"><span>Search Term</span><span>Operator</span></div>
                    {searchTerms.length === 0 ? <div className="nodata">No data</div> : searchTerms.map((st, i) => (
                      <div className="strowdata" key={`${st.op}-${st.term}-${i}`}>
                        <span className="term" title={st.term}>{st.term}</span>
                        <span className="op">{st.op === 'contains' ? 'Contains' : 'Does Not Contain'}</span>
                        <button type="button" className="strm" onClick={() => setSearchTerms((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove ${st.term}`}><X size={14} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="h10-rb-brand">
                <div className="bl"><b>Brand &amp; competitor filters</b><span>{isHarvest ? 'Don’t harvest your own brand terms; optionally only harvest competitor ASINs.' : 'Never negate your own brand terms; optionally only negate competitor ASINs.'}</span></div>
                <textarea className="h10-rb-ta brand" value={brandExclude} onChange={(e) => setBrandExclude(e.target.value)} placeholder={isHarvest ? 'Brand terms to never harvest (one per line or comma-separated)' : 'Brand terms to never negate (one per line or comma-separated)'} aria-label="Brand terms to protect" />
                <label className="h10-rb-compt"><button type="button" className={`h10-bktoggle ${competitorOnly ? 'on' : ''}`} role="switch" aria-checked={competitorOnly} aria-label="Only competitor ASINs" onClick={() => setCompetitorOnly((v) => !v)}><span /></button> Only {isHarvest ? 'harvest' : 'negate'} competitor ASINs (exclude same-brand search terms)</label>
              </div>
            </section>

            {/* ── Advanced Settings ── */}
            <section id="rb-advanced" className="h10-rb-sec">
              <h2>Advanced Settings</h2>
              <div className="h10-rb-card adv">
                <div className="advblock">
                  <b>Frequency</b>
                  <p>Set how often the rule should check the criteria</p>
                  <div className="freqrow">
                    <H10Select width={150} options={FREQUENCY} value={frequency} onChange={setFrequency} ariaLabel="Frequency" />
                    {frequency === 'Custom' && (<>
                      <span className="lbl">Every</span>
                      <input className="h10-rb-num" inputMode="numeric" placeholder="Please enter" value={everyN} onChange={(e) => setEveryN(e.target.value)} aria-label="Every (number)" />
                      <H10Select width={130} options={INTERVAL} value={interval} onChange={setInterval} ariaLabel="Interval" />
                      {interval === 'Weeks' && (<>
                        <span className="lbl">on</span>
                        <H10Select width={150} options={DAYS} value={onDay} onChange={setOnDay} ariaLabel="Day of week" />
                      </>)}
                    </>)}
                    <span className="at">at</span>
                    <H10Select width={200} options={TIMES} value={time} onChange={setTime} ariaLabel="Time" />
                  </div>
                </div>
                <div className="advblock">
                  <b>Timezone</b>
                  <p>Select the timezone for this rule</p>
                  <H10Select width={430} options={TIMEZONES} value={timezone} onChange={setTimezone} ariaLabel="Timezone" />
                </div>
                {!isHarvest && (
                <div className="advblock">
                  <b>Negation Level</b>
                  <p>Where to place the negative keyword / product target when this rule fires</p>
                  <H10Select width={280} options={[{ value: 'adgroup', label: 'Ad Group' }, { value: 'campaign', label: 'Campaign' }, { value: 'both', label: 'Ad Group + Campaign' }]} value={negationLevel} onChange={(v) => setNegationLevel(v as 'adgroup' | 'campaign' | 'both')} ariaLabel="Negation level" />
                </div>
                )}
                {isHarvest && (
                <div className="advblock">
                  <b>New Target Bid</b>
                  <p>Starting bid for the keywords / product targets this rule creates</p>
                  <div className="freqrow">
                    <H10Select width={180} options={[{ value: 'suggested', label: 'Suggested bid' }, { value: 'fixed', label: 'Fixed bid' }]} value={bidMode} onChange={(v) => setBidMode(v as 'suggested' | 'fixed')} ariaLabel="New target bid mode" />
                    {bidMode === 'fixed' && <span className="h10-rb-val bidv"><span className="pf">€</span><input inputMode="decimal" placeholder="0.75" value={bidValue} onChange={(e) => setBidValue(e.target.value)} aria-label="Fixed bid amount" /></span>}
                  </div>
                </div>
                )}
              </div>
            </section>

            {/* ── Control ── */}
            <section id="rb-control" className="h10-rb-sec">
              <h2>Control</h2>
              <p className="h10-rb-desc">Determine the level of control over the actions of this rule</p>
              <div className="h10-rb-card control">
                <div className="h10-rb-dedupe">
                  <button type="button" className={`h10-bktoggle ${dedupe ? 'on' : ''}`} role="switch" aria-checked={dedupe} aria-label="Do not suggest existing search terms" onClick={() => setDedupe((v) => !v)}><span /></button>
                  <span>Select to NOT suggest any search terms that already exist with the same match type in the campaigns from this rule group</span>
                </div>
                {!isHarvest && (
                <div className="h10-rb-dedupe">
                  <button type="button" className={`h10-bktoggle ${protectConverting ? 'on' : ''}`} role="switch" aria-checked={protectConverting} aria-label="Protect converting search terms" onClick={() => setProtectConverting((v) => !v)}><span /></button>
                  <span>Never create a negative for a term that <b>converted</b> (≥1 order) in the last <input className="h10-rb-ninline" inputMode="numeric" value={protectDays} onChange={(e) => setProtectDays(e.target.value)} aria-label="Protection window in days" /> days in any campaign — protects proven keywords from being blocked.</span>
                </div>
                )}
                {isHarvest && (
                <div className="h10-rb-dedupe">
                  <button type="button" className={`h10-bktoggle ${negateInSource ? 'on' : ''}`} role="switch" aria-checked={negateInSource} aria-label="Negate harvested terms in source" onClick={() => setNegateInSource((v) => !v)}><span /></button>
                  <span>Also add each harvested term as a <b>negative</b> in its source ad group — stops the source (Auto/Broad) campaign from competing with the new target.</span>
                </div>
                )}
                <label className={`h10-rb-ctrl ${control === 'manual' ? 'on' : ''}`}>
                  <input type="radio" name="control" checked={control === 'manual'} onChange={() => setControl('manual')} />
                  <span className="b"><span className="t">Manual</span><span className="d">Manually approve rule actions on the Suggestions page</span></span>
                </label>
                <label className={`h10-rb-ctrl ${control === 'automate' ? 'on' : ''}`}>
                  <input type="radio" name="control" checked={control === 'automate'} onChange={() => setControl('automate')} />
                  <span className="b"><span className="t">Automate</span><span className="d">Automate this rule to have Nexus Ads automatically apply rule actions</span></span>
                </label>
              </div>
            </section>

            {/* footer */}
            <div className="h10-rb-foot">
              <button type="button" className="h10-rb-btn ghost" onClick={close}>Cancel</button>
              <span className="grow" />
              <button type="button" className="h10-rb-create" disabled={!valid || creating} onClick={submit}>{creating ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : 'Create Rule')}</button>
            </div>
          </div>
        </main>
      </div>
      {preview?.open && (
        <div className="h10-rb-prevback" onClick={() => setPreview(null)}>
          <div className="h10-rb-prev" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={isHarvest ? 'Harvest preview' : 'Negative targeting preview'}>
            <div className="ph"><b>{isHarvest ? 'Preview — converting search terms' : 'Preview — wasting search terms'}</b><button type="button" onClick={() => setPreview(null)} aria-label="Close"><X size={18} /></button></div>
            <div className="psub">{isHarvest ? 'Live, read-only: search terms currently meeting your criteria that would be harvested.' : 'Live, read-only: search terms currently meeting your criteria that would be negated.'}</div>
            <div className="pbody">
              {preview.loading ? <div className="pmsg">Loading…</div>
                : preview.terms.length === 0 ? <div className="pmsg">{isHarvest ? 'No converting search terms match the current criteria yet.' : 'No wasting search terms match the current criteria yet.'}</div>
                : isHarvest
                  ? (<div className="ptable"><div className="pthr"><span>Search Term</span><span>Orders</span><span>Spend</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}</span><span>{t.orders ?? '—'}</span><span>{t.spend != null ? `€${t.spend.toFixed(2)}` : '—'}</span></div>))}</div>)
                  : (<div className="ptable"><div className="pthr"><span>Search Term</span><span>Match</span><span>Clicks</span><span>Spend</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}</span><span title={t.matchType}>{matchLabel(t.matchType)}</span><span>{t.clicks ?? '—'}</span><span>{t.spend != null ? `€${t.spend.toFixed(2)}` : '—'}</span></div>))}</div>)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── one source→target mapping block (the H2 two-panel + multi-block chrome). Harvest can have
//    several; Negative has one (isMulti false ⇒ no label / remove). ──
function MappingBlock({ block, setup, index, isMulti, popOpen, onTogglePop, onClosePop, onAdd, onRemoveGroup, onToggleLook, onToggleType, onRemoveBlock }: {
  block: MapBlock; setup: (typeof SETUP)[string]; index: number; isMulti: boolean; popOpen: boolean
  onTogglePop: () => void; onClosePop: () => void; onAdd: (items: AdGroupItem[]) => void
  onRemoveGroup: (id: string) => void; onToggleLook: (id: string) => void; onToggleType: (id: string, t: 'P' | 'E' | 'product') => void; onRemoveBlock: () => void
}) {
  const groups = block.groups
  return (
    <div className="h10-rb-card setup mapblock">
      <div className="h10-rb-card-h">
        {isMulti && <span className="mblabel">Ad Group Mapping {index + 1}</span>}
        <b>{groups.length} Ad Groups</b>
        <span className="grow" />
        <div className="addwrap">
          <button type="button" className="h10-rb-btn primary" onClick={onTogglePop}><Plus size={14} /> Add Group</button>
          {popOpen && <AddGroupPopover selectedIds={new Set(groups.map((g) => g.id))} onAdd={onAdd} onClose={onClosePop} />}
        </div>
        {isMulti && <button type="button" className="mbrm" onClick={onRemoveBlock} aria-label={`Remove mapping ${index + 1}`}><Trash2 size={16} /></button>}
      </div>
      <div className="h10-rb-twocol">
        <div className="col">
          <div className="colh">What Ad Groups would you like included in this rule?</div>
          <div className="subh"><span>Ad Group</span><span className="muted">Look for Search Terms in These Ad Groups <Info size={13} /></span></div>
          {groups.length === 0 ? (
            <div className="empty"><div className="ill"><MousePointerClick size={26} /></div><div className="t">Add an Ad Group</div><div className="d">Start by adding related ad groups<br />to this rule</div></div>
          ) : (
            <div className="h10-rb-agrows">{groups.map((g) => (
              <div className="agrow" key={g.id}>
                <span className="nm"><b title={g.name}>{g.name}</b>{g.campaignName && <span className="camp" title={g.campaignName}>{g.campaignName}</span>}</span>
                <label className="look"><input type="checkbox" checked={g.look} onChange={() => onToggleLook(g.id)} aria-label={`Look for search terms in ${g.name}`} /></label>
              </div>
            ))}</div>
          )}
        </div>
        <div className="col">
          <div className="colh">What targets would you like created?</div>
          <div className="subh r"><span className="muted">{setup.targetsTitle}</span><span className="mts">{setup.matchTypes.map((m) => (<HoverCard key={m.key} text={m.tip} placement="above"><span className="mt">{m.product ? <Package size={15} /> : m.key}</span></HoverCard>))}</span></div>
          {groups.length === 0 ? (
            <div className="empty"><div className="ill"><Check size={24} /></div><div className="t">Create a New Target</div><div className="d">Select the type of target you want<br />to create with the search term</div></div>
          ) : (
            <div className="h10-rb-agrows">{groups.map((g) => (
              <div className="agrow tgt" key={g.id}>
                <span className="chips">{setup.matchTypes.map((m) => { const k = m.key as 'P' | 'E' | 'product'; return (<HoverCard key={m.key} text={m.tip} placement="above"><button type="button" className={`tchip ${g.types[k] ? 'on' : ''}`} aria-pressed={g.types[k]} onClick={() => onToggleType(g.id, k)}>{m.product ? <Package size={14} /> : m.key}</button></HoverCard>) })}</span>
                <button type="button" className="agrm" onClick={() => onRemoveGroup(g.id)} aria-label={`Remove ${g.name}`}><X size={15} /></button>
              </div>
            ))}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── "Add Ad Group to Rule" popover — real data: 4 tabs (Ad Groups flat · Campaigns grouped ·
//    Portfolios grouped · Products) + Campaign/Ad-Group status filters + search + Add All / +Add. ──
const AG_STATUS = [{ value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }, { value: 'ARCHIVED', label: 'Archived' }, { value: '', label: 'All' }]
const statusPill = (s: string) => <span className={`st ${s === 'ENABLED' ? 'ok' : s === 'PAUSED' ? 'warn' : 'arch'}`}>{s === 'ENABLED' ? 'Enabled' : s === 'PAUSED' ? 'Paused' : 'Archived'}</span>

function AddGroupPopover({ selectedIds, onAdd, onClose }: { selectedIds: Set<string>; onAdd: (items: AdGroupItem[]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [onClose])
  const TABS = ['Ad Groups', 'Campaigns', 'Portfolios', 'Products']
  const [tab, setTab] = useState('Ad Groups')
  const [all, setAll] = useState<AdGroupItem[]>([])
  const [portfolios, setPortfolios] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [campStatus, setCampStatus] = useState('ENABLED')
  const [agStatus, setAgStatus] = useState('ENABLED')
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [a, p] = await Promise.all([
          fetch(`${getBackendUrl()}/api/advertising/ad-groups?limit=3000`).then((r) => r.json()).catch(() => ({ items: [] })),
          fetch(`${getBackendUrl()}/api/advertising/portfolios`).then((r) => r.json()).catch(() => ({ items: [] })),
        ])
        if (!alive) return
        setAll((a.items ?? []) as AdGroupItem[])
        const praw = (a && (p.items ?? p) || []) as Array<{ id: string | number; name?: string }>
        setPortfolios((Array.isArray(praw) ? praw : []).map((x) => ({ id: String(x.id), name: String(x.name ?? x.id) })))
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])
  const ql = q.trim().toLowerCase()
  const filtered = all.filter((g) =>
    (!campStatus || g.campaignStatus === campStatus) && (!agStatus || g.status === agStatus) &&
    (!ql || g.name.toLowerCase().includes(ql) || (g.campaignName ?? '').toLowerCase().includes(ql)))
  const fresh = (items: AdGroupItem[]) => items.filter((g) => !selectedIds.has(g.id))
  const renderRow = (g: AdGroupItem) => {
    const added = selectedIds.has(g.id)
    return (
      <div className="row" key={g.id}>
        <input type="checkbox" checked={added} onChange={() => onAdd([g])} aria-label={`Add ${g.name}`} disabled={added} />
        <span className="nm" title={g.name}>{g.name}</span>
        {statusPill(g.status)}
        <button type="button" className="add" disabled={added} onClick={() => onAdd([g])}>{added ? <><Check size={12} /> Added</> : <><Plus size={12} /> Add</>}</button>
      </div>
    )
  }
  const byKey = (keyOf: (g: AdGroupItem) => string, nameOf: (g: AdGroupItem) => string) => {
    const m = new Map<string, { name: string; items: AdGroupItem[] }>()
    for (const g of filtered) { const k = keyOf(g); if (!m.has(k)) m.set(k, { name: nameOf(g), items: [] }); m.get(k)!.items.push(g) }
    return [...m.values()]
  }
  const groups = tab === 'Campaigns' ? byKey((g) => g.campaignId, (g) => g.campaignName ?? '—')
    : tab === 'Portfolios' ? byKey((g) => g.portfolioId ?? '__none', (g) => (g.portfolioId ? (portfolios.find((p) => p.id === g.portfolioId)?.name ?? g.portfolioId) : 'No Portfolio'))
    : null
  return (
    <div className="h10-rb-agpop" ref={ref} role="dialog" aria-label="Add Ad Group to Rule">
      <div className="t">Add Ad Group to Rule</div>
      <div className="srch"><Search size={14} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search ad groups" /></div>
      <div className="tabs">{TABS.map((t) => <button key={t} type="button" className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
      <div className="filters">
        <div className="f"><label>Campaign Status</label><H10Select width={150} options={AG_STATUS} value={campStatus} onChange={setCampStatus} ariaLabel="Campaign status" /></div>
        <div className="f"><label>Ad Groups Status</label><H10Select width={150} options={AG_STATUS} value={agStatus} onChange={setAgStatus} ariaLabel="Ad groups status" /></div>
        <button type="button" className="addall" disabled={tab === 'Products' || !fresh(filtered).length} onClick={() => onAdd(fresh(filtered))}>Add All</button>
      </div>
      <div className="list">
        {loading ? <div className="agpop-msg">Loading…</div>
          : tab === 'Products' ? <div className="agpop-msg">Scope by product is coming soon — use Ad&nbsp;Groups, Campaigns, or Portfolios.</div>
          : filtered.length === 0 ? <div className="agpop-msg">No ad groups match.</div>
          : groups ? groups.map((grp, i) => (
              <div className="grp" key={i}>
                <div className="grph"><span className="gn" title={grp.name}>{grp.name}</span><button type="button" className="add" disabled={!fresh(grp.items).length} onClick={() => onAdd(fresh(grp.items))}><Plus size={12} /> Add</button></div>
                {grp.items.map((g) => renderRow(g))}
              </div>
            ))
          : filtered.map((g) => renderRow(g))}
      </div>
    </div>
  )
}
