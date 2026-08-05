'use client'

/**
 * ACR Stage 5 — the Sponsored Brands / Sponsored Display builder.
 *
 * The five existing flows are all Sponsored Products. SB and SD occupy DIFFERENT page-one
 * slots than SP, which is why they are the largest untapped coverage lever — but the account
 * has never run either: 19 SB/SD campaigns exist, all PAUSED, €0.00 lifetime spend.
 *
 * Two rules this surface exists to enforce, both visible rather than implied:
 *   1. **Preview before you spend.** The operator sees the exact JSON that would go to Amazon
 *      before anything is created. SD and SB speak different dialects (dates, casing, id types)
 *      and the payload is the only honest way to show which one is being spoken.
 *   2. **Born paused.** Creation never enables a campaign unless the operator ticks the box,
 *      having set a budget deliberately. The 19 existing SB/SD campaigns carry €1,040/day of
 *      standing budgets; an accidental enable here is a four-figure daily spend.
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import './sb-sd.css'

type AdType = 'SB' | 'SD'
const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸' }

/**
 * The read-back receipt from `verifyLaunch` — AX-VT.4. A create that Amazon accepted is not
 * the same as a campaign that exists: the whole point of that phase was that `createCampaign`
 * used to drop `portfolioId` silently and answer 200. So every launch here is read back.
 *
 * `uncovered` is not a failure — it counts entities no Amazon read covers. ACR Stage 5 closed
 * SB (ad groups, ads and keywords), so a clean-looking receipt now reflects a real check
 * rather than a gap that was never inspected.
 */
type Verification = {
  ok: boolean; total: number; verified: number
  mismatch: number; missingOnAmazon: number; notPushed: number
  uncovered: number; problems?: string[]; errors?: string[]
}

type SbTemplate = { brandName: string; logoAssetId?: string; landingType: string; landingUrl?: string; sourceCampaign: string }
type Prod = { id: string; name: string; sku: string; asin: string }
type RawProd = { id: string; name: string; sku: string; asin?: string | null }

/** Each step of the launch, so a partial failure says exactly how far it got. */
type Step = { label: string; state: 'pending' | 'ok' | 'fail'; detail?: string }

const COPY: Record<AdType, { title: string; blurb: string; slot: string }> = {
  SB: {
    title: 'Sponsored Brands',
    blurb: 'A headline banner above the search results, with your logo and up to three products. It is the only format that occupies the top-of-page banner slot.',
    slot: 'Headline banner — above the organic results, a slot no SP campaign can win.',
  },
  SD: {
    title: 'Sponsored Display',
    blurb: 'Product and audience targeting that runs on detail pages and off Amazon. It never competes with your SP bids because it buys different inventory.',
    slot: 'Detail-page and off-Amazon placements — inventory SP cannot reach at all.',
  },
}

export function SbSdBuilder() {
  const params = useSearchParams()
  const initial = (params.get('type') === 'SB' ? 'SB' : 'SD') as AdType
  const [type, setType] = useState<AdType>(initial)
  const [marketplace, setMarketplace] = useState('IT')
  const [markets, setMarkets] = useState<string[]>(['IT', 'DE', 'FR', 'ES'])
  const [name, setName] = useState('')
  const [budget, setBudget] = useState('20')
  const [tactic, setTactic] = useState<'T00020' | 'T00030'>('T00020')
  const [startEnabled, setStartEnabled] = useState(false)
  const [preview, setPreview] = useState<unknown>(null)
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [verification, setVerification] = useState<Verification | null>(null)
  const [defaultBid, setDefaultBid] = useState('0.50')
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Prod[]>([])
  const [searching, setSearching] = useState(false)
  /** A failed search must never render as "no products" — that is a zero meaning UNKNOWN. */
  const [searchError, setSearchError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Prod[]>([])
  const [defensive, setDefensive] = useState(true)
  const [rivalAsins, setRivalAsins] = useState('')
  const [steps, setSteps] = useState<Step[]>([])
  const [headline, setHeadline] = useState('')
  const [sbKeywords, setSbKeywords] = useState('')
  const [sbMatch, setSbMatch] = useState<'EXACT' | 'PHRASE' | 'BROAD'>('PHRASE')
  const [sbTemplate, setSbTemplate] = useState<{ template: SbTemplate | null; usable: boolean } | null>(null)

  // The SB creative's brand assets are cloned from an existing SB campaign in this marketplace.
  // Fetched up front so the operator sees WHOSE creative is being reused before creating one.
  useEffect(() => {
    if (type !== 'SB') { setSbTemplate(null); return }
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/sb-template?marketplace=${encodeURIComponent(marketplace)}`)
      .then((r) => r.json())
      .then((j) => { if (alive && !j?.error) setSbTemplate({ template: j?.template ?? null, usable: !!j?.usable }) })
      .catch(() => { if (alive) setSbTemplate(null) })
    return () => { alive = false }
  }, [type, marketplace])

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`)
      .then((r) => r.json()).then((j) => {
        if (!alive) return
        const ms = Array.from(new Set((j?.items ?? []).map((c: { marketplace?: string | null }) => (c.marketplace ?? '').toUpperCase()).filter(Boolean))) as string[]
        if (ms.length) setMarkets(ms)
      }).catch(() => {})
    return () => { alive = false }
  }, [])

  const budgetNum = Number(budget)
  const bidNum = Number(defaultBid)
  /**
   * SB is keyword-targeted; keywords go through their own endpoint (legacy `/sb/keywords`), not
   * the target one. Declared above `valid` because `valid` reads it — a `const` used before its
   * declaration is a temporal-dead-zone crash at render, not a hoisted undefined.
   */
  const sbKeywordList = useMemo(
    () => Array.from(new Set(sbKeywords.split(/[\n,]/).map((k) => k.trim().toLowerCase()).filter(Boolean))),
    [sbKeywords],
  )
  // A campaign with no product ad cannot serve, so it is not a valid launch — only a shell.
  const valid = name.trim().length > 0 && Number.isFinite(budgetNum) && budgetNum > 0
    && Number.isFinite(bidNum) && bidNum > 0 && picked.length > 0
    // An SB ad without a headline and a clonable brand logo cannot be created at all.
    && (type !== 'SB' || (headline.trim().length > 0 && !!sbTemplate?.usable && sbKeywordList.length > 0))

  /** Products are scoped to the chosen marketplace — a Milan SKU is not advertisable in Germany. */
  useEffect(() => { setPicked([]); setFound([]); setQ('') }, [marketplace])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setFound([]); setSearchError(null); return }
    let alive = true
    setSearching(true); setSearchError(null)
    const t = setTimeout(() => {
      fetch(`${getBackendUrl()}/api/products/search?advertisableOn=${encodeURIComponent(`AMAZON_${marketplace}`)}&q=${encodeURIComponent(term)}&limit=12`)
        .then(async (r) => {
          const j = await r.json().catch(() => null)
          if (!r.ok || j?.error) throw new Error(j?.error ?? `HTTP ${r.status}`)
          return j
        })
        .then((j) => {
          if (!alive) return
          setFound(((j?.items ?? []) as RawProd[])
            .map((p) => ({ id: p.id, name: p.name, sku: p.sku, asin: p.asin ?? '' }))
            .filter((p) => p.asin))  // an SD product ad needs an ASIN or SKU; no ASIN = not advertisable here
        })
        .catch((e) => { if (alive) { setFound([]); setSearchError((e as Error).message) } })
        .finally(() => { if (alive) setSearching(false) })
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [q, marketplace])

  const rivalList = useMemo(
    () => Array.from(new Set(rivalAsins.toUpperCase().match(/B0[A-Z0-9]{8}/g) ?? [])),
    [rivalAsins],
  )
  /**
   * The targets this launch will create.
   *
   * SD needs targeting to serve at all — a campaign with product ads and no targets buys
   * nothing. Contextual (T00020) targets ASINs: the operator's rivals, plus optionally our own
   * (the "defensive self-ASIN targeting" that walls competitors off our detail pages).
   * Audiences (T00030) remarkets to people who viewed the products we are advertising.
   */
  const plannedTargets = useMemo<Array<{ kind: string; value: string; audienceType?: string; label: string }>>(() => {
    if (type !== 'SD') return []
    if (tactic === 'T00030') {
      return picked.map((p) => ({ kind: 'AUDIENCE', value: p.asin, audienceType: 'VIEWS_REMARKETING', label: `views of ${p.asin}` }))
    }
    return [
      ...rivalList.map((a) => ({ kind: 'PRODUCT', value: a, label: `competitor ${a}` })),
      ...(defensive ? picked.map((p) => ({ kind: 'PRODUCT', value: p.asin, label: `defend ${p.asin}` })) : []),
    ]
  }, [type, tactic, picked, rivalList, defensive])

  // Any edit invalidates a preview — a payload shown next to changed inputs is a lie.
  useEffect(() => { setPreview(null); setResult(null); setVerification(null); setSteps([]) },
    [type, marketplace, name, budget, tactic, startEnabled, defaultBid, picked, rivalAsins, defensive, headline, sbKeywords, sbMatch])

  const body = useMemo(() => ({
    name: name.trim(), type, marketplace, dailyBudgetEur: budgetNum,
    ...(type === 'SD' ? { sdTactic: tactic } : {}),
    startEnabled,
  }), [name, type, marketplace, budgetNum, tactic, startEnabled])

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const j = await r.json()
    if (!r.ok || j?.error) throw new Error(j?.error ?? `HTTP ${r.status}`)
    return j
  }

  /**
   * Everything after the campaign row exists.
   *
   * Deliberately sequential and step-tracked rather than one opaque call. A campaign is created
   * on Amazon the moment the first request succeeds, so a failure three steps later leaves a
   * REAL half-built campaign behind. Telling the operator exactly which step failed is the
   * difference between "fix the last bit" and "something went wrong, go hunt in Seller Central".
   */
  const finishLaunch = async (campaign: { id?: string; externalCampaignId?: string }) => {
    const reached = (label: string, state: Step['state'], detail?: string) =>
      setSteps((s) => [...s.filter((x) => x.label !== label), { label, state, detail }])

    reached('Campaign', 'ok', campaign.externalCampaignId ? `Amazon ${campaign.externalCampaignId}` : 'local only — write gate closed')
    if (!campaign.id) return

    let adGroupId: string | undefined
    try {
      const ag = await post('adgroups/create', { campaignId: campaign.id, name: `${name.trim()} — ad group`, defaultBidEur: bidNum })
      adGroupId = ag?.id
      reached('Ad group', 'ok', ag?.externalAdGroupId ? `Amazon ${ag.externalAdGroupId}` : 'local only')
    } catch (e) {
      reached('Ad group', 'fail', (e as Error).message)
      setResult({ ok: false, msg: 'The campaign was created but its ad group was not. It cannot serve until that is fixed.' })
      return
    }
    if (!adGroupId) return

    // SB has no product ad — its unit is one creative carrying up to three ASINs. SD creates one
    // product ad per ASIN. Sending SB down the product-ad path would hit /sp/productAds.
    let ads = 0
    if (type === 'SB') {
      try {
        await post('sb-creatives/create', {
          adGroupId, headline: headline.trim(), asins: picked.slice(0, 3).map((p) => p.asin),
          brandName: sbTemplate?.template?.brandName,
          logoAssetId: sbTemplate?.template?.logoAssetId,
          landingType: sbTemplate?.template?.landingType,
          landingUrl: sbTemplate?.template?.landingUrl,
        })
        ads = 1
        reached('Creative', 'ok', `${Math.min(picked.length, 3)} ASIN${picked.length === 1 ? '' : 's'}, brand assets from ${sbTemplate?.template?.sourceCampaign ?? 'template'}`)
      } catch (e) { reached('Creative', 'fail', (e as Error).message) }
      if (picked.length > 3) reached('Creative note', 'ok', `Amazon allows 3 products per SB creative — ${picked.length - 3} not included`)
    } else {
      for (const p of picked) {
        try { await post('product-ads/create', { adGroupId, sku: p.sku, asin: p.asin }); ads += 1 }
        catch (e) { reached('Product ads', 'fail', `${p.asin}: ${(e as Error).message}`) }
      }
      if (ads === picked.length) reached('Product ads', 'ok', `${ads} of ${picked.length}`)
      else reached('Product ads', 'fail', `${ads} of ${picked.length} created`)
    }

    let targets = 0
    for (const t of plannedTargets) {
      try {
        await post('targets/create', { adGroupId, kind: t.kind, value: t.value, bidEur: bidNum, ...(t.audienceType ? { audienceType: t.audienceType } : {}) })
        targets += 1
      } catch (e) { reached('Targets', 'fail', `${t.label}: ${(e as Error).message}`) }
    }
    if (plannedTargets.length > 0 && targets === plannedTargets.length) reached('Targets', 'ok', `${targets} of ${plannedTargets.length}`)
    else if (plannedTargets.length > 0) reached('Targets', 'fail', `${targets} of ${plannedTargets.length} created`)

    // SB keywords go through the keyword endpoint (legacy /sb/keywords), not the target one.
    let keywords = 0
    if (type === 'SB') {
      for (const kw of sbKeywordList) {
        try { await post('keywords/create', { adGroupId, keywordText: kw, matchType: sbMatch, bidEur: bidNum }); keywords += 1 }
        catch (e) { reached('Keywords', 'fail', `${kw}: ${(e as Error).message}`) }
      }
      if (keywords === sbKeywordList.length) reached('Keywords', 'ok', `${keywords} ${sbMatch.toLowerCase()}`)
      else reached('Keywords', 'fail', `${keywords} of ${sbKeywordList.length} created`)
    }

    // Neither family serves on ads alone: SD needs targets, SB needs keywords.
    const servable = ads > 0 && (type === 'SD' ? targets > 0 : keywords > 0)
    setResult({
      ok: servable,
      msg: servable
        ? type === 'SB'
          ? `Created ${name.trim()} — ad group, creative and ${keywords} keyword${keywords === 1 ? '' : 's'}, campaign ${startEnabled ? 'ENABLED' : 'PAUSED'}.`
          : `Created ${name.trim()} — ${ads} product ad${ads === 1 ? '' : 's'}, ${targets} target${targets === 1 ? '' : 's'}, campaign ${startEnabled ? 'ENABLED' : 'PAUSED'}.`
        : 'The campaign exists but cannot serve yet — see the steps above.',
    })

    // AX-VT.4 — read it back. Only meaningful once it reached Amazon; a local-only row has
    // nothing to verify against, and asking would report every entity as NOT_PUSHED.
    if (campaign.externalCampaignId) {
      try {
        const v = await fetch(`${getBackendUrl()}/api/advertising/launches/verify`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaignIds: [campaign.id] }),
        })
        const vj = await v.json()
        if (v.ok && !vj?.error) setVerification(vj as Verification)
      } catch { /* a failed READ is not a failed write — stay silent rather than cry wolf */ }
    }
  }

  const call = async (dryRun: boolean) => {
    setBusy(dryRun ? 'preview' : 'create'); setResult(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, dryRun }),
      })
      const j = await r.json()
      if (!r.ok || j?.error) { setResult({ ok: false, msg: j?.error ?? `HTTP ${r.status}` }); return }
      if (dryRun) {
        /**
         * The backend must PROVE it understood the dry run.
         *
         * `dryRun` is an ordinary field on a create request: an API that predates it ignores
         * it and creates the campaign for real. Web and API deploy independently, so there is
         * a genuine window where this new page talks to an older API — and in that window a
         * button labelled "Preview" would spend money. A response that does not say
         * `mode: 'dry-run'` therefore means a campaign was probably just CREATED, and the
         * operator needs to hear that immediately rather than see an empty preview.
         */
        if (j?.mode !== 'dry-run') {
          setResult({ ok: false, msg: 'This API version does not support preview — it may have CREATED a campaign instead. Check the Ad Manager before retrying, and deploy the API before the web app.' })
          return
        }
        setPreview((j?.dryRun as { wouldSend?: unknown })?.wouldSend ?? j?.dryRun)
      }
      else await finishLaunch(j)
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message })
    } finally { setBusy(null) }
  }

  return (
    <div className="h10-spw h10-sbsd">
      <div className="h10-cb-top">
        <div className="h10-cb-h"><span className="t">{COPY[type].title} Campaign</span><span className="beta">NEW</span></div>
        <Link href="/marketing/ads/campaign-builder" className="h10-cb-exit">Exit Builder</Link>
      </div>

      <div className="h10-sbsd-panel">
        <div className="h10-sbsd-slot">{COPY[type].slot}</div>

        <section className="h10-sbsd-sec">
          <h3>Ad type</h3>
          <div className="h10-sbsd-types">
            {(['SD', 'SB'] as AdType[]).map((t) => (
              <button type="button" key={t} className={`h10-sbsd-type ${t === type ? 'on' : ''}`} onClick={() => setType(t)}>
                <b>{COPY[t].title}</b>
                <span>{COPY[t].blurb}</span>
              </button>
            ))}
          </div>
          <p className="h10-sbsd-note">
            Sponsored Brands Video is not offered here yet — it needs video creative, which this
            account does not have. When assets exist it slots in beside these two.
          </p>
        </section>

        <section className="h10-sbsd-sec">
          <h3>Campaign</h3>
          <div className="h10-sbsd-grid">
            <label className="f">
              <span>Marketplace</span>
              <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
                {markets.map((m) => <option key={m} value={m}>{FLAG[m] ?? ''} {m}</option>)}
              </select>
            </label>
            <label className="f wide">
              <span>Campaign name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. GALE ${type === 'SB' ? 'Brand' : 'Display'} ${marketplace}`} />
            </label>
            <label className="f">
              <span>Daily budget (€)</span>
              <input type="number" min="1" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </label>
            <label className="f">
              <span>Default bid (€)</span>
              <input type="number" min="0.02" step="0.01" value={defaultBid} onChange={(e) => setDefaultBid(e.target.value)} />
            </label>
          </div>

          {type === 'SD' && (
            <div className="h10-sbsd-tactic">
              <span className="lbl">Targeting tactic</span>
              <label className="r">
                <input type="radio" checked={tactic === 'T00020'} onChange={() => setTactic('T00020')} />
                <span><b>Contextual (T00020)</b> — product and category targeting on detail pages.</span>
              </label>
              <label className="r">
                <input type="radio" checked={tactic === 'T00030'} onChange={() => setTactic('T00030')} />
                <span><b>Audiences (T00030)</b> — views remarketing and interest audiences, on and off Amazon.</span>
              </label>
            </div>
          )}
        </section>

        <section className="h10-sbsd-sec">
          <h3>Products to advertise</h3>
          <p className="h10-sbsd-note">
            A campaign with no product ad cannot serve. Scoped to {marketplace} — a SKU listed
            elsewhere is not advertisable here.
          </p>
          <div className="h10-sbsd-pick">
            <input
              className="h10-sbsd-search" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search your products by name, SKU or ASIN…"
            />
            {searching && <span className="h10-sbsd-hint">Searching…</span>}
            {found.length > 0 && (
              <ul className="h10-sbsd-found">
                {found.map((p) => {
                  const on = picked.some((x) => x.id === p.id)
                  return (
                    <li key={p.id}>
                      <button type="button" className={on ? 'on' : ''} onClick={() => setPicked((cur) => on ? cur.filter((x) => x.id !== p.id) : [...cur, p])}>
                        <b>{p.name}</b><span>{p.sku} · {p.asin}</span><i>{on ? 'Remove' : 'Add'}</i>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {searchError
              ? <span className="h10-sbsd-searcherr">Could not search your products — {searchError}. This is not &ldquo;no results&rdquo;; the catalogue was never reached.</span>
              : q.trim().length >= 2 && !searching && found.length === 0 && (
                <span className="h10-sbsd-hint">No advertisable products match that in {marketplace}.</span>
              )}
            {picked.length > 0 && (
              <div className="h10-sbsd-chips">
                {picked.map((p) => (
                  <span key={p.id} className="chip">
                    {p.asin}
                    <button type="button" onClick={() => setPicked((cur) => cur.filter((x) => x.id !== p.id))} aria-label={`Remove ${p.asin}`}>×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

        {type === 'SB' && (
          <section className="h10-sbsd-sec">
            <h3>Creative</h3>
            <p className="h10-sbsd-note">
              A Sponsored Brands ad needs a headline, your brand logo and a landing page. The logo
              and landing page are cloned from an existing SB campaign in {marketplace} — this
              account has no creative-asset upload flow, and Amazon will not accept an ad without them.
            </p>
            <label className="f" style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 520 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1c2530' }}>Headline</span>
              <input
                className="h10-sbsd-search" value={headline} maxLength={50}
                onChange={(e) => setHeadline(e.target.value)} placeholder="e.g. RIDE IN STYLE"
              />
              <span className="h10-sbsd-hint">{headline.length}/50 — shown beside your logo above the search results.</span>
            </label>
            <div className="h10-sbsd-plan">
              {sbTemplate === null
                ? <span>Looking for brand assets in {marketplace}…</span>
                : sbTemplate.usable
                  ? <span>Brand assets: <b>{sbTemplate.template?.brandName}</b>, logo and landing page cloned from <b>{sbTemplate.template?.sourceCampaign}</b>.</span>
                  : <span className="warn">No SB creative exists in {marketplace} to clone brand assets from — an SB ad cannot be created here yet.</span>}
            </div>
            {picked.length > 3 && (
              <div className="h10-sbsd-plan"><span className="warn">Amazon allows 3 products per SB creative — only the first 3 selected will be included.</span></div>
            )}
          </section>
        )}

        {type === 'SB' && (
          <section className="h10-sbsd-sec">
            <h3>Keywords</h3>
            <p className="h10-sbsd-note">
              Sponsored Brands is keyword-targeted — without keywords the campaign buys nothing.
            </p>
            <div className="h10-sbsd-tactic">
              <span className="lbl">Match type</span>
              {(['EXACT', 'PHRASE', 'BROAD'] as const).map((m) => (
                <label className="r" key={m}>
                  <input type="radio" checked={sbMatch === m} onChange={() => setSbMatch(m)} />
                  <span><b>{m[0] + m.slice(1).toLowerCase()}</b> — {m === 'EXACT' ? 'only this exact query.' : m === 'PHRASE' ? 'queries containing this phrase in order.' : 'the widest reach, and the loosest.'}</span>
                </label>
              ))}
            </div>
            <label className="f" style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1c2530' }}>Keywords — one per line</span>
              <textarea
                className="h10-sbsd-asins" rows={4} value={sbKeywords} onChange={(e) => setSbKeywords(e.target.value)}
                placeholder={'giacca moto estiva\ngiacca pelle uomo'}
              />
            </label>
            <div className="h10-sbsd-plan">
              {sbKeywordList.length === 0
                ? <span className="warn">No keywords — this campaign will not serve.</span>
                : <span>{sbKeywordList.length} keyword{sbKeywordList.length === 1 ? '' : 's'} at {sbMatch.toLowerCase()} match, €{bidNum || 0} each.</span>}
            </div>
          </section>
        )}

        {type === 'SD' && (
          <section className="h10-sbsd-sec">
            <h3>Targeting</h3>
            <p className="h10-sbsd-note">
              {tactic === 'T00030'
                ? 'Audiences remarket to people who viewed the products above. One audience target is created per product.'
                : 'Contextual targeting buys placements on specific detail pages. Without at least one target an SD campaign buys nothing.'}
            </p>
            {tactic === 'T00020' && (
              <>
                <label className="h10-sbsd-enable">
                  <input type="checkbox" checked={defensive} onChange={(e) => setDefensive(e.target.checked)} />
                  <span>
                    <b>Defend my own detail pages.</b> Targets the products above with their own ads,
                    which walls competitors off the pages you already own.
                  </span>
                </label>
                <label className="f" style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1c2530' }}>Competitor ASINs (optional)</span>
                  <textarea
                    className="h10-sbsd-asins" rows={3} value={rivalAsins} onChange={(e) => setRivalAsins(e.target.value)}
                    placeholder="B0XXXXXXXX B0YYYYYYYY — paste or space-separate"
                  />
                </label>
              </>
            )}
            <div className="h10-sbsd-plan">
              {plannedTargets.length === 0
                ? <span className="warn">No targets planned — this campaign will not serve.</span>
                : <span>{plannedTargets.length} target{plannedTargets.length === 1 ? '' : 's'}: {plannedTargets.slice(0, 6).map((t) => t.label).join(', ')}{plannedTargets.length > 6 ? ` +${plannedTargets.length - 6} more` : ''}</span>}
            </div>
          </section>
        )}

        <section className="h10-sbsd-sec">
          <h3>Launch state</h3>
          <label className="h10-sbsd-enable">
            <input type="checkbox" checked={startEnabled} onChange={(e) => setStartEnabled(e.target.checked)} />
            <span>
              <b>Start this campaign enabled.</b> Leave unticked and it is created PAUSED, which is
              the default for every SB/SD campaign. Tick this only if the budget above is the one
              you intend to spend from today.
            </span>
          </label>
          {startEnabled && (
            <div className="h10-sbsd-warn">
              This campaign will begin spending up to €{budgetNum || 0} per day as soon as Amazon accepts it.
            </div>
          )}
        </section>

        <div className="h10-sbsd-actions">
          <button type="button" className="h10-sbsd-btn ghost" disabled={!valid || busy !== null} onClick={() => call(true)}>
            {busy === 'preview' ? 'Building…' : 'Preview payload'}
          </button>
          <button type="button" className="h10-sbsd-btn primary" disabled={!valid || !preview || busy !== null} onClick={() => call(false)}>
            {busy === 'create' ? 'Creating…' : startEnabled ? 'Create ENABLED campaign' : 'Create paused campaign'}
          </button>
          {!preview && valid && <span className="h10-sbsd-hint">Preview the payload before creating.</span>}
        </div>

        {preview != null && (
          <section className="h10-sbsd-sec">
            <h3>What will be sent to Amazon</h3>
            <p className="h10-sbsd-note">
              {type === 'SD'
                ? 'Sponsored Display uses the legacy JSON API: a bare array, lowercase states and a YYYYMMDD start date.'
                : 'Sponsored Brands uses the v4 API: a campaigns envelope, uppercase states and an ISO start date.'}
            </p>
            <pre className="h10-sbsd-pre">{JSON.stringify(preview, null, 2)}</pre>
          </section>
        )}

        {/*
          A launch is several live writes. Once the campaign exists on Amazon a later failure
          leaves a real half-built campaign, so every step reports itself — "which step" is the
          difference between a small fix and a hunt through Seller Central.
        */}
        {steps.length > 0 && (
          <ul className="h10-sbsd-steps">
            {steps.map((s) => (
              <li key={s.label} className={s.state}>
                <span className="mk">{s.state === 'ok' ? '✓' : '✕'}</span>
                <b>{s.label}</b>
                {s.detail && <span className="dt">{s.detail}</span>}
              </li>
            ))}
          </ul>
        )}

        {result && (
          <div className={`h10-sbsd-result ${result.ok ? 'ok' : 'bad'}`}>{result.msg}</div>
        )}

        {/*
          Deliberately asymmetric, following LaunchReceipt: a verified launch gets one quiet
          line, because adding a "yes it worked" ceremony is how receipts get ignored. A launch
          that did NOT verify shows what disagreed and stays on screen.
        */}
        {verification && (
          verification.ok ? (
            <div className="h10-sbsd-verify ok">
              Read back from Amazon: {verification.verified}/{verification.total} verified.
              {verification.uncovered > 0 && ` ${verification.uncovered} could not be checked (no Amazon read exists for that entity kind${type === 'SB' ? ' — SB ad groups and ads' : ''}).`}
            </div>
          ) : (
            <div className="h10-sbsd-verify bad">
              <b>This launch did not verify.</b> {verification.verified}/{verification.total} matched
              {verification.mismatch > 0 && ` · ${verification.mismatch} disagree`}
              {verification.missingOnAmazon > 0 && ` · ${verification.missingOnAmazon} missing on Amazon`}
              {verification.notPushed > 0 && ` · ${verification.notPushed} never pushed`}.
              {(verification.problems ?? []).length > 0 && (
                <ul>{verification.problems!.slice(0, 8).map((p, i) => <li key={i}>{p}</li>)}</ul>
              )}
              {(verification.errors ?? []).length > 0 && (
                <div className="err">Could not be read back: {verification.errors!.slice(0, 3).join(' · ')}</div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  )
}
