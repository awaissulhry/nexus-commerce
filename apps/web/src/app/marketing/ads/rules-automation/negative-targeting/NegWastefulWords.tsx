'use client'

/**
 * NEG.6 — wasteful words: which words waste money across the account, and what negating one would
 * actually catch.
 *
 * Folded in from `/marketing/advertising/ngrams`, which had two tables, a CSV button each, no
 * scope, and no action. The CSV is kept — it is the one thing that page did that an operator may
 * rely on.
 *
 * ── 🔴 The number on the row is not the number the old page had ──────────────────────────────
 *
 * `NgramRow.terms` over-reports a 2-gram's reach by up to 4.7× — the tokenizer strips stop words
 * before pairing, so `moto protezioni` claims 61 terms where only 13 queries contain the phrase.
 * The payload's `catches` is a contiguous-token count, Amazon's own negative-phrase semantics, and
 * it is what every sentence here quotes.
 *
 * ── The winning table is not decoration ──────────────────────────────────────────────────────
 *
 * It is the safety rail, and it sits in the same view for that reason. `xavia` is the account's top
 * winning gram at ROAS 57.5 **and** one of the ten protected terms — the two lists agreeing is the
 * point, and it is why negating it is blocked rather than merely discouraged.
 *
 * ── One gram at a time ───────────────────────────────────────────────────────────────────────
 *
 * No bulk, no "negate the top N". One decision replaces up to 195 term-level ones, so it gets its
 * own preview stating the ad-group count, the term count, the money, and the fact that Amazon
 * cannot undo it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle, Check, Info, Download, ShieldCheck, TrendingUp, WifiOff, X, ChevronRight,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { NegSlotProps } from './slot-contract'

type BlockReason = 'winning-collision' | 'converting-terms' | 'protected-term' | 'below-floor' | 'no-ad-groups' | 'not-allowlisted'

interface Collision { gram: string; roas: number; salesCents: number }
interface ConvertingTerm { term: string; orders: number; salesCents: number }
interface WastefulGram {
  gram: string; n: 1 | 2
  costCents: number; clicks: number; impressions: number
  catches: number; catchesLoose: number
  adGroups: number; adGroupsWritable: number; adGroupsAlreadyNegated: number
  inNegatedPhrases: number; negatedAsWholeTerm: boolean
  isSizeToken: boolean; isAsinShaped: boolean
  marketSplit: Array<{ market: string; costCents: number }>
  /** 🔴 optional on purpose: web and API deploy separately, so a UI that hard-reads a field the
   *  API has not shipped yet crashes the section the moment a row is expanded. */
  sampleTerms?: Array<{ term: string; clicks: number; costCents: number; orders: number }>
  blockedBy: BlockReason[]
  collisions: Collision[]
  convertingTerms: ConvertingTerm[]
  protectedBy: Array<{ term: string; matchType: string }>
  actionable: boolean
}
interface WinningGram {
  gram: string; n: 1 | 2
  roas: number | null; acos: number | null
  costCents: number; salesCents: number; orders: number; clicks: number
  isProtected: boolean
}
interface Payload {
  scope: { boundBy: string; market: string; filtered: boolean; filterLabel: string | null; campaignsInScope: number }
  window: { days: number; since: string; minCostCents: number }
  floor: { minChars: number; minCatches: number }
  wasteful: WastefulGram[]
  winning: WinningGram[]
  totals: { wastefulShown: number; winningShown: number; actionable: number; blocked: number; sizeTokens: number; alreadyNegated: number }
  coverage: { searchTermRows: number; distinctQueries: number; negationRows: number }
}
interface NegateOutcome {
  externalAdGroupId: string; adGroupName: string; campaignName: string
  outcome: 'created' | 'already_existed' | 'refused' | 'failed'
  reason: string | null; externalNegativeKeywordId: string | null
}
interface NegateResult {
  ok: boolean; gram: string; blockedBy: BlockReason[] | null; error: string | null; code: string | null
  outcomes: NegateOutcome[]
  summary: { created: number; alreadyExisted: number; refused: number; failed: number }
}

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Every rail, in words. Never an enum on screen. */
const BLOCK_LABEL: Record<BlockReason, string> = {
  'winning-collision': 'it is part of a winning phrase',
  'converting-terms': 'it would catch a term that converted',
  'protected-term': 'it contains a protected term',
  'below-floor': 'it is below the floor',
  'no-ad-groups': 'no ad group ran it',
  'not-allowlisted': 'no campaign here is on the write allowlist',
}

export function NegWastefulWords({ scope, push }: NegSlotProps) {
  // 🔴 `useSearchParams`, never `window.location.search` — the latter is not reactive under soft
  // navigation, which is exactly how NEG.3b's confirm dialog silently never opened.
  const params = useSearchParams()
  const windowDays = params.get('gwindow') ?? ''
  const negateGram = params.get('negate')
  const showBlocked = params.get('blocked') === 'yes'

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<NegateResult | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    const p = new URLSearchParams({ market: scope.market })
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup, window: windowDays })) if (v) p.set(k, v)
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/negatives/wasteful-words?${p.toString()}`, { cache: 'no-store' })
      if (r.status === 404) {
        const b = await r.json().catch(() => ({} as { code?: string; error?: string }))
        // Our 404 and Fastify's route-missing 404 are both 404. Discriminate on the code.
        throw new Error(b?.code ? String(b.error) : 'This view is not available yet — the wasteful-words read is not deployed on this environment.')
      }
      if (!r.ok) throw new Error(`Could not load wasteful words (${r.status})`)
      setData((await r.json()) as Payload)
      setErr(null)
    } catch (e) {
      // 🔴 Never `.catch(() => [])`. An empty wasteful list reads as "no waste", which is the most
      // reassuring possible lie, and a failed request produces exactly that shape.
      setErr((e as Error).message)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [scope.market, scope.line, scope.portfolio, scope.campaign, scope.adGroup, windowDays])

  useEffect(() => { void load() }, [load])

  const target = useMemo(
    () => (negateGram && data ? data.wasteful.find((w) => w.gram === negateGram) ?? null : null),
    [negateGram, data],
  )

  const csv = (rows: Array<Record<string, unknown>>, head: string, name: string) => {
    const body = rows.map((r) => Object.values(r).map((v) => (typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\n')
    const blob = new Blob([`${head}\n${body}`], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `wasteful-words-${name}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const runNegate = async () => {
    if (!target || busy) return
    setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/negatives/negate-gram`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gram: target.gram, confirm: true, market: scope.market,
          line: scope.line || null, portfolio: scope.portfolio || null,
          campaign: scope.campaign || null, adGroup: scope.adGroup || null,
          window: data ? data.window.days : null,
        }),
      })
      const j = (await r.json().catch(() => ({}))) as NegateResult
      setResult(j)
      await load()
    } catch (e) {
      setResult({ ok: false, gram: target.gram, blockedBy: null, error: (e as Error).message, code: 'network', outcomes: [], summary: { created: 0, alreadyExisted: 0, refused: 0, failed: 0 } })
    } finally { setBusy(false) }
  }

  if (loading && !data) {
    return (
      <section id="wasteful-words" className="h10-ngw">
        <header className="h10-ngw-head"><h3>Wasteful words</h3></header>
        <p className="h10-ngw-msg">Tokenising every search term and aggregating by word…</p>
      </section>
    )
  }

  // Empty state 4 of 4 — the read failed. Deliberately not an empty table.
  if (err || !data) {
    return (
      <section id="wasteful-words" className="h10-ngw">
        <header className="h10-ngw-head"><h3>Wasteful words</h3></header>
        <p className="h10-ngw-bad">
          <WifiOff size={13} />
          <span>
            <b>Could not read the search terms.</b> {err ?? 'The request returned nothing.'} This is
            a failed read, not an absence of waste — an empty table would say the opposite of the
            truth, so nothing is shown.
          </span>
        </p>
      </section>
    )
  }

  const d = data
  const rows = showBlocked ? d.wasteful : d.wasteful.filter((w) => w.actionable || w.isSizeToken)
  // Empty state 1 of 4 — no search-term data at all in the window.
  const noData = d.coverage.searchTermRows === 0
  // Empty state 2 of 4 — data read fine, nothing clears the €3 floor.
  const noneClearFloor = !noData && d.wasteful.length === 0

  return (
    <section id="wasteful-words" className="h10-ngw">
      <header className="h10-ngw-head">
        <h3>Wasteful words</h3>
        <p>
          Which <b>words</b> waste money across every campaign at once, rather than one search term
          at a time. The account has negated whole phrases and left the words they share almost
          untouched.
        </p>
      </header>

      <div className="h10-ngw-bar">
        <span className="w">
          Last{' '}
          {([30, 60, 120] as const).map((w) => (
            <button key={w} type="button" className={`h10-ngw-win ${d.window.days === w ? 'on' : ''}`} onClick={() => push({ gwindow: String(w) })}>{w}d</button>
          ))}
        </span>
        <span className="sep" />
        <span className="f">
          {d.scope.filtered
            ? <>Filtered to <b>{d.scope.filterLabel}</b></>
            : <>Account-wide — <b>all markets, all campaigns</b></>}
        </span>
        <span className="sep" />
        <span className="f">Only words costing <b>{eur(d.window.minCostCents)}</b> or more</span>
      </div>

      {noData ? (
        <p className="h10-ngw-bad">
          <AlertTriangle size={13} />
          <span>
            <b>No search-term rows in the last {d.window.days} days{d.scope.filtered ? ` for ${d.scope.filterLabel}` : ''}.</b>{' '}
            Nothing can be tokenised, so nothing is shown — this is an absence of data, not an
            absence of waste. Try a longer window{d.scope.filtered ? ' or a wider scope' : ''}.
          </span>
        </p>
      ) : noneClearFloor ? (
        <p className="h10-ngw-good">
          <Check size={13} />
          <span>
            <b>No word costs {eur(d.window.minCostCents)} or more without an order.</b>{' '}
            {num(d.coverage.distinctQueries)} distinct queries were tokenised over{' '}
            {num(d.coverage.searchTermRows)} rows and none produced a wasteful word above the floor.
          </span>
        </p>
      ) : (
        <>
          <div className="h10-ngw-tabs" role="group" aria-label="Filters">
            <button type="button" className={`h10-ngw-tab ${!showBlocked ? 'on' : ''}`} aria-pressed={!showBlocked} onClick={() => push({ blocked: '' })}>
              <b>{num(d.totals.actionable)}</b><span>safe to negate</span>
            </button>
            <button type="button" className={`h10-ngw-tab ${showBlocked ? 'on' : ''}`} aria-pressed={showBlocked} onClick={() => push({ blocked: 'yes' })}>
              <b>{num(d.totals.blocked)}</b><span>blocked by a safety check{showBlocked ? ' — shown' : ' — hidden'}</span>
            </button>
            <span className="h10-ngw-tab flat"><b>{num(d.totals.alreadyNegated)}</b><span>already negated as a whole phrase</span></span>
            <span className="h10-ngw-tab flat"><b>{num(d.totals.sizeTokens)}</b><span>size tokens, not waste</span></span>
          </div>

          <p className="h10-ngw-note">
            <Info size={13} />
            <span>
              🔴 <b>A word is not a term.</b> Negating <b>protezioni</b> as a phrase blocks every
              query containing that word, including <i>giacca moto con protezioni</i>. The
              “<b>blocks</b>” column counts queries where the word appears as a whole word, in
              order — the same rule Amazon applies — so it is what the negation would actually
              catch, not how many rows mention it.
            </span>
          </p>

          <div className="h10-ngw-cols">
            {/* ── wasteful ─────────────────────────────────────────────────────────────────── */}
            <div className="h10-ngw-col">
              <div className="h10-ngw-subhd">
                <b>Costing money, earning nothing</b>
                <button type="button" className="h10-ngw-csv" onClick={() => csv(
                  d.wasteful.map((w) => ({ gram: w.gram, n: w.n, spend: (w.costCents / 100).toFixed(2), clicks: w.clicks, blocks: w.catches, adGroups: w.adGroups, actionable: w.actionable, blockedBy: w.blockedBy.join('|') })),
                  'gram,words,spend,clicks,blocks_terms,ad_groups,actionable,blocked_by', 'wasteful',
                )}><Download size={12} /> CSV</button>
              </div>

              {rows.length === 0 ? (
                <p className="h10-ngw-msg neutral">
                  <b>Nothing is safe to negate here.</b> All {num(d.totals.blocked)} wasteful words
                  in this view are held back by a safety check — turn on “blocked” above to see each
                  one and why.
                </p>
              ) : (
                <ul className="h10-ngw-list">
                  {rows.map((w) => (
                    <li key={w.gram} className={w.actionable ? '' : 'blocked'}>
                      <span className="g">
                        <em className={`ng n${w.n}`}>{w.n}w</em>
                        {/* 🔴 The GRAM does not open NEG.2's drawer. A gram is not a term —
                            `?focus=protezioni` would open an empty drawer for something that was
                            never negated. It expands to the terms behind it, and THOSE are terms. */}
                        <button
                          type="button" className="tw" aria-expanded={open[w.gram] === true}
                          onClick={() => setOpen((o) => ({ ...o, [w.gram]: !o[w.gram] }))}
                        >
                          <ChevronRight size={12} className={open[w.gram] ? 'rot' : ''} />
                          <b>{w.gram}</b>
                        </button>
                        {w.isSizeToken && <em className="tag size">size</em>}
                        {w.negatedAsWholeTerm && <em className="tag done">already negated</em>}
                      </span>
                      <span className="sp">{eur(w.costCents)}</span>
                      <span className="cl">{num(w.clicks)} clicks</span>
                      <span className="bl">blocks <b>{num(w.catches)}</b> {w.catches === 1 ? 'term' : 'terms'}</span>
                      <span className="ag">{num(w.adGroups)} ad {w.adGroups === 1 ? 'group' : 'groups'}</span>
                      <span className="ac">
                        {w.actionable
                          ? <button type="button" className="h10-ngw-act" onClick={() => { setResult(null); push({ negate: w.gram }) }}>Negate…</button>
                          : <em className="why">{BLOCK_LABEL[w.blockedBy[0]]}</em>}
                      </span>
                      {w.isSizeToken && (
                        <span className="cav">
                          🔴 <b>{w.gram}</b> is a catalogue gap, not waste — shoppers want this size and
                          the account does not carry it. Negating it hides the demand signal.
                        </span>
                      )}
                      {!w.actionable && !w.isSizeToken && (
                        <span className="cav">
                          {w.collisions.length > 0 && <>Part of <b>{w.collisions.map((c) => `“${c.gram}” (ROAS ${c.roas.toFixed(1)})`).join(', ')}</b>. </>}
                          {w.convertingTerms.length > 0 && <>Would catch <b>{w.convertingTerms.length}</b> converting {w.convertingTerms.length === 1 ? 'term' : 'terms'} worth <b>{eur(w.convertingTerms.reduce((a, t) => a + t.salesCents, 0))}</b>. </>}
                          {w.protectedBy.length > 0 && <>Contains the protected term <b>{w.protectedBy[0].term}</b>, so the write gate would refuse it. </>}
                          {w.blockedBy.includes('below-floor') && <>Below the floor of {d.floor.minChars} characters and {d.floor.minCatches} terms{w.isAsinShaped ? ', and it is an ASIN rather than a word' : ''}. </>}
                          {w.blockedBy.includes('not-allowlisted') && <>No campaign running it is on the live-write allowlist. </>}
                        </span>
                      )}
                      {open[w.gram] && (
                        <span className="terms">
                          <em className="hd">
                            {(w.sampleTerms ?? []).length === 0
                              ? <>The terms behind this word are not available from this API build.</>
                              : <>
                                  Top {Math.min((w.sampleTerms ?? []).length, 8)} of the <b>{num(w.catches)}</b>{' '}
                                  {w.catches === 1 ? 'term' : 'terms'} this word blocks, by spend
                                  {w.catchesLoose > w.catches && <> · {num(w.catchesLoose - w.catches)} more contain it inside a longer word and would <b>not</b> be blocked</>}
                                </>}
                          </em>
                          {(w.sampleTerms ?? []).map((t) => (
                            <span key={t.term} className="t">
                              <button type="button" className="lnk" onClick={() => push({ focus: t.term })}>{t.term}</button>
                              <i>{eur(t.costCents)} · {num(t.clicks)} clicks{t.orders > 0 ? ` · ${t.orders} orders` : ''}</i>
                            </span>
                          ))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ── winning — the safety rail, in the same view ───────────────────────────────── */}
            <div className="h10-ngw-col">
              <div className="h10-ngw-subhd">
                <b>Earning — never negate these</b>
                <button type="button" className="h10-ngw-csv" onClick={() => csv(
                  d.winning.map((w) => ({ gram: w.gram, n: w.n, roas: (w.roas ?? 0).toFixed(2), spend: (w.costCents / 100).toFixed(2), sales: (w.salesCents / 100).toFixed(2), orders: w.orders, protected: w.isProtected })),
                  'gram,words,roas,spend,sales,orders,protected', 'winning',
                )}><Download size={12} /> CSV</button>
              </div>
              <p className="h10-ngw-rail">
                <TrendingUp size={13} />
                <span>
                  This list is the safety rail, not a report. A wasteful word that appears inside one
                  of these is <b>blocked</b> rather than warned about.
                </span>
              </p>
              <ul className="h10-ngw-list win">
                {d.winning.slice(0, 25).map((w) => (
                  <li key={w.gram}>
                    <span className="g">
                      <em className={`ng n${w.n}`}>{w.n}w</em>
                      <b className="wg">{w.gram}</b>
                      {w.isProtected && <em className="tag prot"><ShieldCheck size={10} /> protected</em>}
                    </span>
                    <span className="ro">ROAS <b>{(w.roas ?? 0).toFixed(1)}</b></span>
                    <span className="sa">{eur(w.salesCents)}</span>
                    <span className="or">{w.orders} {w.orders === 1 ? 'order' : 'orders'}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className="h10-ngw-note">
            <Info size={13} />
            <span>
              Spend is <b>not additive down this column</b> — <i>protezioni</i> and{' '}
              <i>moto protezioni</i> count the same clicks twice, so summing it would double-count.
              Read each row on its own. Measured over {num(d.coverage.distinctQueries)} distinct
              queries in {num(d.coverage.searchTermRows)} rows.
            </span>
          </p>
        </>
      )}

      {/* ── the one write, behind the strictest confirm on the page ─────────────────────────── */}
      {target && (
        <div className="h10-ngw-modal" role="dialog" aria-modal="true" aria-label={`Negate ${target.gram}`}>
          <div className="box">
            <div className="hd">
              <b>Negate “{target.gram}” as a negative phrase</b>
              <button type="button" className="x" aria-label="Close" onClick={() => { setResult(null); push({ negate: '' }) }}><X size={14} /></button>
            </div>

            {!result ? (
              <>
                <p className="say">
                  This adds <b>{target.gram}</b> as a negative phrase in{' '}
                  <b>{num(target.adGroupsWritable)}</b> ad {target.adGroupsWritable === 1 ? 'group' : 'groups'}.
                  It blocks <b>{num(target.catches)}</b> search {target.catches === 1 ? 'term' : 'terms'} that
                  cost <b>{eur(target.costCents)}</b> and returned <b>no orders</b> in the last{' '}
                  {d.window.days} days. <b>None of them converted.</b>
                </p>
                <p className="warn">
                  <AlertTriangle size={13} />
                  <span>
                    🔴 <b>This cannot be undone at Amazon.</b> A negative keyword can only be
                    archived, never deleted, and archiving is terminal. It also blocks every{' '}
                    <i>future</i> query containing this word, not only the {num(target.catches)}{' '}
                    measured here.
                  </span>
                </p>
                <ul className="facts">
                  <li><span>Ad groups it will be written to</span><b>{num(target.adGroupsWritable)}</b></li>
                  {target.adGroups > target.adGroupsWritable && (
                    <li className="muted">
                      <span>Excluded — campaign not on the live-write allowlist</span>
                      <b>{num(target.adGroups - target.adGroupsWritable)}</b>
                    </li>
                  )}
                  {target.adGroupsAlreadyNegated > 0 && (
                    <li className="muted"><span>Already carry this phrase — will be skipped</span><b>{num(target.adGroupsAlreadyNegated)}</b></li>
                  )}
                  <li><span>Search terms blocked</span><b>{num(target.catches)}</b></li>
                  <li><span>Converting terms among them</span><b>{target.convertingTerms.length}</b></li>
                  <li><span>Spend it removes, last {d.window.days} days</span><b>{eur(target.costCents)}</b></li>
                  {target.marketSplit.length > 0 && (
                    <li><span>Where that spend is</span><b>{target.marketSplit.map((m) => `${m.market} ${eur(m.costCents)}`).join(' · ')}</b></li>
                  )}
                </ul>
                <div className="acts">
                  <button type="button" className="h10-ngw-act ghost" onClick={() => push({ negate: '' })}>Cancel</button>
                  <button type="button" className="h10-ngw-act danger" disabled={busy} onClick={() => void runNegate()}>
                    {busy ? 'Writing…' : `Negate in ${num(target.adGroupsWritable)} ad ${target.adGroupsWritable === 1 ? 'group' : 'groups'}`}
                  </button>
                </div>
              </>
            ) : (
              <>
                {result.ok ? (
                  <p className="say">
                    <b>{num(result.summary.created)} created</b>
                    {result.summary.alreadyExisted > 0 && <> · {num(result.summary.alreadyExisted)} already existed</>}
                    {result.summary.refused > 0 && <> · {num(result.summary.refused)} refused</>}
                    {result.summary.failed > 0 && <> · {num(result.summary.failed)} failed</>}
                    {' '}— per ad group, below. A row that says <b>created</b> reached Amazon and came
                    back with an id; nothing else did.
                  </p>
                ) : (
                  <p className="warn">
                    <AlertTriangle size={13} />
                    <span><b>Refused before anything was written.</b> {result.error}</span>
                  </p>
                )}
                {result.outcomes.length > 0 && (
                  <ul className="outs">
                    {result.outcomes.map((o) => (
                      <li key={o.externalAdGroupId} className={o.outcome}>
                        <span className="o">{o.outcome.replace('_', ' ')}</span>
                        <span className="c">{o.campaignName} › {o.adGroupName}</span>
                        {o.reason && <span className="r">{o.reason}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="acts">
                  <button type="button" className="h10-ngw-act ghost" onClick={() => { setResult(null); push({ negate: '' }) }}>Close</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
