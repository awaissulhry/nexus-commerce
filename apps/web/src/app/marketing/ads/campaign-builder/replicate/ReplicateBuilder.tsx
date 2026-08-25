'use client'

/**
 * AX3.2/AX3.3 — Replicate Structure, the sixth campaign-builder type.
 *
 * Replication used to live at /marketing/ads/blueprints, in the nav rail, away
 * from every other way of creating a campaign. It belongs here: it IS a way of
 * creating campaigns, and it shares this wizard's chrome, its product picker and
 * its portfolio picker.
 *
 * Same three-step shape as the SP Super Wizard — pick what you are copying and
 * what you are copying it onto, review and edit it, then check and launch. The
 * self-competition gate is unchanged and still blocking: this surface only
 * changes where the decisions are made, never whether they are made.
 *
 * The plan is always the SERVER's. Step 1 re-plans (debounced) on every change
 * so the totals, blockers and conflicts on screen are the ones the launch will
 * enforce, never a client-side approximation of them.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Info, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button, SegmentedControl } from '@/design-system/primitives'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import { getBackendUrl } from '@/lib/backend-url'
import { ProductSelection, type SpwProduct } from '../sp-super-wizard/ProductSelection'
import { SourcePicker, emptySelection, type SourceSelection } from './SourcePicker'
import { NamingPanel } from './NamingPanel'
import { CopyScopePanel } from './CopyScopePanel'
import { DestinationPanel } from './DestinationPanel'
import { ReviewStep } from './ReviewStep'
import { LaunchStep, type LaunchResult, type Resolution, type RunProgress } from './LaunchStep'
import { HistoryPanel, DriftCheck } from './HistoryPanel'
import {
  fullCopyScope, emptyNaming, copyPolicy, guessProductToken, verdictOf,
  type CopyScope, type NamingRules, type ValuePolicy, type PlanPreviewResponse, type PlanEdits,
} from './replicate-types'

type StepN = 1 | 2 | 3
const STEPS: Array<{ n: StepN; label: string }> = [
  { n: 1, label: 'Source & Products' },
  { n: 2, label: 'Review & Edit' },
  { n: 3, label: 'Preflight & Launch' },
]

const S1_SECTIONS = [
  { id: 'source', label: 'Source structure' },
  { id: 'copy', label: 'What to copy' },
  { id: 'naming', label: 'Naming' },
  { id: 'products', label: 'Product Selection' },
  { id: 'destination', label: 'Destination' },
  { id: 'history', label: 'Past runs' },
]

const MARKETS = ['IT', 'DE', 'FR', 'ES']
const EXIT_TO = '/marketing/ads/campaign-builder'

export function ReplicateBuilder() {
  const router = useRouter()
  const params = useSearchParams()
  const [step, setStep] = useState<StepN>(1)
  const [activeSec, setActiveSec] = useState('source')

  // ── source ────────────────────────────────────────────────────────────
  const [sourceMarket, setSourceMarket] = useState('IT')
  const [selectedAdGroups, setSelectedAdGroups] = useState<Set<string>>(new Set())
  const [source, setSource] = useState<SourceSelection>(emptySelection())
  const [reselect, setReselect] = useState<{ campaignIds: string[]; nonce: number } | null>(null)

  // ── transform ─────────────────────────────────────────────────────────
  const [scope, setScope] = useState<CopyScope>(fullCopyScope())
  const [sourceToken, setSourceToken] = useState('')
  const [targetToken, setTargetToken] = useState('')
  const [naming, setNaming] = useState<NamingRules>(emptyNaming())
  const [products, setProducts] = useState<SpwProduct[]>([])

  // ── destination ───────────────────────────────────────────────────────
  const [market, setMarket] = useState('IT')
  const [portfolioId, setPortfolioId] = useState('')
  const [cap, setCap] = useState('')
  const [bidPolicy, setBidPolicy] = useState<ValuePolicy>(copyPolicy())
  const [budgetPolicy, setBudgetPolicy] = useState<ValuePolicy>(copyPolicy())

  // ── review-step edits ─────────────────────────────────────────────────
  const [edits, setEdits] = useState<PlanEdits>({})
  const [conflictDecisions, setConflictDecisions] = useState<Record<string, 'skip' | 'accept'>>({})

  // ── launch ────────────────────────────────────────────────────────────
  const [launchMode, setLaunchMode] = useState<'live' | 'floor'>('floor')
  const [launching, setLaunching] = useState(false)
  const [launchErr, setLaunchErr] = useState<string | null>(null)
  const [result, setResult] = useState<LaunchResult | null>(null)
  const [progress, setProgress] = useState<RunProgress | null>(null)
  const [busy, setBusy] = useState(false)

  // ── the server's plan ─────────────────────────────────────────────────
  const [preview, setPreview] = useState<PlanPreviewResponse | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planErr, setPlanErr] = useState<string | null>(null)
  const [liveNames, setLiveNames] = useState<Set<string>>(new Set())
  const [portfolioNames, setPortfolioNames] = useState<Map<string, string>>(new Map())

  /**
   * AX3.7 — where step 3 sends you when it says something is blocking.
   * `nonce` so clicking the same resolver twice still moves the screen.
   */
  const [focus, setFocus] = useState<{ filter?: 'conflicts'; campaignId?: string; nonce: number } | null>(null)
  const onResolve = useCallback((r: NonNullable<Resolution>) => {
    if (r.kind === 'products') { setStep(1); setActiveSec('products'); setTimeout(() => gotoSec('products'), 0); return }
    if (r.kind === 'cap') return // resolved in place, on step 3
    setStep(2)
    setFocus({ nonce: Date.now(), ...(r.kind === 'conflicts' ? { filter: 'conflicts' as const } : {}), ...(r.kind === 'campaign' && r.campaignId ? { campaignId: r.campaignId } : {}) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Changing the source market invalidates a selection made against another tree.
  useEffect(() => { setSelectedAdGroups(new Set()) }, [sourceMarket])

  /**
   * AX3.6 — arrive with a source already chosen:
   *   /campaign-builder/replicate?campaigns=<id>,<id>&market=IT
   *
   * Makes a replication linkable — from a future Ad Manager action, from a
   * bookmark, or from a message to a colleague — without the builder needing to
   * know who sent them. Runs once, on mount, so it never fights the operator's
   * own clicks afterwards.
   */
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current) return
    const ids = (params?.get('campaigns') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const mk = params?.get('market')
    if (mk && MARKETS.includes(mk)) { setSourceMarket(mk); setMarket(mk) }
    if (ids.length) setReselect({ campaignIds: ids, nonce: 1 })
    if (ids.length || mk) deepLinked.current = true
  }, [params])

  const onSource = useCallback((s: SourceSelection) => setSource(s), [])

  // Guess the product token from the names the operator just picked.
  const guessed = useMemo(() => guessProductToken(source.campaignNames), [source.campaignNames])
  const guessAppliedFor = useRef('')
  useEffect(() => {
    const key = source.campaignNames.join('|')
    if (guessed && guessAppliedFor.current !== key) { guessAppliedFor.current = key; setSourceToken(guessed) }
  }, [guessed, source.campaignNames])

  // Live campaign names in the destination, for the rename preview's collision flag.
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/blueprints/sources?marketplace=${market}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        const pfs = (j?.portfolios ?? []) as Array<{ portfolioId: string | null; name: string; campaigns: Array<{ name: string }> }>
        setLiveNames(new Set(pfs.flatMap((p) => p.campaigns.map((c) => c.name.toLowerCase()))))
        setPortfolioNames(new Map(pfs.filter((p) => p.portfolioId).map((p) => [p.portfolioId!, p.name])))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [market])

  const asins = useMemo(() => products.map((p) => p.asin || p.sku).filter(Boolean), [products])

  // Node ids are positional in the source doc, so a different SOURCE invalidates
  // every edit. Clearing them here is kinder than letting the server reject the
  // whole set as stale — which it would, correctly.
  const sourceKey = JSON.stringify([source.campaignIds, source.adGroupIds, sourceMarket])
  const lastSourceKey = useRef(sourceKey)
  useEffect(() => {
    if (lastSourceKey.current !== sourceKey) {
      lastSourceKey.current = sourceKey
      setEdits({}); setConflictDecisions({})
    }
  }, [sourceKey])

  // ── re-plan, debounced, whenever anything that shapes the plan changes ──
  const planKey = JSON.stringify({
    ids: source.campaignIds, ags: source.adGroupIds, sourceMarket,
    sourceToken, targetToken, naming, scope, market, cap, bidPolicy, budgetPolicy, asins,
    edits, accepted: Object.entries(conflictDecisions).filter(([, v]) => v === 'accept').map(([k]) => k).sort(),
  })
  useEffect(() => {
    if (!source.campaigns || !sourceToken.trim() || !targetToken.trim()) { setPreview(null); setPlanErr(null); return }
    let alive = true
    setPlanning(true)
    const t = setTimeout(() => {
      const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v))
      fetch(`${getBackendUrl()}/api/advertising/blueprints/plan-preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          source: { campaignIds: source.campaignIds, adGroupIds: source.adGroupIds, marketplace: sourceMarket },
          sourceProductToken: sourceToken.trim(),
          productToken: targetToken.trim(),
          asins,
          marketplace: market,
          dailyBudgetCapEur: num(cap),
          edits,
          acceptSharedTargets: Object.entries(conflictDecisions).filter(([, v]) => v === 'accept').map(([k]) => k),
          naming: { prefix: naming.prefix, suffix: naming.suffix, replacements: naming.replacements.filter((r) => r.from) },
          include: scope,
          bidPolicy: bidPolicy.mode === 'copy' ? undefined : { mode: bidPolicy.mode, value: bidPolicy.mode === 'fixed' ? Math.round((num(bidPolicy.value) ?? 0) * 100) : num(bidPolicy.value) },
          budgetPolicy: budgetPolicy.mode === 'copy' ? undefined : { mode: budgetPolicy.mode, value: num(budgetPolicy.value) },
        }),
      })
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return
          if (j?.error) { setPlanErr(j.error); setPreview(null) } else { setPreview(j as PlanPreviewResponse); setPlanErr(null) }
          setPlanning(false)
        })
        .catch((e) => { if (alive) { setPlanErr((e as Error).message); setPlanning(false) } })
    }, 400)
    return () => { alive = false; clearTimeout(t) }
    // planKey captures every input; listing them individually would be noise.
  }, [planKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Everything the plan is derived from, in one place. The launch sends exactly
   * this — a selector plus edits, never a plan — so the server rebuilds and
   * re-gates from the live account rather than trusting anything from here.
   */
  const requestBody = useCallback((extra: Record<string, unknown>) => {
    const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v))
    return JSON.stringify({
      source: { campaignIds: source.campaignIds, adGroupIds: source.adGroupIds, marketplace: sourceMarket },
      sourceProductToken: sourceToken.trim(),
      productToken: targetToken.trim(),
      asins,
      marketplace: market,
      portfolioId: portfolioId || undefined,
      dailyBudgetCapEur: num(cap),
      edits,
      acceptSharedTargets: Object.entries(conflictDecisions).filter(([, v]) => v === 'accept').map(([k]) => k),
      naming: { prefix: naming.prefix, suffix: naming.suffix, replacements: naming.replacements.filter((r) => r.from) },
      include: scope,
      bidPolicy: bidPolicy.mode === 'copy' ? undefined : { mode: bidPolicy.mode, value: bidPolicy.mode === 'fixed' ? Math.round((num(bidPolicy.value) ?? 0) * 100) : num(bidPolicy.value) },
      budgetPolicy: budgetPolicy.mode === 'copy' ? undefined : { mode: budgetPolicy.mode, value: num(budgetPolicy.value) },
      ...extra,
    })
  }, [source, sourceMarket, sourceToken, targetToken, asins, market, portfolioId, cap, edits, conflictDecisions, naming, scope, bidPolicy, budgetPolicy])

  /**
   * AX3.8 — start the run, then WATCH it.
   *
   * The launch used to be one long request. Creating ten campaigns is hundreds
   * of sequential Amazon calls, so the edge proxy closed the connection minutes
   * in, this `fetch` rejected with "Failed to fetch", and the operator was told
   * the launch had failed while the server went on to create ten live campaigns.
   *
   * The request now returns an id immediately and the work runs detached, so a
   * dead connection costs nothing. And if even that short request fails, we go
   * looking for the run before reporting failure — because "I could not reach
   * the server" and "nothing was created" are different sentences, and printing
   * the second when the first is true is what caused the incident.
   */
  const watch = useCallback(async (applicationId: string) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500))
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/blueprint-applications/${applicationId}`, { credentials: 'include' })
        if (!r.ok) continue
        const j = await r.json()
        setProgress({ done: j.step?.done ?? 0, total: j.step?.total ?? 0, campaign: j.step?.campaign ?? null, created: j.created })
        if (j.done) {
          setResult({
            applicationId: j.id, status: j.status, created: j.created,
            skippedNonKeyword: j.skippedNonKeyword ?? 0, notOnAmazon: j.notOnAmazon ?? [], errors: j.errors ?? [],
          })
          return
        }
      } catch { /* a lost poll is not a lost run — keep watching */ }
    }
  }, [])

  const launch = useCallback(async () => {
    if (launching) return
    setLaunching(true); setLaunchErr(null); setProgress(null)
    let applicationId: string | null = null
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/blueprints/replicate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: requestBody({ launchMode, dryRun: false }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.error) throw new Error(j?.blockers?.join(' · ') || j?.error || `HTTP ${r.status}`)
      applicationId = j.applicationId as string
    } catch (e) {
      // Did it start anyway? Ask before claiming it did not.
      try {
        const h = await fetch(`${getBackendUrl()}/api/advertising/blueprint-applications?marketplace=${market}&status=RUNNING`, { credentials: 'include' })
        const hj = await h.json()
        const mine = (hj?.items ?? []).find((x: { productToken: string }) => x.productToken === targetToken.trim())
        if (mine) applicationId = mine.id
      } catch { /* fall through to the error below */ }
      if (!applicationId) {
        setLaunchErr(`${(e as Error).message} — nothing was created; check "Past runs" before trying again.`)
        setLaunching(false)
        return
      }
    }
    await watch(applicationId)
    setLaunching(false)
  }, [launching, requestBody, launchMode, market, targetToken, watch])

  const afterRun = useCallback(async (path: string, label: string) => {
    if (!result || busy) return
    setBusy(true); setLaunchErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/blueprint-applications/${result.applicationId}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{}',
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.error) throw new Error(j?.error || `${label} failed`)
      if (path === 'rollback') setResult({ ...result, created: { campaigns: 0, adGroups: 0, targets: 0, negatives: 0, productAds: 0 }, status: 'PLANNED', errors: [`Rolled back — ${j.archived ?? 0} campaign(s) archived.`] })
      else setLaunchMode('live')
    } catch (e) { setLaunchErr((e as Error).message) } finally { setBusy(false) }
  }, [result, busy])

  const saveBlueprint = useCallback(async (name: string) => {
    setBusy(true); setLaunchErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/blueprints`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          name,
          campaignIds: source.campaignIds, adGroupIds: source.adGroupIds,
          marketplace: sourceMarket, productToken: sourceToken.trim(),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.error) throw new Error(j?.error || 'could not save')
    } catch (e) { setLaunchErr((e as Error).message) } finally { setBusy(false) }
  }, [source, sourceMarket, sourceToken])

  // Scroll-spy for the step-1 sub-nav, matching the SP Super Wizard's.
  useEffect(() => {
    if (step !== 1) return
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActiveSec(vis[0].target.id.replace('rep-', ''))
      },
      { rootMargin: '-110px 0px -62% 0px', threshold: 0 },
    )
    S1_SECTIONS.forEach((s) => { const el = document.getElementById(`rep-${s.id}`); if (el) obs.observe(el) })
    return () => obs.disconnect()
  }, [step])

  /**
   * Jump to a step-1 section.
   *
   * Two things had to be true, and only the second was obvious.
   *
   * 1. The ads shell scrolls an inner `.h10-main`, not the document, and step 1
   *    also contains its own scrollable source tree — so we walk up to the
   *    ancestor that genuinely scrolls rather than trusting `scrollIntoView` to
   *    pick it.
   * 2. **Native smooth scrolling does not work on that container.** Measured on
   *    prod: `scrollTo({behavior:'smooth'})` on `.h10-main` moves it zero pixels,
   *    while the identical call with `behavior:'auto'` lands correctly. `html`
   *    carries a global `scroll-behavior: smooth`, and the combination silently
   *    no-ops. That — not the container — is why the sub-nav has never worked,
   *    here or in the SP Super Wizard, which uses the same one-liner.
   *
   * So the scroll is a direct scrollTop assignment — see the note at the write.
   */
  const gotoSec = (id: string) => {
    const el = document.getElementById(`rep-${id}`)
    if (!el) return
    let box: HTMLElement | null = el.parentElement
    while (box && box !== document.body) {
      const oy = getComputedStyle(box).overflowY
      if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight + 1) break
      box = box.parentElement
    }
    const scroller = box && box !== document.body ? box : null
    const from = scroller ? scroller.scrollTop : window.scrollY
    const max = scroller ? scroller.scrollHeight - scroller.clientHeight : document.body.scrollHeight - window.innerHeight
    const to = Math.max(0, Math.min(max, from + el.getBoundingClientRect().top - 12))
    if (Math.abs(to - from) < 2) return

    // Assign scrollTop directly. Not the prettiest option and deliberately so:
    // this is the only form of this scroll I have been able to VERIFY working on
    // production. Native `behavior:'smooth'` moves this container zero pixels,
    // and an rAF tween cannot be confirmed either way from an automated tab
    // because rAF is suspended when the tab is not foreground. Two unverifiable
    // fixes have already shipped for this one control; a jump that provably
    // works beats a glide that might not.
    if (scroller) scroller.scrollTop = to
    else window.scrollTo(0, to)
  }

  const missing: string[] = []
  if (!source.campaigns) missing.push('a source')
  if (!sourceToken.trim()) missing.push('the product in the source names')
  if (!targetToken.trim()) missing.push('the product it becomes')
  if (!products.length) missing.push('at least one product to advertise')
  const canAdvance = missing.length === 0

  return (
    <div className="h10-spw h10-rep">
      <header className="h10-spw-top">
        <div className="hl">
          <span className="eyebrow">Helium 10 Ads</span>
          <h1>Campaign Builder : Replicate Structure</h1>
        </div>
        <Button onClick={() => router.push(EXIT_TO)}>Exit Builder</Button>
      </header>

      <nav className="h10-spw-steps" aria-label="Wizard steps">
        {STEPS.map((s, i) => (
          <Fragment key={s.n}>
            <button
              type="button"
              className={`h10-spw-step ${step === s.n ? 'on' : ''} ${step > s.n ? 'done' : ''}`}
              aria-current={step === s.n ? 'step' : undefined}
              onClick={() => setStep(s.n)}
            >
              <span className="circ">{s.n}</span>
              <span className="lbl">{s.label}</span>
            </button>
            {i < STEPS.length - 1 && <span className="h10-spw-conn" aria-hidden />}
          </Fragment>
        ))}
      </nav>

      <div className="h10-spw-body">
        {step === 1 && (
          <div className="h10-spw-s1">
            <aside className="rep-subnav" aria-label="Source and product sections">
              {S1_SECTIONS.map((s) => (
                <Button key={s.id} variant={activeSec === s.id ? 'tonal' : 'quiet'} block onClick={() => gotoSec(s.id)}>{s.label}</Button>
              ))}
            </aside>
            <div className="h10-spw-s1main">
              <section id="rep-source" className="h10-spw-sec">
                <h2>Source structure</h2>
                <p className="h10-spw-desc">
                  Choose what to copy. Tick a whole portfolio, individual campaigns, or single ad groups —
                  an ad group brings its campaign with it, because Amazon has no ad group without one.
                </p>
                <div className="rep-market">
                  <span className="lbl"><Info size={13} aria-hidden /> Reading from</span>
                  <SegmentedControl
                    size="sm"
                    ariaLabel="Source marketplace"
                    value={sourceMarket}
                    onChange={setSourceMarket}
                    options={MARKETS.map((m) => ({ value: m, label: m }))}
                  />
                </div>
                <SourcePicker
                  market={sourceMarket} selected={selectedAdGroups} setSelected={setSelectedAdGroups} onChange={onSource}
                  onPickBlueprint={(tok) => { guessAppliedFor.current = 'saved'; setSourceToken(tok) }}
                  reselect={reselect}
                />
                <SourceSummary s={source} orphaned={preview?.source.orphanedInSource ?? 0} />
              </section>

              <section id="rep-copy" className="h10-spw-sec">
                <h2>What to copy</h2>
                <p className="h10-spw-desc">Everything comes across by default. Turn off only what you do not want re-created.</p>
                <CopyScopePanel scope={scope} setScope={setScope} />
              </section>

              <section id="rep-naming" className="h10-spw-sec">
                <h2>Naming</h2>
                <p className="h10-spw-desc">
                  Rename everything in one go. Amazon will not accept two campaigns with the same name, and
                  most source names do not carry the product, so this is usually required rather than optional.
                </p>
                <NamingPanel
                  sourceToken={sourceToken} setSourceToken={setSourceToken}
                  targetToken={targetToken} setTargetToken={setTargetToken}
                  naming={naming} setNaming={setNaming}
                  sourceNames={source.campaignNames} guessed={guessed} liveNames={liveNames}
                />
              </section>

              <section id="rep-products" className="h10-spw-sec">
                <h2>Product Selection</h2>
                <p className="h10-spw-desc">The products the copied campaigns will advertise — one product ad per product, in every ad group.</p>
                {/* APS.2b — scoped to the DESTINATION market, not the console's.
                    Replication is the one flow where those legitimately differ:
                    copying IT→DE must offer what is advertisable in Germany. */}
                <ProductSelection products={products} setProducts={setProducts} marketplace={market} />
              </section>

              <section id="rep-destination" className="h10-spw-sec">
                <h2>Destination</h2>
                <p className="h10-spw-desc">Where the copies land, and what their bids and budgets should be.</p>
                <DestinationPanel
                  market={market} setMarket={setMarket}
                  portfolioId={portfolioId} setPortfolioId={setPortfolioId}
                  cap={cap} setCap={setCap}
                  bidPolicy={bidPolicy} setBidPolicy={setBidPolicy}
                  budgetPolicy={budgetPolicy} setBudgetPolicy={setBudgetPolicy}
                  plannedTotal={preview?.plan.totals.dailyBudgetTotal ?? null}
                />
              </section>
              <section id="rep-history" className="h10-spw-sec">
                <h2>Past runs &amp; saved structures</h2>
                <p className="h10-spw-desc">
                  What has already been replicated into {market}, and the structures you saved. Rolling a run
                  back archives every campaign it created, as one unit.
                </p>
                <HistoryPanel
                  market={market}
                  onReplicateAgain={(ids, tok) => {
                    // SourcePicker owns the ad-group ids, so hand it the campaigns
                    // and let it resolve them against the loaded tree.
                    setReselect({ campaignIds: ids, nonce: Date.now() })
                    guessAppliedFor.current = 'saved'
                    setSourceToken(tok)
                    gotoSec('source')
                  }}
                />
                <DriftCheck market={market} />
              </section>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="h10-spw-stub-step wide">
            <h2>Review &amp; Edit</h2>
            <p className="h10-spw-desc">
              Everything that would be created, before any of it is. Rename it, re-price it, re-target it,
              drop a keyword, an ad group or a whole campaign — and settle any keyword that would put this
              product in the same auction as one you already run.
            </p>
            {!preview ? (
              <div className="h10-spw-card h10-rep-todo">
                {planning ? 'Building the plan…' : 'Finish step 1 first — a source, both product tokens, and at least one product.'}
              </div>
            ) : (
              <ReviewStep
                plan={preview.plan}
                edits={edits}
                setEdits={setEdits}
                conflictDecisions={conflictDecisions}
                setConflictDecisions={setConflictDecisions}
                allAsins={asins}
                serverConflicts={verdictOf(preview)?.conflicts ?? []}
                focus={focus}
              />
            )}
          </div>
        )}

        {step === 3 && (
          <div className="h10-spw-stub-step">
            <h2>Preflight &amp; Launch</h2>
            <p className="h10-spw-desc">
              The last screen before any of this exists. Check what will be created, what will not be,
              and what it commits per day.
            </p>
            <LaunchStep
              plan={verdictOf(preview)} sourcePlan={preview?.plan ?? null} edits={edits}
              scope={scope} market={market}
              portfolioName={portfolioId ? portfolioNames.get(portfolioId) ?? portfolioId : null}
              cap={cap} setCap={setCap}
              launchMode={launchMode} setLaunchMode={setLaunchMode}
              launching={launching} progress={progress} result={result} err={launchErr} busy={busy}
              onLaunch={() => void launch()}
              onRollback={() => void afterRun('rollback', 'Rollback')}
              onRaise={() => void afterRun('raise-bids', 'Raise')}
              onSaveBlueprint={(n) => void saveBlueprint(n)}
              onResolve={onResolve}
            />
          </div>
        )}
      </div>

      <footer className="h10-spw-foot">
        {step > 1 && <Button size="lg" onClick={() => setStep((s) => (s > 1 ? ((s - 1) as StepN) : s))}>Back</Button>}
        <span className="grow" />
        {step < 3 && <PlanBar planning={planning} err={planErr} preview={preview} missing={missing} />}
        {/* Step 3 carries its own launch button — a second "Next" there would be
            a button with nothing left to do. */}
        {step < 3 && (
          <Button
            variant="primary"
            size="lg"
            disabled={step === 1 && !canAdvance}
            onClick={() => setStep((s) => (s < 3 ? ((s + 1) as StepN) : s))}
          >
            Next
          </Button>
        )}
        {step === 3 && result && (
          <Button variant="primary" size="lg" onClick={() => router.push('/marketing/ads/campaigns')}>
            Go to Ad Manager
          </Button>
        )}
      </footer>
    </div>
  )
}

/** What the current selection adds up to — the answer to "am I copying the right thing?". */
function SourceSummary({ s, orphaned }: { s: SourceSelection; orphaned: number }) {
  if (s.campaigns === 0) return <p className="h10-rep-sum none">Nothing selected yet.</p>
  return (
    <div className="h10-rep-sum">
      <b>{s.campaigns}</b> campaign{s.campaigns === 1 ? '' : 's'} · <b>{s.adGroups}</b> ad group{s.adGroups === 1 ? '' : 's'} ·{' '}
      <b>{s.positives}</b> target{s.positives === 1 ? '' : 's'} · <b>{s.negatives}</b> negative{s.negatives === 1 ? '' : 's'} ·{' '}
      <b>{s.productAds}</b> product ad{s.productAds === 1 ? '' : 's'}
      <span className="bud">source runs <b>€{s.dailyBudgetTotal.toFixed(2)}/day</b></span>
      {!s.whole && <span className="part">partial — some campaigns contribute only the ad groups you ticked</span>}
      {orphaned > 0 && (
        <span className="part">
          {orphaned} of these targets no longer exist on Amazon. They are still copied — a copy is a fresh
          create, not a re-push — but the source has drifted from what is live.
        </span>
      )}
    </div>
  )
}

/** The server's verdict, live in the footer, so it is never a surprise at step 3. */
function PlanBar({ planning, err, preview, missing }: {
  planning: boolean; err: string | null; preview: PlanPreviewResponse | null; missing: string[]
}) {
  if (missing.length) return <span className="h10-rep-hint">Still needed: {missing.join(', ')}</span>
  if (planning) return <span className="h10-rep-hint"><Loader2 size={13} className="spin" aria-hidden /> Checking this against your account…</span>
  if (err) return <span className="h10-rep-hint bad">{err}</span>
  // Always the EDITED plan when there is one — the footer must describe what
  // would actually be created, not what the source happened to contain.
  const p = verdictOf(preview)
  if (!p) return null
  const unresolved = p.conflicts.filter((c) => c.resolution === 'UNRESOLVED').length
  return (
    <span className="h10-rep-planbar">
      {p.allowed
        ? <span className="ok"><CheckCircle2 size={13} aria-hidden /> Ready</span>
        : <span className="bad"><AlertTriangle size={13} aria-hidden /> {p.blockers.length} blocker{p.blockers.length === 1 ? '' : 's'}</span>}
      <span className="t">
        {p.totals.campaigns} campaigns · {p.totals.positives} targets · {p.totals.negatives} negatives · {p.totals.productAds} ads ·{' '}
        <b>€{p.totals.dailyBudgetTotal.toFixed(2)}/day</b>
        {unresolved > 0 && <span className="cf"> · {unresolved} keyword conflict{unresolved === 1 ? '' : 's'} to resolve</span>}
      </span>
    </span>
  )
}
