'use client'

/**
 * AX3.2 — pick what to replicate, at whatever grain the structure lives at.
 *
 * A three-level tree — portfolio → campaign → ad group — because a portfolio is
 * not where the good material necessarily is: 128 of 190 live campaigns belong
 * to no portfolio at all, including every product-targeting structure in the
 * account. Those appear under a "No portfolio" group rather than being
 * unreachable.
 *
 * Selection is held at the FINEST grain (a set of ad-group ids) and the coarser
 * rows derive their checked/indeterminate state from it, so "tick the portfolio"
 * and "tick each of its ad groups" cannot disagree. Ticking an ad group
 * replicates its parent campaign shell carrying only that ad group — Amazon has
 * no ad group without a campaign.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Search, Layers, Loader2 } from 'lucide-react'
import { searchOptions } from '@/lib/option-search'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, Checkbox, Input, ToolbarButton } from '@/design-system/primitives'
import '../builder-ds.css'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'

export interface SrcAdGroup { id: string; name: string; positives: number; negatives: number; productAds: number }
export interface SrcCampaign {
  id: string; name: string; marketplace: string | null; targetingType: string | null
  dailyBudget: number | null; adProduct: string | null
  positives: number; negatives: number; productAds: number
  adGroups: SrcAdGroup[]
}
export interface SrcPortfolio { portfolioId: string | null; name: string; campaigns: SrcCampaign[]; dailyBudgetTotal: number }

/** What the wizard needs downstream: the selector, plus what it adds up to. */
export interface SourceSelection {
  campaignIds: string[]
  adGroupIds: string[]
  campaigns: number
  adGroups: number
  positives: number
  negatives: number
  productAds: number
  dailyBudgetTotal: number
  /** True when every selected campaign has ALL of its ad groups selected. */
  whole: boolean
  /** Names, for the naming step's old → new preview. */
  campaignNames: string[]
}

export const emptySelection = (): SourceSelection => ({
  campaignIds: [], adGroupIds: [], campaigns: 0, adGroups: 0,
  positives: 0, negatives: 0, productAds: 0, dailyBudgetTotal: 0, whole: true, campaignNames: [],
})

const money = (n: number) => `€${n.toFixed(2)}`

/** A checkbox that can also render the "some but not all" state. */
function TriBox({ checked, indeterminate, onChange, label }: {
  checked: boolean; indeterminate: boolean; onChange: () => void; label: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = !checked && indeterminate }, [checked, indeterminate])
  return <Checkbox ref={ref} checked={checked} onChange={onChange} aria-label={label} />
}

/** A structure someone saved earlier, so it can be replicated again. */
interface SavedBlueprint {
  id: string; name: string; marketplace: string; productToken: string
  sourceCampaignIds: string[]
  stats: { campaigns: number; adGroups: number; positives: number; negatives: number } | null
}

export function SourcePicker({ market, selected, setSelected, onChange, onPickBlueprint, reselect }: {
  market: string
  selected: Set<string>
  setSelected: (next: Set<string>) => void
  onChange: (s: SourceSelection) => void
  /** Told which product token the saved structure was captured from. */
  onPickBlueprint?: (productToken: string) => void
  /**
   * AX3.6 — "replicate this again", by campaign id. Only this component knows
   * which ad groups those campaigns own, so the caller names the campaigns and
   * the resolution happens here once the tree is loaded.
   */
  reselect?: { campaignIds: string[]; nonce: number } | null
}) {
  const [tree, setTree] = useState<SrcPortfolio[]>([])
  const [saved, setSaved] = useState<SavedBlueprint[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [openPf, setOpenPf] = useState<Set<string>>(new Set())
  const [openC, setOpenC] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    setLoading(true); setErr(null)
    fetch(`${getBackendUrl()}/api/advertising/blueprints/sources?marketplace=${market}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        if (j?.error) { setErr(j.error); setTree([]) }
        else {
          const items = (j?.portfolios ?? []) as SrcPortfolio[]
          setTree(items)
          // Open the largest real portfolio so the page is never a wall of collapsed rows.
          const first = items.find((p) => p.portfolioId)
          if (first) setOpenPf(new Set([first.portfolioId!]))
        }
        setLoading(false)
      })
      .catch((e) => { if (alive) { setErr((e as Error).message); setLoading(false) } })
    return () => { alive = false }
  }, [market])

  // Saved structures. These used to have their own page in the nav rail; the
  // library lives here now, so a blueprint saved a month ago is still one click
  // from being replicated rather than stranded.
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/blueprints`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (alive) setSaved(((j?.items ?? []) as SavedBlueprint[]).filter((b) => b.marketplace === market)) })
      .catch(() => {})
    return () => { alive = false }
  }, [market])

  // ── filter ──────────────────────────────────────────────────────────────
  // OS.5 — shared ranked matcher instead of a raw substring test, so "gale broad" finds
  // "GALE | IT | Broad | Brand". Each campaign is matched against "<portfolio> <campaign>" so a
  // query can name either or both ("xavia broad") and a portfolio-only query still keeps its whole
  // subtree — the previous OR-test lost that as soon as the query mixed the two.
  const view = useMemo(() => {
    if (!q.trim()) return tree
    return tree
      .map((p) => {
        const kept = searchOptions(q, p.campaigns, (c) => `${p.name} ${c.name}`)
        return { ...p, campaigns: kept }
      })
      .filter((p) => p.campaigns.length > 0)
  }, [tree, q])

  // ── selection maths ─────────────────────────────────────────────────────
  const allCampaigns = useMemo(() => tree.flatMap((p) => p.campaigns), [tree])
  const agOf = useMemo(() => {
    const m = new Map<string, SrcCampaign>()
    for (const c of allCampaigns) for (const g of c.adGroups) m.set(g.id, c)
    return m
  }, [allCampaigns])

  const selOfCampaign = useCallback((c: SrcCampaign) => c.adGroups.filter((g) => selected.has(g.id)).length, [selected])

  // Resolve a "replicate again" request against the loaded tree. Keyed by nonce
  // so asking for the same set twice still re-selects it.
  const lastReselect = useRef(0)
  useEffect(() => {
    if (!reselect || !tree.length || lastReselect.current === reselect.nonce) return
    lastReselect.current = reselect.nonce
    const want = new Set(reselect.campaignIds)
    const ags = allCampaigns.filter((c) => want.has(c.id)).flatMap((c) => c.adGroups.map((g) => g.id))
    setSelected(new Set(ags))
    // Open the groups holding them, so the selection is visible rather than implied.
    setOpenPf(new Set(tree.filter((p) => p.campaigns.some((c) => want.has(c.id))).map((p) => p.portfolioId ?? '__none__')))
  }, [reselect, tree, allCampaigns, setSelected])

  const toggleAdGroup = (id: string) => {
    const n = new Set(selected)
    if (n.has(id)) n.delete(id); else n.add(id)
    setSelected(n)
  }
  const toggleCampaign = (c: SrcCampaign) => {
    const n = new Set(selected)
    const all = c.adGroups.length > 0 && selOfCampaign(c) === c.adGroups.length
    for (const g of c.adGroups) { if (all) n.delete(g.id); else n.add(g.id) }
    setSelected(n)
  }
  const togglePortfolio = (p: SrcPortfolio) => {
    const ids = p.campaigns.flatMap((c) => c.adGroups.map((g) => g.id))
    const all = ids.length > 0 && ids.every((id) => selected.has(id))
    const n = new Set(selected)
    for (const id of ids) { if (all) n.delete(id); else n.add(id) }
    setSelected(n)
  }

  // ── report the selection upward ─────────────────────────────────────────
  useEffect(() => {
    const touched = new Map<string, SrcCampaign>()
    for (const id of selected) { const c = agOf.get(id); if (c) touched.set(c.id, c) }
    const camps = [...touched.values()]
    let positives = 0, negatives = 0, productAds = 0, adGroups = 0, whole = true
    for (const c of camps) {
      const picked = c.adGroups.filter((g) => selected.has(g.id))
      if (picked.length !== c.adGroups.length) whole = false
      adGroups += picked.length
      for (const g of picked) { positives += g.positives; negatives += g.negatives; productAds += g.productAds }
    }
    onChange({
      campaignIds: camps.map((c) => c.id),
      adGroupIds: [...selected].filter((id) => agOf.has(id)),
      campaigns: camps.length, adGroups, positives, negatives, productAds,
      dailyBudgetTotal: camps.reduce((n, c) => n + (c.dailyBudget ?? 0), 0),
      whole, campaignNames: camps.map((c) => c.name),
    })
  }, [selected, agOf, onChange])

  const openSet = (s: Set<string>, id: string) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n }

  if (loading) return <div className="h10-rep-src loading"><Loader2 size={16} className="spin" aria-hidden /> Reading your account…</div>
  if (err) return <div className="h10-rep-src err">Couldn’t load your campaigns: {err}</div>

  return (
    <div className="h10-rep-src">
      <div className="h10-rep-src-top">
        <Input
          fieldClassName="rep-search"
          leadingIcon={<Search size={15} />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by campaign or portfolio name"
          aria-label="Filter sources"
        />
        {selected.size > 0 && (
          <Button variant="link" size="sm" onClick={() => setSelected(new Set())}>Clear selection</Button>
        )}
      </div>

      {saved.length > 0 && (
        <div className="h10-rep-saved">
          <span className="lbl">Saved structures</span>
          {saved.map((b) => {
            const ids = new Set(b.sourceCampaignIds)
            const ags = allCampaigns.filter((c) => ids.has(c.id)).flatMap((c) => c.adGroups.map((g) => g.id))
            const gone = b.sourceCampaignIds.length > 0 && ags.length === 0
            return (
              <button
                key={b.id}
                type="button"
                className="chip"
                disabled={gone}
                title={gone ? 'The campaigns this was captured from are no longer active' : `Select the ${b.sourceCampaignIds.length} campaigns this was captured from`}
                onClick={() => { setSelected(new Set(ags)); onPickBlueprint?.(b.productToken) }}
              >
                <b>{b.name}</b>
                <span className="m">
                  {gone ? 'source campaigns no longer active' : `${b.stats?.campaigns ?? b.sourceCampaignIds.length} campaigns · from ${b.productToken}`}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="h10-rep-tree" role="tree">
        {view.length === 0 && <div className="h10-rep-empty">Nothing matches “{q}”.</div>}
        {view.map((p) => {
          const key = p.portfolioId ?? '__none__'
          const ids = p.campaigns.flatMap((c) => c.adGroups.map((g) => g.id))
          const picked = ids.filter((id) => selected.has(id)).length
          const open = openPf.has(key) || !!q
          const pos = p.campaigns.reduce((n, c) => n + c.positives, 0)
          const ags = p.campaigns.reduce((n, c) => n + c.adGroups.length, 0)
          return (
            <div className="h10-rep-pf" key={key}>
              <div className={`h10-rep-row pf ${picked > 0 ? 'on' : ''}`}>
                <ToolbarButton
                  size="sm" tooltip={false} aria-expanded={open}
                  icon={open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  label={open ? 'Collapse' : 'Expand'}
                  onClick={() => setOpenPf((s) => openSet(s, key))}
                />
                <TriBox checked={ids.length > 0 && picked === ids.length} indeterminate={picked > 0} onChange={() => togglePortfolio(p)} label={`Select all of ${p.name}`} />
                <span className="nm">
                  {p.name}
                  {!p.portfolioId && <span className="tag" title="These campaigns are not in any Amazon portfolio. They are still replicable.">unassigned</span>}
                </span>
                <span className="meta">{p.campaigns.length} campaigns · {ags} ad groups · {pos} targets · {money(p.dailyBudgetTotal)}/day</span>
              </div>

              {open && p.campaigns.map((c) => {
                const cSel = selOfCampaign(c)
                const cOpen = openC.has(c.id)
                const cAll = c.adGroups.length > 0 && cSel === c.adGroups.length
                return (
                  <div key={c.id}>
                    <div className={`h10-rep-row cmp ${cSel > 0 ? 'on' : ''}`}>
                      <ToolbarButton
                        size="sm" tooltip={false} aria-expanded={cOpen}
                        icon={cOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        label={cOpen ? 'Collapse ad groups' : 'Expand ad groups'}
                        onClick={() => setOpenC((s) => openSet(s, c.id))}
                      />
                      <TriBox checked={cAll} indeterminate={cSel > 0} onChange={() => toggleCampaign(c)} label={`Select ${c.name}`} />
                      <span className="nm">
                        {c.name}
                        {c.targetingType === 'AUTO' && <span className="tag auto" title="An Amazon auto-targeting campaign">auto</span>}
                      </span>
                      <span className="meta">
                        {cSel > 0 && cSel < c.adGroups.length ? <b className="part">{cSel}/{c.adGroups.length} ad groups · </b> : null}
                        {c.positives} targets · {c.negatives} negatives · {c.productAds} ads · {money(c.dailyBudget ?? 0)}/day
                      </span>
                    </div>
                    {cOpen && c.adGroups.map((g) => (
                      <div className={`h10-rep-row ag ${selected.has(g.id) ? 'on' : ''}`} key={g.id}>
                        <span className="exp-sp" />
                        <TriBox checked={selected.has(g.id)} indeterminate={false} onChange={() => toggleAdGroup(g.id)} label={`Select ad group ${g.name}`} />
                        <span className="nm"><Layers size={12} aria-hidden /> {g.name}</span>
                        <span className="meta">{g.positives} targets · {g.negatives} negatives · {g.productAds} ads</span>
                      </div>
                    ))}
                    {cOpen && c.adGroups.length === 0 && (
                      <div className="h10-rep-row ag empty"><span className="exp-sp" /><span className="nm">No ad groups — nothing to replicate from this campaign.</span></div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
