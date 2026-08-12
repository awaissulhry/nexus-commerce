'use client'

/**
 * NEG.3b — the retirement path: how a block ends, and the record it leaves.
 *
 * 🔴 THE ONLY WRITE ON THIS PAGE, AND ARCHIVING IS IRREVERSIBLE AT AMAZON. There is no un-archive
 * — not at Amazon, not here, not as a disabled control promising one later. Re-negating a term
 * afterwards creates a NEW negative, and the dialog says so rather than implying a toggle.
 *
 * Everything the confirm dialog states comes from `GET /advertising/negatives/term-context`, the
 * single owner of that derivation (NEG.2). Nothing here re-derives it.
 *
 * ── Three copy variants, because they are three different facts ───────────────────────────────
 *
 *   at Amazon      2,017 rows · archived at Amazon, kept here with a retirement record
 *   local-only        41 rows · Amazon never confirmed it; our record goes, Amazon is untouched
 *   already ARCHIVED  62 rows · NO ACTION. Archived ON Amazon and mirrored in; we have no record
 *                              of when, and `updatedAt` is the last ingest tick, not a decision.
 *
 * ── Two numbers that are not the same number ──────────────────────────────────────────────────
 *
 * 🔴 The write count is `overlapRows`, never `overlap.length`. One ad group can hold two negation
 * rows for the same term at different match types. NEG.2 found that through an assertion that was
 * itself wrong; a dialog saying "removing 1" while issuing 2 writes is the defect this page exists
 * to prevent.
 *
 * ── Delivery is not acceptance ────────────────────────────────────────────────────────────────
 *
 * 🔴 `delivery: 'enqueued'` means the write gate has NOT run yet. It runs later, in the worker, and
 * it refuses 1,014 of 2,058 negatives outright (`campaign_allowlist`). A refused row renders as a
 * refusal with the gate's own words — never as a success that has not refreshed yet.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Info, Loader2, ShieldAlert, Trash2, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { NegSlotProps, NegationRow } from './slot-contract'

type Delivery = 'not_applicable' | 'enqueued' | 'refused' | 'failed'
type OutcomeKind = 'retired' | 'removed_local' | 'skipped' | 'refused' | 'failed'

interface Outcome {
  adTargetId: string
  term: string
  kind: OutcomeKind
  delivery: Delivery
  outboundQueueId: string | null
  actionLogId: string | null
  reason: string | null
  scope: { campaignName: string; adGroupName: string; level: string } | null
}
interface RetireResult {
  outcomes: Outcome[]
  summary: { retired: number; removedLocal: number; skipped: number; refused: number; failed: number; attempted: number }
}
interface TermNegation {
  id: string
  level: 'AD_GROUP' | 'CAMPAIGN'
  campaignName: string
  campaignStatus: string
  adGroupName: string
  market: string
  status: string
  atAmazon: boolean
  blockingNow: boolean
  inScope: boolean
  overlaps: boolean
}
interface TermContext {
  term: { key: string; display: string; protectedBy: Array<{ term: string; matchType: string; reason: string | null }> }
  spread: { rows: number; adGroups: number; campaigns: number; markets: string[] }
  comparable: { negatedAdGroups: number; campaignLevel: number }
  negations: TermNegation[]
  window: { days: number }
  performance: { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number; acos: number | null }
  runsIn: unknown[]
  overlap: unknown[]
  overlapRows: number
  history: { days: number; orders: number; salesCents: number; impressions: number }
  remainder: { inScope: number; total: number; remainderRows: number; remainderCampaigns: number; scopeIsWholeAccount: boolean }
}

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Which of the three variants a row falls into. Decided once, here, so the copy cannot drift. */
type RowClass = 'at-amazon' | 'local-only' | 'already-archived'
const classOf = (n: { atAmazon: boolean; status: string }): RowClass =>
  n.status === 'ARCHIVED' ? 'already-archived' : n.atAmazon ? 'at-amazon' : 'local-only'

/**
 * The dialog + the outcome report. Driven entirely by the URL (`?retire=` / `?retireTerm=`), so a
 * confirm is linkable and `push` stays the single writer of page state — no local state that the
 * URL does not carry.
 */
export function NegRemoval({ scope, push, reload }: NegSlotProps) {
  const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search)
  const retireId = params?.get('retire') ?? null
  const retireTerm = params?.get('retireTerm') ?? null
  const open = !!(retireId || retireTerm)

  const [ctx, setCtx] = useState<TermContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RetireResult | null>(null)
  /** which of the term's negations the bulk action will touch */
  const [pick, setPick] = useState<'in-scope' | 'live' | 'all'>('in-scope')

  const close = useCallback(() => { setResult(null); setErr(null); setReason(''); push({ retire: '', retireTerm: '' }) }, [push])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, close])

  // The evidence comes from term-context, always. A single-row confirm needs the same derivation a
  // bulk one does — it is the remainder sentence that makes either honest.
  useEffect(() => {
    if (!open) { setCtx(null); setResult(null); return }
    let alive = true
    setLoading(true); setErr(null)
    const termKey = retireTerm ?? ''
    const run = async () => {
      let key = termKey
      if (!key && retireId) {
        // Resolve the row's term from the inventory read the page already has in the URL scope.
        const p = new URLSearchParams({ market: scope.market, view: 'negations' })
        const inv = await fetch(`${getBackendUrl()}/api/advertising/negatives?${p.toString()}`, { cache: 'no-store' }).then((r) => r.json())
        key = (inv?.rows ?? []).find((r: NegationRow) => r.id === retireId)?.termKey ?? ''
      }
      if (!key) throw new Error('Could not resolve which term this negation belongs to')
      const q = new URLSearchParams({ term: key, market: scope.market })
      for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup })) if (v) q.set(k, v)
      const r = await fetch(`${getBackendUrl()}/api/advertising/negatives/term-context?${q.toString()}`, { cache: 'no-store' })
      if (r.status === 404) {
        const body = await r.json().catch(() => ({} as { code?: string }))
        // NEG.2's fifth empty state: our 404 and Fastify's route-missing 404 are both 404.
        throw new Error(body?.code === 'term_not_negated' ? 'Nothing negates this term any more.' : 'This view is not available yet — the term-context read is not deployed on this environment.')
      }
      if (!r.ok) throw new Error(`Could not load this term (${r.status})`)
      return (await r.json()) as TermContext
    }
    void run()
      .then((d) => { if (alive) setCtx(d) })
      .catch((e) => { if (alive) setErr((e as Error).message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, retireId, retireTerm, scope.market, scope.line, scope.portfolio, scope.campaign, scope.adGroup])

  if (!open) return null

  const single = ctx && retireId ? ctx.negations.find((n) => n.id === retireId) ?? null : null
  const bulkSet = (() => {
    if (!ctx || !retireTerm) return []
    // 🔴 Already-archived rows are never in a bulk set. They were archived ON Amazon and mirrored
    // in; a no-op logged as a retirement would be a false record.
    const eligible = ctx.negations.filter((n) => n.status !== 'ARCHIVED')
    if (pick === 'all') return eligible
    if (pick === 'live') return eligible.filter((n) => n.blockingNow)
    return eligible.filter((n) => n.inScope)
  })()
  const targets = single ? [single] : bulkSet
  const rowClass = single ? classOf(single) : null
  const writeCount = targets.length

  const submit = async () => {
    if (busy || targets.length === 0) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/negatives/retire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adTargetIds: targets.map((t) => t.id), reason: reason.trim() || null, confirm: true }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) { setErr(body?.error ?? `The retirement was refused (${r.status})`); return }
      setResult(body as RetireResult)
      reload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <>
      <button type="button" className="h10-ngr-back" aria-label="Close" onClick={() => { if (!busy) close() }} />
      <div className="h10-ngr" role="dialog" aria-modal="true" aria-label="Stop blocking this term">
        <header className="h10-ngr-head">
          <h3>{result ? 'What happened' : single ? 'Stop blocking this term here?' : `Stop blocking “${ctx?.term.display ?? retireTerm}”?`}</h3>
          <button type="button" className="h10-ngr-close" onClick={close} disabled={busy} aria-label="Close"><X size={15} /></button>
        </header>

        {loading && <p className="h10-ngr-msg"><Loader2 size={13} className="spin" /> Loading the term’s numbers…</p>}
        {err && <p className="h10-ngr-bad"><AlertTriangle size={13} /><span>{err}</span></p>}

        {/* ── the outcome report ──────────────────────────────────────────────────────────── */}
        {result ? (
          <>
            <div className="h10-ngr-sum">
              {([
                ['retired', result.summary.retired, 'archived at Amazon'],
                ['local', result.summary.removedLocal, 'removed locally'],
                ['skipped', result.summary.skipped, 'skipped'],
                ['refused', result.summary.refused, 'refused by the gate'],
                ['failed', result.summary.failed, 'failed'],
              ] as const).filter(([, n]) => n > 0).map(([k, n, label]) => (
                <span key={k} className={`cell ${k}`}><b>{num(n)}</b><i>{label}</i></span>
              ))}
            </div>
            {/* 🔴 Per-row outcomes, always. A single toast over N attempts is exactly how the 42
                unconfirmed rows became invisible. */}
            <ul className="h10-ngr-outcomes">
              {result.outcomes.map((o) => (
                <li key={o.adTargetId} className={o.kind}>
                  <span className="k">
                    {o.kind === 'retired' && o.delivery === 'enqueued' ? <Loader2 size={12} className="spin" /> : o.kind === 'removed_local' ? <Check size={12} /> : o.kind === 'refused' ? <ShieldAlert size={12} /> : o.kind === 'failed' ? <AlertTriangle size={12} /> : <Info size={12} />}
                    {o.kind === 'retired' ? 'queued for Amazon' : o.kind === 'removed_local' ? 'removed locally' : o.kind}
                  </span>
                  <span className="sc">{o.scope ? `${o.scope.level === 'CAMPAIGN' ? 'campaign-wide' : o.scope.adGroupName} · ${o.scope.campaignName}` : o.adTargetId}</span>
                  {o.reason && <span className="rs">{o.reason}</span>}
                </li>
              ))}
            </ul>
            {result.summary.retired > 0 && (
              <p className="h10-ngr-note">
                <Info size={13} />
                <span>
                  <b>Queued is not delivered.</b> The write gate runs in the worker, after this
                  response — it refuses any negation whose campaign is not on the live-write
                  allowlist. Re-open this term in a minute to see what Amazon actually did.
                </span>
              </p>
            )}
            <div className="h10-ngr-acts"><button type="button" className="h10-am-btn primary" onClick={close}>Done</button></div>
          </>
        ) : ctx ? (
          <>
            {/* ── already archived: no action, and say what we do and do not know ─────────── */}
            {rowClass === 'already-archived' ? (
              <>
                <p className="h10-ngr-msg">
                  <b>This negative is already archived at Amazon.</b> It was archived there and
                  mirrored in by the sync — not retired through this product — so there is nothing
                  to remove and no action is offered.
                </p>
                <p className="h10-ngr-note">
                  <Info size={13} />
                  <span>
                    We do not know <b>when</b> it was archived. The only date on the row is
                    <code> updatedAt</code>, which records the last ingest tick — all 62 archived
                    negatives share one — not the decision. Retirements made from here carry a real
                    <code> retiredAt</code>.
                  </span>
                </p>
                <div className="h10-ngr-acts"><button type="button" className="h10-am-btn" onClick={close}>Close</button></div>
              </>
            ) : (
              <>
                {/* ── the three facts, from term-context ────────────────────────────────── */}
                <p className="h10-ngr-lede">
                  {single ? (
                    <>
                      Stop blocking <b>“{ctx.term.display}”</b> in{' '}
                      <b>{single.level === 'CAMPAIGN' ? `${single.campaignName} (campaign-wide)` : `${single.campaignName} › ${single.adGroupName}`}</b>?
                    </>
                  ) : (
                    <>Remove <b>{num(writeCount)}</b> of this term’s <b>{num(ctx.spread.rows)}</b> negations?</>
                  )}
                </p>

                <p className="h10-ngr-facts">
                  {ctx.performance.orders > 0
                    ? <>This term earned <b>{eur(ctx.performance.salesCents)} from {num(ctx.performance.orders)} order{ctx.performance.orders === 1 ? '' : 's'}</b> in the last {ctx.window.days} days.</>
                    : ctx.history.orders > 0
                      ? <>This term took <b>no impressions in the last {ctx.window.days} days</b>, and earned <b>{eur(ctx.history.salesCents)} from {num(ctx.history.orders)} order{ctx.history.orders === 1 ? '' : 's'}</b> in the {ctx.history.days} days before that.</>
                      : <>This term has <b>no orders in {ctx.history.days} days</b> ({num(ctx.history.impressions)} impressions).</>}
                  {' '}
                  It runs in <b>{num(ctx.runsIn.length)}</b> ad group{ctx.runsIn.length === 1 ? '' : 's'} and{' '}
                  {ctx.overlap.length === 0
                    ? <>overlaps none of the {num(ctx.comparable.negatedAdGroups)} that negate it — the negative is routing the term, not blocking it.</>
                    : <>overlaps <b>{num(ctx.overlap.length)}</b> of them ({num(ctx.overlapRows)} negation{ctx.overlapRows === 1 ? '' : 's'}).</>}
                </p>

                {/* 🔴 The remainder sentence, verbatim from NEG.2 — the guard that stops a scoped
                    removal reading as "I have unblocked this term". */}
                {ctx.spread.rows - writeCount > 0 && (
                  <p className="h10-ngr-rem">
                    <AlertTriangle size={13} />
                    <span>
                      <b>{num(ctx.spread.rows - writeCount)} other negation{ctx.spread.rows - writeCount === 1 ? '' : 's'} of this term will keep blocking it</b>
                      {!ctx.remainder.scopeIsWholeAccount && ctx.remainder.remainderRows > 0 && <>, {num(ctx.remainder.remainderRows)} of them in {num(ctx.remainder.remainderCampaigns)} campaign{ctx.remainder.remainderCampaigns === 1 ? '' : 's'} outside your scope</>}.
                    </span>
                  </p>
                )}

                {ctx.term.protectedBy.length > 0 && (
                  <p className="h10-ngr-note">
                    <ShieldAlert size={13} />
                    <span>This term is <b>protected</b> — no automation can negate it. Removing an existing negation is still yours to do.</span>
                  </p>
                )}

                {/* ── the variant copy ─────────────────────────────────────────────────── */}
                {rowClass === 'local-only' ? (
                  <p className="h10-ngr-note">
                    <Info size={13} />
                    <span><b>Amazon has never confirmed this negative.</b> Removing it deletes our record; nothing changes at Amazon.</span>
                  </p>
                ) : (
                  <p className="h10-ngr-warn">
                    <AlertTriangle size={13} />
                    <span>
                      <b>Archiving at Amazon cannot be undone.</b> There is no un-archive — re-negating
                      this term later creates a <b>new</b> negative.
                      {writeCount > 1 && <> This is <b>{num(writeCount)} separate writes</b>, each with its own outcome.</>}
                    </span>
                  </p>
                )}

                {/* ── bulk: which rows ─────────────────────────────────────────────────── */}
                {!single && (
                  <div className="h10-ngr-pick" role="group" aria-label="Which negations">
                    {([
                      ['in-scope', `In your scope (${num(ctx.negations.filter((n) => n.inScope && n.status !== 'ARCHIVED').length)})`],
                      ['live', `Only the ones blocking now (${num(ctx.negations.filter((n) => n.blockingNow).length)})`],
                      ['all', `All of them (${num(ctx.negations.filter((n) => n.status !== 'ARCHIVED').length)})`],
                    ] as const).map(([v, label]) => (
                      <button key={v} type="button" className={`seg ${pick === v ? 'on' : ''}`} onClick={() => setPick(v)}>{label}</button>
                    ))}
                  </div>
                )}

                <label className="h10-ngr-reason">
                  <span>Why (optional, but it is the only record of the reason)</span>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. the funnel moved; this ad group should compete for it now" maxLength={500} />
                </label>

                <div className="h10-ngr-acts">
                  <button type="button" className="h10-am-btn" onClick={close} disabled={busy}>Keep {writeCount === 1 ? 'it' : 'them'}</button>
                  <button type="button" className="h10-am-btn danger" onClick={submit} disabled={busy || writeCount === 0}>
                    {busy ? <><Loader2 size={13} className="spin" /> Removing…</> : <><Trash2 size={13} /> {rowClass === 'local-only' ? 'Remove our record' : `Archive ${writeCount === 1 ? 'it' : `${num(writeCount)} negations`}`}</>}
                  </button>
                </div>
              </>
            )}
          </>
        ) : null}
      </div>
    </>
  )
}

/**
 * The write seam `slot-contract.ts` declared on day one, now filled.
 *
 * Only `onRowAction` is supplied. `selectionActions` stays null deliberately: §7 requires a bulk
 * action to be issued from the drawer against N explicit negation ids, never from a grid selection
 * bar over a term row — a term is not an Amazon object, and a selection bar over one would promise
 * a single write where there are N.
 */
export function negWriteActions(push: (patch: Record<string, string>) => void) {
  return {
    selectionActions: null,
    onRowAction: (row: NegationRow) => push({ retire: row.id }),
  }
}
