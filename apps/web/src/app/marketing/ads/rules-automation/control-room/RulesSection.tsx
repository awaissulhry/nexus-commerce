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
import { Button } from '@/design-system/primitives'
import { Zap, Eye, MessageSquare, Power, ShieldAlert, AlertTriangle, GraduationCap } from 'lucide-react'
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
  /* Carried over from the autonomy board this section replaces: how long the rule has existed
     and how often it has ever matched. A rule acting on its own after 3 matches in 90 days is a
     different proposition from one acting after 300, and the week counts cannot show that. */
  lifetime?: { matches?: number } | null
  ageDays?: number | null
}

const ago = (iso: string | null) => {
  if (!iso) return 'never run'
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'ran just now'
  return h < 24 ? `ran ${h}h ago` : `ran ${Math.floor(h / 24)}d ago`
}

/**
 * ACR.4.1 — the graduation verdict, joined onto the rule it judges.
 *
 * Only `ready` may present itself as an invitation. The other verdicts are shown because "why
 * is nothing ready" has to be answerable on the same screen as the dial — but a rule that has
 * merely RUN cleanly must never be dressed to look like a rule you agreed with, which is the
 * single way this surface could talk someone into a promotion they have no evidence for.
 */
type Verdict = 'ready' | 'unreviewed' | 'unseen' | 'building' | 'failing' | 'capped'
interface Readiness {
  ruleId: string
  verdict: Verdict
  summary: string
  canGraduate: boolean
  evidence: { decisionWeeks: number; cleanWeeks: number; pending: number; failures: number; appliedEdited: number }
}
const VERDICT_CHIP: Partial<Record<Verdict, { label: string; cls: string }>> = {
  ready: { label: 'Ready to graduate', cls: 'ready' },
  unseen: { label: 'Never proposed', cls: 'unseen' },
  unreviewed: { label: 'Clean, undecided', cls: 'unreviewed' },
  failing: { label: 'Failing', cls: 'failing' },
}

export function RulesSection() {
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [protectedTerms, setProtectedTerms] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [grad, setGrad] = useState<Map<string, Readiness>>(new Map())
  const [weeksRequired, setWeeksRequired] = useState(3)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`rules: ${r.status}`)
      const j = await r.json()
      setRules(Array.isArray(j?.items) ? (j.items as Rule[]) : [])
      setProtectedTerms(Number(j?.protectedTerms ?? 0))
      setErr(null)
    } catch (e) { setErr((e as Error).message); setRules([]) }
    // Graduation evidence is a separate read and a separate concern: the dial must render and
    // work whether or not the evidence board is available. A rule you cannot judge is still a
    // rule you must be able to switch off.
    try {
      const g = await fetch(`${getBackendUrl()}/api/advertising/autonomy/graduation`, { cache: 'no-store' })
      if (!g.ok) throw new Error(String(g.status))
      const gj = await g.json()
      const all = [...(gj?.ready ?? []), ...(gj?.others ?? [])] as Readiness[]
      setGrad(new Map(all.map((x) => [x.ruleId, x])))
      setWeeksRequired(Number(gj?.weeksRequired ?? 3))
    } catch { setGrad(new Map()) }
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
  const off = rules.filter((r) => r.level === 'OFF').length
  const readyCount = [...grad.values()].filter((g) => g.canGraduate).length
  /* Ordered by how much authority the rule holds. The board this replaces grouped into four
     labelled sections; sorting gives the same scan — "what is acting on its own" reads off the
     top — without a second layout inside a section that already sits under Engines. */
  const ordered = [...rules].sort((a, b) => RANK[b.level] - RANK[a.level] || a.name.localeCompare(b.name))

  return (
    <section className="acr-rules">
      <div className="acr-sec-head">
        <h2>Rules</h2>
        <span className="acr-sec-count">
          {rules.length} total · {acting} acting · {asking} asking first{off > 0 ? ` · ${off} off` : ''}
          {readyCount > 0 ? ` · ${readyCount} ready to graduate` : ''}
        </span>
      </div>

      {err && <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>}

      {/*
        ACR.4.1 — stated once, at the top, rather than repeated on every row. Graduation is the
        mechanism that ends daily attention, so what it costs has to be legible before an
        operator meets the first verdict.

        The icon and the sentence are the flex container's only two children. Left as bare text
        nodes, the emphasised word became its own flex item and the sentence rendered as three
        side-by-side columns.
      */}
      {grad.size > 0 && (
        <p className="acr-grad-rule">
          <GraduationCap size={13} />
          <span>
            A rule is offered the Auto notch after you have applied its proposals <strong>unchanged</strong>
            {' '}in {weeksRequired} separate weeks with no failures. Running cleanly is not the same evidence
            and never earns it — nor does any ceiling move: rules that create or destroy things stay gated
            whatever their history.
          </span>
        </p>
      )}

      {protectedTerms === 0 && (
        <div className="acr-banner warn">
          <ShieldAlert size={15} />
          No protected terms are configured. Rules that negate search terms stay capped at
          Propose until a whitelist exists — otherwise a brand term could be negated with
          nothing to stop it.
        </div>
      )}

      <ul className="acr-list">
        {ordered.map((r) => {
          const g = grad.get(r.id)
          const chip = g && g.verdict !== 'capped' && g.verdict !== 'building' ? VERDICT_CHIP[g.verdict] : undefined
          return (
          <li key={r.id} className={`acr-row rule${g?.canGraduate ? ' graduable' : ''}`}>
            <div className="acr-row-main">
              <div className="acr-row-name">
                <strong>{r.name}</strong>
                {r.marketplace && <span className="acr-tag">{r.marketplace}</span>}
                {chip && (
                  <span className={`acr-grad-chip ${chip.cls}`} title={g!.summary}>
                    {g!.verdict === 'ready' && <GraduationCap size={11} />}
                    {chip.label}
                  </span>
                )}
              </div>
              <p className="acr-what">
                {r.actionTypes.length ? r.actionTypes.join(' · ') : 'alert only'}
              </p>
              <p
                className="acr-why"
                title={
                  r.lifetime?.matches != null && r.ageDays != null
                    ? `${r.lifetime.matches} lifetime matches over ${r.ageDays} days`
                    : undefined
                }
              >
                {r.week.acted} acted · {r.week.proposed} proposed
                {r.week.failed > 0 ? ` · ${r.week.failed} failed` : ''} this week — {ago(r.lastExecutedAt)}
                {r.caps.perDay != null ? ` · max ${r.caps.perDay}/day` : ''}
                {r.caps.perDayCents != null ? ` · €${(r.caps.perDayCents / 100).toFixed(0)}/day` : ''}
              </p>
              {RANK[r.ceiling] < RANK.AUTO && (
                <p className="acr-ceiling"><ShieldAlert size={13} /> {r.ceilingReason}</p>
              )}
              {/* The evidence, in a sentence. Shown for every verdict except `capped`, whose
                  reason is already the ceiling line directly above — printing both would say
                  the same thing twice in two different voices. */}
              {g && g.verdict !== 'capped' && (
                <p className={`acr-grad-why ${g.verdict}`}>{g.summary}</p>
              )}
            </div>

            <div className="acr-dial" role="group" aria-label={`Autonomy level for ${r.name}`}>
              {LEVELS.map((lv) => {
                const M = META[lv]
                const above = RANK[lv] > RANK[r.ceiling]
                const on = r.level === lv
                // The one notch this rule has earned. Highlighted, never pre-selected and never
                // auto-clicked: graduation is the operator's decision and the whole programme
                // rests on it staying that way.
                const earned = !!g?.canGraduate && lv === 'AUTO' && !on
                return (
                  <Button
                    key={lv}
                    className={`acr-notch ${on ? 'on' : ''} ${lv.toLowerCase()}${earned ? ' earned' : ''}`}
                    aria-pressed={on}
                    disabled={above || busy === r.id}
                    // Disabled notches keep their reason: a control that refuses silently
                    // is the thing that makes an operator distrust the whole surface.
                    title={above ? r.ceilingReason : earned ? `${g!.summary} Click to graduate this rule to Auto.` : M.hint}
                    onClick={() => void setLevel(r, lv)}
                  >
                    <M.Icon size={12} /> {M.label}
                  </Button>
                )
              })}
            </div>
          </li>
          )
        })}
      </ul>
    </section>
  )
}
