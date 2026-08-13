'use client'

/**
 * NEG.7 — what can create a negative here, how much one execution would touch, and whether arming
 * it is defensible yet.
 *
 * 🔴 READ-ONLY, and that is the design. No mode dial, no enable/disable, no ceiling lift, no scope
 * form. Automations (tab 10) owns all three controls; this page owns the CONSEQUENCES of the rules
 * — what they would create, where, and whether the preconditions hold. Every control here is a
 * link out to where the change is actually made.
 *
 * ── The blast radius is two numbers, and the second one is the story ─────────────────────────
 *
 * **Capability** is what one execution could touch: `sync_negatives_across_campaigns` writes one
 * campaign-level negative per ENABLED campaign in a marketplace — 74 in IT, at a cap of 20/day.
 * **Observed** is what it actually does, read from its own execution rows. For three of the five
 * enabled rules that number is zero: they fail a precondition before reaching the write, and the
 * widest-radius rule in the section is one of them.
 *
 * Showing only the capability overstates the risk. Showing only the observation understates it —
 * the sync rule is one context fix away from its full radius. Both go on the row.
 *
 * ── No single verdict ────────────────────────────────────────────────────────────────────────
 *
 * Six conditions, six pieces of computed evidence, and the operator decides. `ads-graduation-readiness`
 * states the principle this follows: the UI must never infer readiness from a verdict string.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle, Check, Info, WifiOff, ChevronRight, ExternalLink, ShieldCheck, Ban,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { NegSlotProps } from './slot-contract'

interface Ceiling { maxLevel: string; reason: string; blockedBy: string[] }
interface Blast {
  kind: 'per-marketplace-campaigns' | 'one-campaign-negative' | 'not-determinable'
  perExecution: number | null
  unit: string
  perDayAtCap: number | null
  byMarket: Array<{ market: string; count: number }>
  explanation: string
}
interface Observed {
  wouldNegate: number | null
  attempts: number
  reached: number
  refused: number
  topRefusal: string | null
  neverReaches: boolean
}
interface RuleRow {
  id: string; name: string; enabled: boolean; autonomyLevel: string; trigger: string
  actionTypes: string[]; actionsWithoutHandler: string[]
  ceiling: Ceiling; atCeiling: boolean
  scope: { marketplace: string | null; portfolioId: string | null; campaignId: string | null; productId: string | null; isAccountWide: boolean }
  reachesCurrentScope: boolean
  maxExecutionsPerDay: number | null; maxValueCentsEur: number | null
  executionCount: number; lastEvaluatedAt: string | null; lastMatchedAt: string | null
  protectConverting: { resolved: boolean; keyPresent: boolean; source: string }
  blast: Blast
  observed: Observed
  activity: { windowDays: number; total: number; succeeded: number; refusedByCap: number; otherErrors: number; dryRuns: number }
}
interface Condition {
  n: number; label: string; state: 'closed' | 'open'
  evidence: string; actionHref: string | null; actionLabel: string | null; operatorWork: boolean
}
interface Payload {
  scope: { boundBy: string; market: string; campaignsInScope: number }
  rules: RuleRow[]
  totals: { onTab: number; enabled: number; atAuto: number; accountWide: number; rulesInAccount: number; scopedAnywhere: number }
  readiness: Condition[]
  phantomActions: Array<{ action: string; onTab: boolean; ceilinged: boolean; hasHandler: boolean; consequence: string }>
  capCounter: { trustworthy: boolean; note: string }
  coverage: { rulesRead: number; executionsRead: number; campaignsRead: number }
}

const num = (n: number) => n.toLocaleString('en-IE')
const dayMonth = (iso: string | null) => {
  if (!iso) return 'never'
  const d = new Date(iso)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}
const BUILDER = '/marketing/ads/rules-automation/builder/negative-targeting'
const AUTOMATIONS = '/marketing/ads/rules-automation/automations'

export function NegRules({ scope, push }: NegSlotProps) {
  // 🔴 `useSearchParams`, never `window.location.search` — not reactive under soft navigation,
  // which is how NEG.3b's confirm dialog silently never opened.
  const params = useSearchParams()
  const openRule = params.get('rule')

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const p = new URLSearchParams({ market: scope.market })
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup })) if (v) p.set(k, v)
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/negatives/rules?${p.toString()}`, { cache: 'no-store' })
      if (r.status === 404) {
        const b = await r.json().catch(() => ({} as { code?: string; error?: string }))
        // Our 404 and Fastify's route-missing 404 are both 404 — discriminate on the code.
        throw new Error(b?.code ? String(b.error) : 'This view is not available yet — the rules read is not deployed on this environment.')
      }
      if (!r.ok) throw new Error(`Could not load the rules (${r.status})`)
      setData((await r.json()) as Payload)
      setErr(null)
    } catch (e) {
      // 🔴 Never `.catch(() => [])`. An empty rule list reads as "nothing can negate here", which
      // is the most reassuring possible lie on a page about automated negation.
      setErr((e as Error).message)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [scope.market, scope.line, scope.portfolio, scope.campaign, scope.adGroup])

  useEffect(() => { void load() }, [load])

  if (loading && !data) {
    return (
      <section id="rules" className="h10-ngr7">
        <header className="h10-ngr7-head"><h3>The rules that can negate here</h3></header>
        <p className="h10-ngr7-msg">Reading the rules, their ceilings and their execution history…</p>
      </section>
    )
  }

  // Empty state 4 of 4 — the read failed. Deliberately not an empty list.
  if (err || !data) {
    return (
      <section id="rules" className="h10-ngr7">
        <header className="h10-ngr7-head"><h3>The rules that can negate here</h3></header>
        <p className="h10-ngr7-bad">
          <WifiOff size={13} />
          <span>
            <b>Could not read the rules.</b> {err ?? 'The request returned nothing.'} This is a
            failed read, not an absence of automation — an empty list would say the opposite of the
            truth, so nothing is shown.
          </span>
        </p>
      </section>
    )
  }

  const d = data
  const t = d.totals
  // 🔴 A zero here means the query failed, not that no rule exists.
  const readFailed = d.coverage.rulesRead === 0
  const scoped = scope.market !== 'all' || d.scope.boundBy !== 'market'
  const closed = d.readiness.filter((c) => c.state === 'closed').length
  const open = d.readiness.filter((c) => c.state === 'open')

  return (
    <section id="rules" className="h10-ngr7">
      <header className="h10-ngr7-head">
        <h3>The rules that can negate here</h3>
        <p>
          What can create a negative in this scope, how much <b>one execution</b> would touch, and
          whether arming any of it is defensible yet. This panel reports; every change is made in{' '}
          <a href={AUTOMATIONS}>Automations</a>.
        </p>
      </header>

      {readFailed ? (
        <p className="h10-ngr7-bad">
          <WifiOff size={13} />
          <span><b>No rules were read at all.</b> That is a failed query, not an account without automation.</span>
        </p>
      ) : t.onTab === 0 ? (
        /* Empty state 1 of 4 — genuinely nothing on this tab. */
        <p className="h10-ngr7-good">
          <Check size={13} />
          <span>
            <b>No rule in this account can create a negative.</b> All {num(t.rulesInAccount)}{' '}
            advertising rules were checked and none carries a negation action.
          </span>
        </p>
      ) : (
        <>
          {/* ── the scope sentence: this IS the finding ─────────────────────────────────────── */}
          <p className={`h10-ngr7-scope ${t.accountWide === t.onTab ? 'wide' : ''}`}>
            <AlertTriangle size={13} />
            <span>
              🔴 <b>All {t.onTab} rules are account-wide</b>, so {scoped
                ? <>narrowing to <b>{[scope.market !== 'all' ? scope.market : null, d.scope.boundBy !== 'market' ? `${num(d.scope.campaignsInScope)} campaigns` : null].filter(Boolean).join(' · ')}</b> does not change what can act here</>
                : <>every one of them reaches every campaign in the account</>}
              . Not one carries a marketplace, portfolio, campaign or product grain.
              {' '}({num(t.scopedAnywhere)} of {num(t.rulesInAccount)} advertising rules do carry a
              scope — a different denominator, and none of them is a negation rule.)
            </span>
          </p>

          {/* ── readiness: six rows, no single verdict ──────────────────────────────────────── */}
          <div className="h10-ngr7-sub">
            <b>Is arming these defensible yet?</b>
            <span>{closed} of {d.readiness.length} conditions closed</span>
          </div>
          <ul className="h10-ngr7-cond">
            {d.readiness.map((c) => (
              <li key={c.n} className={c.state}>
                <span className="i">{c.state === 'closed' ? <Check size={13} /> : <AlertTriangle size={13} />}</span>
                <span className="l">
                  <b>{c.n}. {c.label}</b>
                  <em>{c.evidence}</em>
                </span>
                <span className="a">
                  {c.state === 'open' && c.actionHref
                    ? <a className="h10-ngr7-act" href={c.actionHref}>{c.actionLabel} <ExternalLink size={11} /></a>
                    : <em className="done">closed</em>}
                </span>
              </li>
            ))}
          </ul>
          <p className="h10-ngr7-note">
            <Info size={13} />
            <span>
              {open.length === 0
                ? <>All six conditions are closed. Whether to arm anything is still an operator decision — this page does not make it.</>
                : <>The {open.length === 1 ? 'one remaining condition is' : `${open.length} remaining conditions are`}{' '}
                  <b>operator work, not engineering</b>: {open.map((c) => c.label.toLowerCase()).join(' and ')}. There is
                  deliberately no single “ready” verdict here — six pieces of evidence, and you decide.</>}
            </span>
          </p>

          {/* ── the rules ───────────────────────────────────────────────────────────────────── */}
          <div className="h10-ngr7-sub">
            <b>What can act</b>
            <span>{num(t.enabled)} of {num(t.onTab)} enabled · {num(t.atAuto)} on AUTO</span>
          </div>

          {/* Empty state 2 of 4 — rules exist but none is enabled. */}
          {t.enabled === 0 && (
            <p className="h10-ngr7-good">
              <Check size={13} />
              <span><b>None of the {num(t.onTab)} rules is enabled</b>, so nothing can act here today whatever its level says.</span>
            </p>
          )}

          <ul className="h10-ngr7-rules">
            {d.rules.map((r) => {
              const isOpen = openRule === r.id
              return (
                <li key={r.id} className={r.enabled ? '' : 'off'}>
                  <div className="rh">
                    <button
                      type="button" className="tw" aria-expanded={isOpen}
                      onClick={() => push({ rule: isOpen ? '' : r.id })}
                    >
                      <ChevronRight size={13} className={isOpen ? 'rot' : ''} />
                      <b>{r.name}</b>
                    </button>
                    <span className={`st ${r.enabled ? 'on' : ''}`}>{r.enabled ? 'enabled' : 'off'}</span>
                    <span className="lv">
                      {r.autonomyLevel}
                      {r.atCeiling && <em title={r.ceiling.reason}> · at ceiling</em>}
                    </span>
                    <span className="pc">
                      {r.protectConverting.resolved
                        ? <><ShieldCheck size={11} /> converting terms protected</>
                        : <><Ban size={11} /> converting terms NOT protected</>}
                    </span>
                    <span className="rd">
                      {r.blast.perExecution != null
                        ? <>touches <b>{num(r.blast.perExecution)}</b> per run</>
                        : r.observed.wouldNegate != null
                          ? <>last run: <b>{num(r.observed.wouldNegate)}</b></>
                          : <em>radius not determinable</em>}
                    </span>
                    <span className="cp">cap {r.maxExecutionsPerDay ?? '—'}/day</span>
                  </div>

                  {r.observed.neverReaches && (
                    <p className="never">
                      🔴 <b>Never reaches its write.</b> {num(r.observed.attempts)} attempts in the
                      last {r.activity.windowDays} days, <b>none</b> of which got past its own
                      precondition — “{r.observed.topRefusal}”. Its radius below is what it{' '}
                      <i>could</i> do, not what it has done.
                    </p>
                  )}

                  {isOpen && (
                    <div className="rb">
                      <div className="blk">
                        <em>Blast radius</em>
                        <p>{r.blast.explanation}</p>
                        {r.blast.byMarket.length > 0 && (
                          <p className="mk">
                            {r.blast.byMarket.map((m) => (
                              <span key={m.market}><b>{m.market}</b> {num(m.count)}</span>
                            ))}
                            <i>ENABLED campaigns per marketplace — one execution never spans two, so these do not add up.</i>
                          </p>
                        )}
                        {r.blast.perDayAtCap != null && (
                          <p className="cap">
                            At its cap of <b>{r.maxExecutionsPerDay}</b> executions a day that is up
                            to <b>{num(r.blast.perDayAtCap)}</b> {r.blast.unit} a day.
                          </p>
                        )}
                      </div>

                      <div className="blk">
                        <em>What it actually did, last {r.activity.windowDays} days</em>
                        <ul className="facts">
                          <li><span>Execution rows</span><b>{num(r.activity.total)}</b></li>
                          <li><span>Refused by its daily cap</span><b>{num(r.activity.refusedByCap)}</b></li>
                          <li><span>Dry runs (it is on {r.autonomyLevel})</span><b>{num(r.activity.dryRuns)}</b></li>
                          <li><span>Wrote something</span><b>{num(r.activity.succeeded)}</b></li>
                          {r.observed.attempts > 0 && (
                            <li className={r.observed.neverReaches ? 'bad' : ''}>
                              <span>Negation attempts that reached the write</span>
                              <b>{num(r.observed.reached)} of {num(r.observed.attempts)}</b>
                            </li>
                          )}
                        </ul>
                        <p className="hint">
                          🔴 A refusal is not a failure and an execution is not a write. These are
                          four different counts and the cap is doing most of the work.
                        </p>
                      </div>

                      <div className="blk">
                        <em>Why it cannot be raised</em>
                        <p>{r.ceiling.reason}</p>
                        <p className="mk">
                          <span>ceiling <b>{r.ceiling.maxLevel}</b></span>
                          <span>trigger <b>{r.trigger}</b></span>
                          <span>scope <b>{r.scope.isAccountWide ? 'account-wide' : [r.scope.marketplace, r.scope.portfolioId, r.scope.campaignId, r.scope.productId].filter(Boolean).join(' · ')}</b></span>
                          <span>last matched <b>{dayMonth(r.lastMatchedAt)}</b></span>
                        </p>
                        <p className="hint">
                          {r.protectConverting.keyPresent
                            ? <>The rule sets <b>protect converting terms</b> explicitly.</>
                            : <>The <b>protect converting terms</b> key is absent on this rule, and absent is the default, which is <b>ON</b>. It predates the switch.</>}
                        </p>
                        {r.actionsWithoutHandler.length > 0 && (
                          <p className="hint bad">🔴 Uses <b>{r.actionsWithoutHandler.join(', ')}</b>, which has no handler — every execution fails.</p>
                        )}
                        <div className="lnks">
                          <a className="h10-ngr7-act" href={`${BUILDER}?ruleId=${r.id}`}>Open in the builder <ExternalLink size={11} /></a>
                          <a className="h10-ngr7-act" href={AUTOMATIONS}>Change its level or scope <ExternalLink size={11} /></a>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          {/* Empty state 3 of 4 — no execution history to judge by. */}
          {d.coverage.executionsRead === 0 && (
            <p className="h10-ngr7-msg neutral">
              <b>No execution history in the last 60 days.</b> The rules above are described by their
              configuration only — nothing here says what they have actually done, because they have
              not run.
            </p>
          )}

          {/* ── the two things that are true but easy to miss ───────────────────────────────── */}
          {!d.capCounter.trustworthy && (
            <p className="h10-ngr7-note">
              <AlertTriangle size={13} />
              <span>🔴 <b>The daily-cap counter is broken.</b> {d.capCounter.note}</span>
            </p>
          )}
          {d.phantomActions.filter((a) => !a.hasHandler).map((a) => (
            <p key={a.action} className="h10-ngr7-note">
              <AlertTriangle size={13} />
              <span>
                🔴 <b>{a.action}</b> is offered on this tab and has a ceiling, but <b>no handler
                exists for it</b>. {a.consequence} No rule uses it today, and nothing here creates
                one.
              </span>
            </p>
          ))}
          <p className="h10-ngr7-note">
            <Info size={13} />
            <span>
              This panel changes nothing. Levels, ceilings, scopes and the proposal queue all live in{' '}
              <a href={AUTOMATIONS}>Automations</a>; what belongs here is what a rule would{' '}
              <b>do to your negatives</b>. Read over {num(d.coverage.rulesRead)} advertising rules
              and {num(d.coverage.executionsRead)} execution rows.
            </span>
          </p>
        </>
      )}
    </section>
  )
}
