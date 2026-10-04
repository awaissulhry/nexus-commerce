/**
 * 4j (review finding 4.12) — which selected rules a bulk Automation change may touch, decided before
 * anything is written, and the sentence that reports what it did.
 *
 * 🔴 Why this exists. The bulk verb wrote its level to EVERY selected rule. Automation Off writes
 * Propose, and the level route ties `enabled` to `level !== 'OFF'` (`setAdsRuleLevel`), so a rule
 * that was disabled, at Off or at Observe came back ENABLED at Propose: "Automation Off" turned rules
 * up. Now a level below Auto only ever lowers a rule — a rule already at or below it is left as it
 * was and counted — and Auto (Automation On) is the one target allowed to raise, because raising is
 * that verb's whole purpose.
 *
 * The level ordering is the Automations page's own (`ModeNotches`), not a second copy.
 */
import { LEVELS, LEVEL_META, RANK, type Level } from '../automations/ModeNotches'

/** One selected row, as the grid already holds it. */
export interface BulkRuleState {
  /** the stored `autonomyLevel` */
  level: string
  enabled: boolean
  /** the stored `dryRun` — the engine reads it only when the level is missing or Off */
  dryRun?: boolean
  /** the row's Automation toggle: enabled, at Auto and not belted to Manual */
  automation: boolean
}

export interface BulkAutomationPlan {
  target: Level
  /** written, in the order selected */
  change: string[]
  /** left as they were: already on (On), or already at or below the target (any other level) */
  already: Array<{ id: string; level: Level }>
  /** On only — held below Auto by the graduation ceiling, which only Automations can raise */
  capped: string[]
  /** selected, but no longer in the grid — nothing to read, so nothing is written */
  missing: string[]
}

/**
 * The level a rule actually runs at — the web mirror of `resolveAutonomy` (apps/api
 * `ads-autonomy.ts`): a disabled rule is Off whatever its dial says, and a missing or Off dial on an
 * enabled rule falls back to the old dry-run binary.
 */
export function effectiveLevel(s: Pick<BulkRuleState, 'level' | 'enabled' | 'dryRun'>): Level {
  if (!s.enabled) return 'OFF'
  if ((LEVELS as string[]).includes(s.level) && s.level !== 'OFF') return s.level as Level
  return s.dryRun ? 'PROPOSE' : 'AUTO'
}

/**
 * Split the selection by what the bulk write to `target` would do to each rule.
 *
 * · `target` Auto (Automation On): every rule not already on is raised, except the ones the
 *   graduation ceiling holds below Auto (each would only come back as a 409).
 * · any other `target` (Automation Off writes Propose): only a rule running ABOVE the target is
 *   written. One at the target or below — Propose, Observe, Off, or disabled — is left alone.
 */
export function planBulkAutomation(
  ids: readonly string[],
  target: Level,
  stateOf: (id: string) => BulkRuleState | undefined,
  isCapped: (id: string) => boolean,
): BulkAutomationPlan {
  const plan: BulkAutomationPlan = { target, change: [], already: [], capped: [], missing: [] }
  for (const id of ids) {
    const s = stateOf(id)
    if (!s) { plan.missing.push(id); continue }
    const level = effectiveLevel(s)
    if (target === 'AUTO') {
      if (s.automation) plan.already.push({ id, level })
      else if (isCapped(id)) plan.capped.push(id)
      else plan.change.push(id)
    } else if (RANK[level] > RANK[target]) {
      plan.change.push(id)
    } else {
      plan.already.push({ id, level })
    }
  }
  return plan
}

/**
 * What the bulk change did, in plain words — or null when it did everything it was asked.
 * `failed` counts the `change` rows whose write did not land.
 */
export function bulkAutomationNotice(plan: BulkAutomationPlan, failed: number, nounLower: string): string | null {
  const { change, already, capped, missing } = plan
  if (!already.length && !capped.length && !missing.length && !failed) return null
  const total = change.length + already.length + capped.length + missing.length
  const on = plan.target === 'AUTO'
  const n = already.length
  let alreadySaid = ''
  if (n && on) alreadySaid = `${n} ${n === 1 ? 'was' : 'were'} already on.`
  if (n && !on) {
    // Highest first, in the words the Automations page uses: "2 Propose, 1 Off".
    const byLevel = [...LEVELS].reverse()
      .map((l) => [l, already.filter((a) => a.level === l).length] as const)
      .filter(([, c]) => c > 0)
      .map(([l, c]) => `${c} ${LEVEL_META[l].label}`)
      .join(', ')
    alreadySaid = `${n} left as ${n === 1 ? 'it was' : 'they were'} — already at ${LEVEL_META[plan.target].label} or below (${byLevel}), and Automation Off never turns a rule up.`
  }
  return [
    `${change.length - failed} of ${total} ${total === 1 ? nounLower : `${nounLower}s`} set to Automation ${on ? 'On' : 'Off'}.`,
    alreadySaid,
    capped.length ? `${capped.length} left unchanged — above the graduation ceiling, which only Automations can raise.` : '',
    missing.length ? `${missing.length} ${missing.length === 1 ? 'is' : 'are'} no longer listed and ${missing.length === 1 ? 'was' : 'were'} not changed.` : '',
    failed ? `${failed} failed to write.` : '',
  ].filter(Boolean).join(' ')
}
