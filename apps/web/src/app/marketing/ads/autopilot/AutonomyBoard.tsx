'use client'

/**
 * ADX N4 — the autonomy board.
 *
 * Ten rules act on this account without anyone asking, and until now none of it was
 * visible or adjustable from the interface: the dial lived only in the database. That is
 * the same shape as the problem this whole programme set out to fix, and Quartile's
 * documented failure mode names it — if automation makes the account too big to see, the
 * tool owes you a way to see it.
 *
 * Two things on one screen, deliberately:
 *   · the dial, so a rule can be moved a notch and moved back
 *   · what it has ACTUALLY done this week, so that move is made on evidence
 *
 * A rule capped below AUTO shows why, in the same row. The ceiling is not overridable
 * here — a rule that creates negatives stays gated because of what it does, not because
 * of how much evidence has accumulated — so the reason has to carry its own weight.
 *
 * Styling follows the h10-* language the rest of this console uses; nothing under
 * /marketing/ads imports the design system.
 */

import { useCallback, useEffect, useState } from 'react'
import { Shield, ShieldAlert, Zap, Eye, MessageSquare, Power, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import './autonomy-board.css'

type Level = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'
const LEVELS: Level[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']

const LEVEL_META: Record<Level, { label: string; hint: string; Icon: typeof Zap }> = {
  OFF: { label: 'Off', hint: 'Does not evaluate.', Icon: Power },
  OBSERVE: { label: 'Observe', hint: 'Runs and records. No proposal, no write.', Icon: Eye },
  PROPOSE: { label: 'Propose', hint: 'Queues a suggestion for you. Nothing reaches Amazon until you accept.', Icon: MessageSquare },
  AUTO: { label: 'Auto', hint: 'Acts on its own, inside its caps and the write gate.', Icon: Zap },
}

interface Rule {
  id: string; name: string; trigger: string; marketplace: string | null
  level: Level; ceiling: Level; ceilingReason: string; blockedBy: string[]
  actionTypes: string[]
  caps: { perDay: number | null; perExecutionCents: number | null; perDayCents: number | null }
  week: { acted: number; proposed: number; failed: number }
  lifetime: { evaluations: number; matches: number; executions: number }
  lastExecutedAt: string | null; lastMatchedAt: string | null; ageDays: number
}

const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
const eur = (c: number | null) => (c == null ? '—' : `€${(c / 100).toFixed(0)}`)

export function AutonomyBoard() {
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [protectedTerms, setProtectedTerms] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules`, { cache: 'no-store' })
      const j = await r.json()
      setRules(Array.isArray(j?.items) ? (j.items as Rule[]) : [])
      setProtectedTerms(Number(j?.protectedTerms ?? 0))
    } catch (e) { setErr((e as Error).message); setRules([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  const setLevel = async (rule: Rule, level: Level) => {
    if (busy) return
    setBusy(rule.id); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) { setErr(j?.message ?? j?.error ?? `HTTP ${r.status}`); return }
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  if (rules === null) return <div className="h10-ab"><div className="h10-hist-msg">Loading…</div></div>

  const auto = rules.filter((r) => r.level === 'AUTO')
  const proposing = rules.filter((r) => r.level === 'PROPOSE')
  const observing = rules.filter((r) => r.level === 'OBSERVE')
  const off = rules.filter((r) => r.level === 'OFF')

  const row = (r: Rule) => {
    const capped = r.ceiling !== 'AUTO'
    return (
      <li key={r.id} className={`h10-ab-row${capped ? ' capped' : ''}`}>
        <div className="h10-ab-main">
          <span className="h10-ab-name" title={r.name}>{r.name}</span>
          <span className="h10-ab-acts">
            {r.actionTypes.length ? r.actionTypes.join(' · ') : 'alert only'}
            {r.marketplace && <em className="h10-ab-mk">{r.marketplace}</em>}
          </span>
        </div>

        {/* The dial. A capped rule shows the unreachable notches disabled rather than
            hidden — otherwise "why can't I turn this on" has no answer on screen. */}
        <div className="h10-ab-dial" role="group" aria-label={`Autonomy for ${r.name}`}>
          {LEVELS.map((l) => {
            const allowed = LEVELS.indexOf(l) <= LEVELS.indexOf(r.ceiling)
            const on = r.level === l
            const { label, hint, Icon } = LEVEL_META[l]
            return (
              <button
                key={l} type="button"
                className={`h10-ab-notch${on ? ' on' : ''}`}
                disabled={!allowed || busy === r.id}
                title={allowed ? hint : r.ceilingReason}
                aria-pressed={on}
                onClick={() => void setLevel(r, l)}
              ><Icon size={11} /> {label}</button>
            )
          })}
        </div>

        {/* What it has actually done — the reason to trust it, or not. */}
        <div className="h10-ab-week" title={`${r.lifetime.matches} lifetime matches over ${r.ageDays} days`}>
          <span className="acted">{r.week.acted}</span> acted ·{' '}
          <span className="prop">{r.week.proposed}</span> proposed
          {r.week.failed > 0 && <> · <span className="fail">{r.week.failed}</span> failed</>}
          <em>{ago(r.lastExecutedAt)}</em>
        </div>

        <div className="h10-ab-caps" title="Daily action cap · per-day spend cap">
          {r.caps.perDay ?? '∞'}/day · {eur(r.caps.perDayCents)}
        </div>

        {capped && (
          <div className="h10-ab-why">
            <ShieldAlert size={12} />
            <span>{r.ceilingReason}</span>
          </div>
        )}
      </li>
    )
  }

  const group = (title: string, list: Rule[], tone: string) =>
    list.length === 0 ? null : (
      <section className="h10-ab-grp">
        <div className={`h10-ab-grp-hd ${tone}`}>{title} <b>{list.length}</b></div>
        <ul className="h10-ab-list">{list.map(row)}</ul>
      </section>
    )

  return (
    <div className="h10-ab">
      <div className="h10-ab-top">
        <div className="h10-ab-stat"><b>{auto.length}</b><span>acting on their own</span></div>
        <div className="h10-ab-stat"><b>{proposing.length}</b><span>asking first</span></div>
        <div className="h10-ab-stat"><b>{observing.length + off.length}</b><span>silent</span></div>
        <div className={`h10-ab-stat ${protectedTerms === 0 ? 'warn' : ''}`}>
          <b>{protectedTerms}</b><span>protected terms</span>
        </div>
      </div>

      {protectedTerms === 0 && (
        <div className="h10-ab-note">
          <AlertTriangle size={13} />
          <span>
            No protected terms. Rules that negate search terms stay capped at Propose until a
            whitelist exists — otherwise a brand term could be negated with nothing to stop it.
          </span>
        </div>
      )}
      {err && <div className="h10-ab-note bad"><AlertTriangle size={13} /><span>{err}</span></div>}

      {group('Acting on their own', auto, 'auto')}
      {group('Asking first', proposing, 'prop')}
      {group('Observing', observing, 'obs')}
      {group('Off', off, 'off')}

      <p className="h10-ab-foot">
        <Shield size={12} /> Every write also passes the gate: an 82-campaign allowlist, a
        per-campaign bid ceiling, protected terms, and a €500 per-payload cap. The dial decides
        whether a rule acts; the gate decides whether the account lets it.
      </p>
    </div>
  )
}
