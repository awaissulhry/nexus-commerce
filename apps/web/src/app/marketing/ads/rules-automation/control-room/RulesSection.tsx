'use client'

/**
 * ACR.1.2b — the rules, inside the Control Room.
 *
 * The engines list above and this list are two halves of one question, and keeping them on
 * separate pages is what let the account look smaller than it is. A rule and a cron are both
 * "something that changes the account without asking me"; the operator should not need to
 * know which implementation a given behaviour happens to use in order to find its switch.
 *
 * The dial is per rule and unchanged in meaning from the board this absorbs — Off · Observe ·
 * Propose · Auto. Notches ABOVE a rule's graduation ceiling render disabled rather than
 * hidden, carrying the reason as a tooltip, because a control you cannot use is only
 * frustrating if it refuses to say why.
 */

import { useCallback, useEffect, useState } from 'react'
import { Zap, Eye, MessageSquare, Power, ShieldAlert, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type Level = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'
const LEVELS: Level[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']
const RANK: Record<Level, number> = { OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 }

const META: Record<Level, { label: string; Icon: typeof Zap; hint: string }> = {
  OFF: { label: 'Off', Icon: Power, hint: 'Does not evaluate.' },
  OBSERVE: { label: 'Observe', Icon: Eye, hint: 'Runs and records. No proposal, no write.' },
  PROPOSE: { label: 'Propose', Icon: MessageSquare, hint: 'Queues a suggestion. Nothing reaches Amazon until you accept.' },
  AUTO: { label: 'Auto', Icon: Zap, hint: 'Acts on its own, inside its caps and the write gate.' },
}

interface Rule {
  id: string; name: string; marketplace: string | null
  level: Level; ceiling: Level; ceilingReason: string
  actionTypes: string[]
  caps: { perDay: number | null; perExecutionCents: number | null; perDayCents: number | null }
  week: { acted: number; proposed: number; failed: number }
  lastExecutedAt: string | null
}

const ago = (iso: string | null) => {
  if (!iso) return 'never run'
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'ran just now'
  return h < 24 ? `ran ${h}h ago` : `ran ${Math.floor(h / 24)}d ago`
}

export function RulesSection() {
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [protectedTerms, setProtectedTerms] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`rules: ${r.status}`)
      const j = await r.json()
      setRules(Array.isArray(j?.items) ? (j.items as Rule[]) : [])
      setProtectedTerms(Number(j?.protectedTerms ?? 0))
      setErr(null)
    } catch (e) { setErr((e as Error).message); setRules([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  const setLevel = async (rule: Rule, level: Level) => {
    if (busy || level === rule.level) return
    setBusy(rule.id); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
      })
      if (!r.ok) {
        // 409 is the server refusing to exceed the graduation ceiling — a deliberate policy,
        // not a failure, so it gets the policy's own words. The route returns the reason on
        // `message` (`{ok:false, error:'above_ceiling', maxLevel, message, blockedBy}`);
        // reading `reason` here would have silently fallen back to generic copy forever.
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string }
        throw new Error(
          r.status === 409
            ? (j.message ?? 'That level is above this rule’s ceiling.')
            : (j.error ?? `Could not change level (${r.status})`),
        )
      }
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  if (rules === null) return <div className="acr-empty">Loading rules…</div>

  const acting = rules.filter((r) => r.level === 'AUTO').length
  const asking = rules.filter((r) => r.level === 'PROPOSE').length

  return (
    <section className="acr-rules">
      <div className="acr-sec-head">
        <h2>Rules</h2>
        <span className="acr-sec-count">
          {rules.length} total · {acting} acting · {asking} asking first
        </span>
      </div>

      {err && <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>}

      {protectedTerms === 0 && (
        <div className="acr-banner warn">
          <ShieldAlert size={15} />
          No protected terms are configured. Rules that negate search terms stay capped at
          Propose until a whitelist exists — otherwise a brand term could be negated with
          nothing to stop it.
        </div>
      )}

      <ul className="acr-list">
        {rules.map((r) => (
          <li key={r.id} className="acr-row rule">
            <div className="acr-row-main">
              <div className="acr-row-name">
                <strong>{r.name}</strong>
                {r.marketplace && <span className="acr-tag">{r.marketplace}</span>}
              </div>
              <p className="acr-what">
                {r.actionTypes.length ? r.actionTypes.join(' · ') : 'alert only'}
              </p>
              <p className="acr-why">
                {r.week.acted} acted · {r.week.proposed} proposed
                {r.week.failed > 0 ? ` · ${r.week.failed} failed` : ''} this week — {ago(r.lastExecutedAt)}
                {r.caps.perDay != null ? ` · max ${r.caps.perDay}/day` : ''}
                {r.caps.perDayCents != null ? ` · €${(r.caps.perDayCents / 100).toFixed(0)}/day` : ''}
              </p>
              {RANK[r.ceiling] < RANK.AUTO && (
                <p className="acr-ceiling"><ShieldAlert size={13} /> {r.ceilingReason}</p>
              )}
            </div>

            <div className="acr-dial" role="group" aria-label={`Autonomy level for ${r.name}`}>
              {LEVELS.map((lv) => {
                const M = META[lv]
                const above = RANK[lv] > RANK[r.ceiling]
                const on = r.level === lv
                return (
                  <button
                    key={lv}
                    type="button"
                    className={`acr-notch ${on ? 'on' : ''} ${lv.toLowerCase()}`}
                    aria-pressed={on}
                    disabled={above || busy === r.id}
                    // Disabled notches keep their reason: a control that refuses silently
                    // is the thing that makes an operator distrust the whole surface.
                    title={above ? r.ceilingReason : M.hint}
                    onClick={() => void setLevel(r, lv)}
                  >
                    <M.Icon size={12} /> {M.label}
                  </button>
                )
              })}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
