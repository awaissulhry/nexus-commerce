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

import { useMemo } from 'react'
import { AlertTriangle, Clock, GraduationCap, ShieldAlert, X } from 'lucide-react'
import { ScopeForm, type ScopeOptions, type ScopeValue } from './ScopeForm'
import { conditionText, actionLines, triggerText } from './ruleText'
import type { Level } from './ModeNotches'

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
  scope: {
    kind: 'account' | 'portfolio' | 'campaign'
    id: string | null
    name: string | null
    /** RA.GRAIN — the fourth grain, resolved to a name by the server. */
    product?: { id: string; sku: string | null; name: string | null; isLine: boolean; variations: number; variationsInCatalogue?: number; missing: boolean } | null
  }
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
  rule, scopeOptions, readiness, conflicts, busy, onScope, onHistory, onClose,
}: {
  rule: DetailRule
  /** RA.GRAIN — one payload feeds every grain's picker AND the local reach maths. */
  scopeOptions: ScopeOptions | null
  readiness?: Readiness
  conflicts?: string[]
  busy: boolean
  onScope: (scope: ScopeValue) => void
  onHistory: () => void
  onClose: () => void
}) {
  const cond = useMemo(() => conditionText(rule.conditions), [rule.conditions])
  // `actionTypes` is the fallback, never the primary: it is filtered and parameterless, so it can
  // say WHAT a rule does but not by how much. See actionLines' own note.
  const then = useMemo(() => actionLines(rule.actions, rule.actionTypes), [rule.actions, rule.actionTypes])

  const caps = [
    rule.caps.perDay != null ? `${rule.caps.perDay} execution${rule.caps.perDay === 1 ? '' : 's'} per day` : null,
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
                            {/* A parameter the engine will refuse. Named on the rule, because a
                                refusal that only appears in execution history is a refusal nobody
                                reads until they are already wondering why nothing happened. */}
                            {a.problem && (
                              <span className="h10-au-problem">
                                <AlertTriangle size={11} aria-hidden /> {a.problem}
                              </span>
                            )}
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

          {/* RA.GRAIN — scope gets the full width, because it is now two rows of controls (market ×
              campaigns, and products) rather than one dropdown. All four grains, one form, one
              Bind — which is the symmetry the operator asked for. */}
          <section className="h10-au-lane wide">
            <h4>Scope — where this rule may act</h4>
            <ScopeForm
              options={scopeOptions}
              current={{
                scopeMarketplace: rule.marketplace,
                scopePortfolioId: rule.scope.kind === 'portfolio' ? rule.scope.id : null,
                scopeCampaignId: rule.scope.kind === 'campaign' ? rule.scope.id : null,
                scopeProductId: rule.scope.product?.id ?? null,
              }}
              busy={busy}
              onApply={onScope}
            />
            {rule.scope.product?.missing && (
              <p className="h10-au-problem">
                <AlertTriangle size={11} aria-hidden />
                This rule is bound to a product that no longer exists in the catalogue, so it covers
                nothing. Rebind it or clear the product scope.
              </p>
            )}
            {/* The limitation, stated where the control is rather than discovered afterwards. */}
            {rule.scope.product && !rule.scope.product.missing && (
              <p className="h10-au-note">
                <span>
                  Bound to <b>{rule.scope.product.sku}</b>
                  {rule.scope.product.isLine
                    ? <> — the whole line, {rule.scope.product.variations} advertised variation
                      {rule.scope.product.variations === 1 ? '' : 's'}
                      {rule.scope.product.variationsInCatalogue != null
                        && rule.scope.product.variationsInCatalogue > rule.scope.product.variations
                        && <> of {rule.scope.product.variationsInCatalogue} in the catalogue; the rest are
                          advertised nowhere, so no binding can reach them</>}.</>
                    : <> — one variation.</>}
                  {' '}Product scope decides which <b>campaigns</b> this rule may act on. It does not
                  narrow the action to that product&rsquo;s targets — a bid change still moves every
                  target in a matching campaign, because that is the grain the actions work at.
                </span>
              </p>
            )}
          </section>

          <div className="h10-au-lanes">
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
