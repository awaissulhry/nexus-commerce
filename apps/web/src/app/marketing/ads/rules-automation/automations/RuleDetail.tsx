'use client'

/**
 * RA.AUTO — one rule, in full: what it does, where it may do it, and what it has done.
 *
 * A drawer rather than an inline table row, for two reasons. `AdsDataGrid` has no row-expansion
 * hook and adding one would mean editing the shared DS grid every `/marketing/ads` page renders.
 * And the facts here lay out in LANES — definition, scope, caps, record — which a squeezed table
 * row cannot hold. `HistoryDrawer` on the rule-type tabs is already this section's drawer idiom.
 *
 * New classes are `h10-au-*`, not `h10-am-*`: that prefix is the app-wide Ads Manager grid
 * namespace defined across four stylesheets, and one namespace spanning two files is how source
 * order starts beating specificity. The DS button/link primitives (`h10-am-btn`, `h10-am-link`)
 * are reused as-is.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, Clock, GraduationCap, ShieldAlert, X } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'
import { conditionText, actionLines, triggerText } from './ruleText'
import type { Level } from './ModeNotches'

export interface Campaign { id: string; name: string; portfolioId?: string | null; marketplace?: string | null }
export interface Portfolio { portfolioId: string; name: string }

export interface Readiness {
  verdict: 'ready' | 'unreviewed' | 'unseen' | 'building' | 'failing' | 'capped'
  summary: string
  canGraduate: boolean
  evidence: { decisionWeeks: number; cleanWeeks: number; pending: number; failures: number; appliedEdited: number }
}

export interface DetailRule {
  id: string
  name: string
  description?: string | null
  trigger: string
  conditions?: unknown
  level: Level
  ceiling: Level
  ceilingReason: string
  writes: boolean
  actions?: unknown
  actionTypes: string[]
  scope: { kind: 'account' | 'portfolio' | 'campaign'; id: string | null; name: string | null }
  caps: { perDay: number | null; perExecutionCents: number | null; perDayCents: number | null }
  week: { acted: number; proposed: number; failed: number; capped: number }
  lifetime: { evaluations: number; matches: number; executions: number }
  lastExecutedAt: string | null
  ageDays: number | null
  marketplace: string | null
  categoryLabel: string
  categoryColor: string
}

const eur = (c: number | null) => (c == null ? null : `€${(c / 100).toFixed(2)}`)
const num = (n: number) => n.toLocaleString('en-IE')

export function RuleDetail({
  rule, campaigns, portfolios, readiness, conflicts, busy, onScope, onHistory, onClose,
}: {
  rule: DetailRule
  campaigns: Campaign[]
  portfolios: Portfolio[]
  readiness?: Readiness
  conflicts?: string[]
  busy: boolean
  onScope: (scope: { scopePortfolioId?: string | null; scopeCampaignId?: string | null }) => void
  onHistory: () => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<'account' | 'portfolio' | 'campaign'>(rule.scope.kind)
  const [pf, setPf] = useState(rule.scope.kind === 'portfolio' ? (rule.scope.id ?? '') : '')
  const [cp, setCp] = useState(rule.scope.kind === 'campaign' ? (rule.scope.id ?? '') : '')

  const cond = useMemo(() => conditionText(rule.conditions), [rule.conditions])
  // `actionTypes` is the fallback, never the primary: it is filtered and parameterless, so it can
  // say WHAT a rule does but not by how much. See actionLines' own note.
  const then = useMemo(() => actionLines(rule.actions, rule.actionTypes), [rule.actions, rule.actionTypes])

  /**
   * Law 4 — never offer a scope without stating its reach.
   *
   * Portfolio is the weakest grain in this account, not the strongest: only 72 of 220 campaigns
   * carry a portfolioId, so a portfolio binding is unreachable for two thirds of the account.
   * That is not a footnote — it decides whether the binding is worth making at all.
   */
  const reach = useMemo(() => {
    if (kind === 'campaign') return cp ? 1 : 0
    if (kind === 'portfolio') return pf ? campaigns.filter((c) => String(c.portfolioId ?? '') === pf).length : 0
    return campaigns.length
  }, [kind, pf, cp, campaigns])

  const unportfolioed = useMemo(() => campaigns.filter((c) => !c.portfolioId).length, [campaigns])

  const dirty =
    kind !== rule.scope.kind ||
    (kind === 'portfolio' && pf !== (rule.scope.id ?? '')) ||
    (kind === 'campaign' && cp !== (rule.scope.id ?? ''))

  const canApply = dirty && (kind === 'account' || (kind === 'portfolio' && !!pf) || (kind === 'campaign' && !!cp))

  const apply = () => {
    if (kind === 'account') onScope({ scopePortfolioId: null, scopeCampaignId: null })
    else if (kind === 'portfolio') onScope({ scopePortfolioId: pf || null, scopeCampaignId: null })
    else onScope({ scopeCampaignId: cp || null, scopePortfolioId: null })
  }

  const caps = [
    rule.caps.perDay != null ? `${rule.caps.perDay} executions per day` : null,
    rule.caps.perExecutionCents != null ? `${eur(rule.caps.perExecutionCents)} per execution` : null,
    rule.caps.perDayCents != null ? `${eur(rule.caps.perDayCents)} per day` : null,
  ].filter(Boolean) as string[]

  return (
    <div className="h10-au-back" onClick={onClose}>
      <div className="h10-au-drawer" role="dialog" aria-modal="true" aria-label={`Automation — ${rule.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="h10-au-dh">
          <div>
            <b>
              <span className="h10-au-swatch" style={{ background: rule.categoryColor }} aria-hidden />
              {rule.name}
            </b>
            <span>{rule.categoryLabel}{rule.marketplace ? ` · ${rule.marketplace}` : ''}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} aria-hidden /></button>
        </div>

        <div className="h10-au-db">
          {conflicts && conflicts.length > 0 && (
            <p className="h10-au-conf" role="alert">
              <AlertTriangle size={13} aria-hidden /> {conflicts.join(' · ')}
            </p>
          )}

          <section className="h10-au-def">
            <div className="h10-au-defrow">
              <span className="k">When</span>
              <span className="v">{triggerText(rule.trigger)}</span>
            </div>
            <div className="h10-au-defrow">
              <span className="k">If</span>
              {/* An unconditional rule is a fact about it, not a missing value. Measured: 24 of
                  51 rules carry no conditions at all and fire on every tick of their trigger. */}
              <span className={`v${cond.unconditional ? ' muted' : ''}`}>{cond.text}</span>
            </div>
            <div className="h10-au-defrow">
              <span className="k">Then</span>
              <span className="v">
                {then.length === 0
                  ? <em className="muted">no actions — this rule does nothing</em>
                  : (
                    <ul className="h10-au-acts">
                      {then.map((a, i) => (
                        <li key={`${a.type}-${i}`} className={a.writes ? 'writes' : ''}>
                          <span className={`h10-au-dot ${a.writes ? 'w' : 'n'}`} aria-hidden />
                          <span>
                            {a.label}
                            {a.detail && <em> — {a.detail}</em>}
                            {!a.writes && <span className="h10-au-nowrite">never reaches Amazon</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
              </span>
            </div>
            {rule.description && <p className="h10-au-desc">{rule.description}</p>}
          </section>

          {readiness && readiness.verdict !== 'capped' && (
            <p className={`h10-au-grad ${readiness.verdict}`}>
              {readiness.canGraduate && <GraduationCap size={13} aria-hidden />}
              <span>{readiness.summary}</span>
            </p>
          )}
          {rule.ceiling !== 'AUTO' && (
            <p className="h10-au-ceiling">
              <ShieldAlert size={13} aria-hidden /> <span>{rule.ceilingReason}</span>
            </p>
          )}

          <div className="h10-au-lanes">
            <section className="h10-au-lane">
              <h4>Scope</h4>
              <div className="h10-au-scopeform">
                <H10Select
                  width={140}
                  ariaLabel="Scope grain"
                  value={kind}
                  onChange={(v) => setKind(v as 'account' | 'portfolio' | 'campaign')}
                  options={[
                    { value: 'account', label: 'Whole account' },
                    { value: 'portfolio', label: 'One portfolio' },
                    { value: 'campaign', label: 'One campaign' },
                  ]}
                />
                {kind === 'portfolio' && (
                  <H10Select
                    width={210} searchable ariaLabel="Portfolio" value={pf} onChange={setPf}
                    options={portfolios.map((p) => ({ value: p.portfolioId, label: p.name }))}
                  />
                )}
                {kind === 'campaign' && (
                  <H10Select
                    width={240} searchable ariaLabel="Campaign" value={cp} onChange={setCp}
                    options={campaigns.map((c) => ({ value: c.id, label: c.name }))}
                  />
                )}
              </div>
              {/* The reach, before the action rather than after it. */}
              <p className="h10-au-reach">
                Would reach <b>{num(reach)}</b> of {num(campaigns.length)} campaigns.
                {kind === 'portfolio' && unportfolioed > 0 && (
                  <> {num(unportfolioed)} campaigns carry no portfolio at all, so no portfolio
                    binding can ever reach them.</>
                )}
              </p>
              {canApply && (
                <button type="button" className="h10-am-btn primary sm" disabled={busy} onClick={apply}>
                  {busy ? 'Binding…' : `Bind to ${kind === 'account' ? 'the whole account' : `this ${kind}`}`}
                </button>
              )}
              {/* One feature, two routes — stated rather than silently missing. */}
              <p className="h10-au-note">
                Market scope lives on a different route and is not editable here
                {rule.marketplace ? <> — this rule is pinned to <b>{rule.marketplace}</b>.</> : '.'}
              </p>
            </section>

            <section className="h10-au-lane">
              <h4>Caps</h4>
              {caps.length
                ? <ul className="h10-au-list">{caps.map((c) => <li key={c}>{c}</li>)}</ul>
                : <p className="h10-au-note">No per-rule caps — only the account write gate bounds it.</p>}
              {rule.week.capped > 0 && (
                <p className="h10-au-capped">
                  <ShieldAlert size={13} aria-hidden />
                  <span>
                    Its daily cap declined to run it <b>{num(rule.week.capped)}</b> times this week
                    {rule.week.acted > 0 ? <>, against {num(rule.week.acted)} runs that went ahead</> : null}.
                    That is the cap deciding how much of the account this rule reaches — not the rule.
                  </span>
                </p>
              )}
            </section>

            <section className="h10-au-lane">
              <h4>Record</h4>
              <ul className="h10-au-list">
                <li>{num(rule.week.acted)} acted · {num(rule.week.proposed)} proposed{rule.week.failed > 0 ? ` · ${num(rule.week.failed)} failed` : ''} this week</li>
                <li>{num(rule.lifetime.evaluations)} evaluations, {num(rule.lifetime.matches)} matches, {num(rule.lifetime.executions)} executions all time</li>
                <li>Last run {rule.lastExecutedAt ? new Date(rule.lastExecutedAt).toLocaleString('en-IE') : 'never'}{rule.ageDays != null ? ` · ${rule.ageDays} days old` : ''}</li>
              </ul>
              <button type="button" className="h10-am-btn sm" onClick={onHistory}>
                <Clock size={12} aria-hidden /> Execution history
              </button>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
