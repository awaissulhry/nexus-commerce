'use client'

/**
 * The shared "rules as declared exceptions" section — BID.S7's shape, generalised so the other
 * tabs retire their interim `RuleListTab` mounts onto ONE implementation instead of forking it.
 *
 * Membership is `ruleBelongsToTab(actions, tabKey)` — the SAME predicate the tab badge counts
 * with, so the badge and this section cannot disagree. Each row answers the governance questions:
 * may it act (off / observe / propose / auto, with `maxValueCentsEur = 0` surfaced as INERT — a
 * €0 cap refuses every action, even notify), where (an unbound scope prints account-wide in
 * bold), how hard (both caps), and has it (executions).
 *
 * One owner: the rule RECORD (conditions, simulate, history, edit, delete) lives on Automations —
 * every name links to `?rule=` there. Creation stays one click into the builder, because keeping
 * custom rules first-class is the operator's standing requirement. Nothing here writes.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, Plus, ShieldCheck } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ruleBelongsToTab } from './tabs'
import { NoDataIllus } from './NoDataIllus'

interface RuleRow {
  id: string
  name: string
  enabled: boolean
  autonomyLevel: string
  actions: unknown
  scopeMarketplace: string | null
  scopePortfolioId: string | null
  scopeCampaignId: string | null
  scopeProductId: string | null
  maxWritesPerDay: number | null
  maxValueCentsEur: number | null
  executionCount: number
}

const num = (n: number) => n.toLocaleString('en-IE')

function postureOf(r: RuleRow): { word: string; cls: string; tip: string } {
  if (!r.enabled) return { word: 'off', cls: 'off', tip: 'Disabled — never evaluated.' }
  if (r.maxValueCentsEur === 0) return { word: 'inert', cls: 'inert', tip: 'Enabled, but a per-action value cap of €0 refuses every action — even notify. This rule can do nothing until the cap moves (set it on Automations).' }
  const lvl = r.autonomyLevel || 'PROPOSE'
  if (lvl === 'AUTO') return { word: 'auto', cls: 'auto', tip: 'Acts on its own, inside its caps and the write gate.' }
  if (lvl === 'OBSERVE') return { word: 'observe', cls: 'observe', tip: 'Evaluates and records what it would do. No proposal, no write.' }
  return { word: 'propose', cls: 'propose', tip: 'Queues a suggestion for approval; writes nothing itself.' }
}

function scopeOf(r: RuleRow): { word: string; loud: boolean } {
  if (r.scopeCampaignId) return { word: 'one campaign', loud: false }
  if (r.scopeProductId) return { word: 'one product line', loud: false }
  if (r.scopePortfolioId) return { word: 'one portfolio', loud: false }
  if (r.scopeMarketplace) return { word: r.scopeMarketplace, loud: false }
  return { word: 'account-wide', loud: true }
}

export function TabRules({ tabKey, heading, subject, builderHref, builderLabel, emptyLine, sectionId }: {
  /** the RULE_TAB_ACTION_TYPES key — membership and the badge share it */
  tabKey: string
  /** the section heading after "Rules — " */
  heading: string
  /** what a rule here is an exception TO, for the foot line */
  subject: string
  builderHref: string
  builderLabel: string
  emptyLine: string
  sectionId: string
}) {
  const [rules, setRules] = useState<RuleRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => {
        if (!alive) return
        const all = (j?.items ?? []) as RuleRow[]
        setRules(all.filter((r) => ruleBelongsToTab(r.actions, tabKey)))
        setErr(null)
      })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [tabKey])

  return (
    <section id={sectionId} className="h10-bd7">
      <h3>
        <ShieldCheck size={14} aria-hidden /> Rules — {heading}
        <a className="nds-btn primary" href={builderHref}><Plus size={13} aria-hidden /> {builderLabel}</a>
      </h3>

      {err != null ? (
        <p className="h10-bd8-err" role="alert"><AlertTriangle size={13} aria-hidden /> The rule list failed to load {err} — a failed read, not an empty list.</p>
      ) : rules == null ? (
        <p className="h10-bd8-muted">Loading…</p>
      ) : rules.length === 0 ? (
        <span className="h10-rr-empty">
          <NoDataIllus size={104} />
          <b>{emptyLine}</b>
          <a className="nds-btn primary" href={builderHref}><Plus size={13} aria-hidden /> Create Rule</a>
        </span>
      ) : (
        <>
          <div className="h10-bd8-scroll">
            <table className="h10-bd8-tbl">
              <thead><tr><th>Rule</th><th>May it act?</th><th>Where</th><th>Caps</th><th>Executions</th></tr></thead>
              <tbody>
                {rules.map((r) => {
                  const p = postureOf(r)
                  const s = scopeOf(r)
                  return (
                    <tr key={r.id}>
                      <td><Link className="h10-bd7-name" href={`/marketing/ads/rules-automation/automations?rule=${r.id}`} title="Open the rule record on Automations — conditions, simulate, history, edit">{r.name}</Link></td>
                      <td><span className={`h10-bd7-posture ${p.cls}`} title={p.tip}>{p.word}</span></td>
                      <td>{s.loud
                        ? <b title="No scope bound — this rule can reach every campaign the account holds. Bind one on Automations.">account-wide</b>
                        : s.word}</td>
                      <td className="nw" title="The two caps: writes per day (demotes to propose beyond it) and € per action (the gate refuses above it). Unset = that cap does not bind.">
                        {r.maxWritesPerDay != null ? `${num(r.maxWritesPerDay)}/day` : '—'}
                        {' · '}
                        {r.maxValueCentsEur != null ? (r.maxValueCentsEur === 0 ? '€0 ⚠' : `€${(r.maxValueCentsEur / 100).toFixed(0)}`) : '—'}
                      </td>
                      <td className="nw">{num(r.executionCount)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="h10-bd8-foot">
            The rule record — conditions, simulate, approve, edit, delete — lives on{' '}
            <Link href="/marketing/ads/rules-automation/automations">Automations <ExternalLink size={11} aria-hidden /></Link>; each name opens it there. This section only states who may act on {subject}.
          </p>
        </>
      )}
    </section>
  )
}
