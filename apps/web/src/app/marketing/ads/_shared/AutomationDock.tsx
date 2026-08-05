'use client'

/**
 * ACR.7 — the Automation Dock: every rule, always in reach, draggable onto what it should govern.
 *
 * Operator direction 2026-08-05: "a menu that is always on and has all the rules and automation
 * in it. We can drag the automation, edit it… and then drag it to portfolios or campaigns
 * individually." This is that panel, shared by the Control Room, the Portfolios page and the
 * Family Cockpit so the rules read identically everywhere.
 *
 * Two design rules:
 *
 *   · Colour, not emoji. Rule names are plain text (operator: emojis "make it way less
 *     professional"); the left swatch carries the grouping — blue bids, amber budget, green
 *     harvest, red negation, purple placement, teal protection, slate alerts. The colours come
 *     from the server (`categoryColor`), so no surface can colour the same rule differently.
 *
 *   · A drag is a real binding. Dropping a rule on a portfolio or campaign PATCHes
 *     /autonomy/rules/:id/scope, and the evaluator enforces that scope at the chokepoint —
 *     built in the same change, because a drop that doesn't bind is a lie drawn as a feature.
 *
 * Native HTML5 drag and drop; the payload travels as JSON in dataTransfer under
 * `application/x-nexus-rule`. Drop targets register themselves with `ruleDropProps()`.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { GripVertical, Pencil, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import './automation-dock.css'

export const RULE_DRAG_MIME = 'application/x-nexus-rule'

export interface DockRule {
  id: string
  name: string
  level: string
  ceiling: string
  category: string
  categoryColor: string
  categoryLabel: string
  scope: { kind: 'account' | 'portfolio' | 'campaign'; id: string | null; name: string | null }
  week: { acted: number; proposed: number; failed: number }
}

/** Spread onto any element that should accept a rule drop. */
export function ruleDropProps(onDropRule: (rule: { id: string; name: string }) => void) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(RULE_DRAG_MIME)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'link'
        ;(e.currentTarget as HTMLElement).classList.add('rule-drop-hover')
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove('rule-drop-hover')
    },
    onDrop: (e: React.DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove('rule-drop-hover')
      const raw = e.dataTransfer.getData(RULE_DRAG_MIME)
      if (!raw) return
      e.preventDefault()
      try { onDropRule(JSON.parse(raw) as { id: string; name: string }) } catch { /* not ours */ }
    },
  }
}

/** The one write path a drop uses. Exported so drop targets outside the dock share it. */
export async function setRuleScope(
  ruleId: string,
  scope: { scopePortfolioId?: string | null; scopeCampaignId?: string | null },
): Promise<boolean> {
  const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${ruleId}/scope`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope),
  })
  return r.ok
}

const LEVELS = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const
const RANK: Record<string, number> = { OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 }

export function AutomationDock({ title = 'Automations', onChanged }: { title?: string; onChanged?: () => void }) {
  const [rules, setRules] = useState<DockRule[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`rules: ${r.status}`)
      const j = await r.json()
      setRules((j.items ?? []) as DockRule[])
      setErr(null)
    } catch (e) { setErr((e as Error).message); setRules([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  const setLevel = async (rule: DockRule, level: string) => {
    setBusy(rule.id)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
      })
      await load(); onChanged?.()
    } finally { setBusy(null) }
  }
  const clearScope = async (rule: DockRule) => {
    setBusy(rule.id)
    try { await setRuleScope(rule.id, {}); await load(); onChanged?.() } finally { setBusy(null) }
  }

  const cats = [...new Map((rules ?? []).map((r) => [r.category, { color: r.categoryColor, label: r.categoryLabel }])).entries()]
    .sort((a, b) => a[1].label.localeCompare(b[1].label))
  // Colour is the taxonomy, so the list reads in colour blocks: category, then name.
  const CAT_ORDER = ['bid', 'budget', 'harvest', 'negative', 'placement', 'guard', 'alert']
  const visible = (rules ?? [])
    .filter((r) => filter === 'all' || r.category === filter)
    .sort((a, b) => (CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category)) || a.name.localeCompare(b.name))

  return (
    <aside className="adock" aria-label="Automation rules">
      <div className="adock-head">
        <h2>{title}</h2>
        <span className="adock-count">{rules?.length ?? '…'}</span>
      </div>
      <p className="adock-hint">Drag a rule onto a portfolio or campaign to bind it there. Colours group by what a rule does.</p>

      <div className="adock-cats" role="tablist" aria-label="Filter by category">
        <button type="button" className={`adock-cat ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All</button>
        {cats.map(([cat, m]) => (
          <button key={cat} type="button" className={`adock-cat ${filter === cat ? 'on' : ''}`}
            onClick={() => setFilter(cat)} title={m.label}>
            <i style={{ background: m.color }} />{m.label}
          </button>
        ))}
      </div>

      {err && <div className="adock-err">{err}</div>}
      {rules === null && <div className="adock-loading">Loading…</div>}

      <ul className="adock-list">
        {visible.map((r) => (
          <li
            key={r.id}
            className="adock-rule"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(RULE_DRAG_MIME, JSON.stringify({ id: r.id, name: r.name }))
              e.dataTransfer.effectAllowed = 'link'
            }}
            style={{ ['--cat' as never]: r.categoryColor }}
          >
            <span className="adock-grip" title="Drag onto a portfolio or campaign"><GripVertical size={13} /></span>
            <div className="adock-main">
              <div className="adock-name-row">
                <span className="adock-swatch" title={r.categoryLabel} />
                <span className="adock-name" title={r.name}>{r.name}</span>
                <Link href="/marketing/ads/rules-automation" className="adock-edit" title="Edit this rule"><Pencil size={11} /></Link>
              </div>
              <div className="adock-sub">
                {r.week.acted} acted · {r.week.proposed} proposed this week
              </div>
              {/* The binding, visible and clearable. An invisible scope is an invisible surprise. */}
              {r.scope.kind !== 'account' && (
                <div className="adock-scope" title={`This rule fires ONLY inside ${r.scope.kind} “${r.scope.name}”.`}>
                  {r.scope.kind}: {r.scope.name}
                  <button type="button" className="adock-scope-x" disabled={busy === r.id}
                    title="Unbind — back to account-wide" onClick={() => void clearScope(r)}><X size={10} /></button>
                </div>
              )}
              <div className="adock-dial" role="group" aria-label={`Autonomy for ${r.name}`}>
                {LEVELS.map((l) => {
                  const above = RANK[l] > RANK[r.ceiling]
                  // Full mini-words, not initials — OFF and OBSERVE both start with O, and a
                  // control whose states are indistinguishable is not a control.
                  const label = l === 'OFF' ? 'Off' : l === 'OBSERVE' ? 'Obs' : l === 'PROPOSE' ? 'Prop' : 'Auto'
                  return (
                    <button key={l} type="button"
                      className={`adock-notch ${r.level === l ? `on ${l.toLowerCase()}` : ''}`}
                      disabled={above || busy === r.id}
                      title={above ? `Capped at ${r.ceiling} by graduation` : l}
                      onClick={() => void setLevel(r, l)}>
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  )
}
