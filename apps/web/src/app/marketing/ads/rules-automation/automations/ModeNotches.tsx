'use client'

/**
 * RA.AUTO — the mode control, and the only one on this page.
 *
 * It writes `autonomyLevel` through `PATCH /advertising/autonomy/rules/:id`. It never touches
 * `dryRun`. That is not a style choice: `resolveAutonomy()` reads `dryRun` only when
 * `autonomyLevel` is null or OFF, and all 51 rules carry an explicit level, so the
 * dry-run⇄LIVE toggle on `ads-console/automation` cannot change what any of them does.
 * See docs/2026-08-10-ads-rules-automation-ra.md Part 2.
 *
 * The notch behaviour is ported from `control-room/RulesSection.tsx:227-251` rather than from
 * the AutomationDock, because that component already solved the two things that make this
 * control trustworthy: a notch above the rule's graduation ceiling keeps its reason, and a 409
 * from the server is presented as the policy it is rather than as a failure.
 *
 * 🔴 U13 (2026-08-19) — "keeps its reason" was not true, and had never been true. The notch
 * rendered with the `disabled` ATTRIBUTE and its reason in `title`, and a disabled control takes no
 * focus, takes no click, and shows no tooltip in Chrome — so the reason was written onto the one
 * element in the DOM that cannot deliver it. Measured on prod: **14 of the 51 rules' notches** on
 * this page were refusing in total silence.
 *
 * It is now `aria-disabled` + an `above` class for the look, and clicking it calls `onRefused`
 * instead of `onSet`: no doomed request, and the ceiling's sentence lands in the page's banner
 * where the operator is already looking. `disabled` is kept for `busy` alone — a write in flight
 * needs no explanation because it resolves on its own. Its `acr-*` classes live in `control-room.css`, which another programme also owns,
 * so the markup is restyled here under `h10-au-*` instead of importing across pages.
 *
 * `h10-au-`, NOT `h10-am-`: that prefix is the app-wide Ads Manager grid namespace. This file
 * shipped once with `h10-am-dial`/`h10-am-notch`, which match no stylesheet in the repo, and the
 * dial rendered on prod as the bare words "OffObserveProposeAuto" — an undefined class is silent,
 * so nothing failed and tsc had nothing to say. The pre-commit check for it is in ds-classes.
 */

import { Eye, MessageSquare, Power, Zap, GraduationCap } from 'lucide-react'
import { Button } from '@/design-system/primitives'

export type Level = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'
export const LEVELS: Level[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']
export const RANK: Record<Level, number> = { OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 }

export const LEVEL_META: Record<Level, { label: string; Icon: typeof Zap; hint: string }> = {
  OFF: { label: 'Off', Icon: Power, hint: 'Does not evaluate at all.' },
  OBSERVE: { label: 'Observe', Icon: Eye, hint: 'Runs and records what it would have done. No proposal, no write.' },
  PROPOSE: { label: 'Propose', Icon: MessageSquare, hint: 'Queues a suggestion for you. Nothing reaches Amazon until you accept it.' },
  AUTO: { label: 'Auto', Icon: Zap, hint: 'Acts on its own, inside its daily cap and the write gate.' },
}

export function ModeNotches({
  level, ceiling, ceilingReason, ruleName, busy, earnedAuto, earnedWhy, onSet, onRefused,
}: {
  level: Level
  ceiling: Level
  ceilingReason: string
  ruleName: string
  busy: boolean
  /** True only when the graduation board says this rule has earned AUTO. Never auto-clicked. */
  earnedAuto: boolean
  earnedWhy?: string
  onSet: (level: Level) => void
  /** Clicking a notch above the ceiling. Say why, in the ceiling's own words; never write. */
  onRefused?: (why: string) => void
}) {
  return (
    <div className="h10-au-dial" role="group" aria-label={`Mode for ${ruleName}`}>
      {LEVELS.map((lv) => {
        const M = LEVEL_META[lv]
        const above = RANK[lv] > RANK[ceiling]
        const on = level === lv
        const earned = earnedAuto && lv === 'AUTO' && !on
        return (
          <Button
            key={lv}
            className={`h10-au-notch ${lv.toLowerCase()}${earned ? ' earned' : ''}${above ? ' above' : ''}`}
            active={on}
            aria-pressed={on}
            // 🔴 NEVER `disabled` for `above` — see the U13 note at the top. `busy` is fine: it
            // needs no explanation and clears itself.
            disabled={busy}
            aria-disabled={above || busy}
            // A refusing notch keeps its reason AND can deliver it. A control that refuses
            // silently is what teaches an operator to distrust the whole surface.
            title={above ? ceilingReason : earned ? `${earnedWhy ?? ''} Click to graduate this rule to Auto.` : M.hint}
            onClick={() => { if (above) { onRefused?.(ceilingReason); return } onSet(lv) }}
          >
            {earned ? <GraduationCap size={12} aria-hidden /> : <M.Icon size={12} aria-hidden />}
            {M.label}
          </Button>
        )
      })}
    </div>
  )
}
