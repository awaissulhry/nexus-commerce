/**
 * Group 1 (1g, review finding 2.9) — the account dial and Resume, as the Control Room shows them. Pure: the page
 * renders these with the design system's SegmentedControl and ActionConfirm, and the tests drive them directly.
 *
 * Two brakes, two controls. The halt (a person's Stop, or the anomaly breaker) is cleared by Resume. The dial at Off
 * is cleared by the dial: Resume used to be the only button shown for both, and it cannot move the dial, so an
 * account at Off stayed off with a Resume button that did nothing.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'

export type Dial = 'OFF' | 'SUGGEST' | 'AUTO'

/** The account-level facts the levers endpoint returns as `global`. */
export interface AccountGlobal { autonomy: string; halted: boolean; degraded: boolean; envKill: boolean }

export const DIAL_LEVELS: readonly Dial[] = ['OFF', 'SUGGEST', 'AUTO']
export const DIAL_LABEL: Record<Dial, string> = { OFF: 'Off', SUGGEST: 'Suggest', AUTO: 'Auto' }
export const isDial = (v: string): v is Dial => (DIAL_LEVELS as readonly string[]).includes(v)

/**
 * What each level does. 🔴 SUGGEST: engines join it one PR at a time (review finding 2.3: rank-defend and dayparting
 * in 1c, the budget/pool/ToS/coverage/autopilot engines in 1d), so the sentence names no engine list — the Levers
 * board says per engine whether it honours the dial.
 * OFF: the write gate still lets bid-lowering writes through (a stop must never hold bids high), and refuses the raise
 * that would bring a floored bid back.
 */
export const DIAL_MEANS: Record<Dial, string> = {
  OFF: 'No rule or engine changes your ads by itself, except to lower bids to their floor. Bids already at their floor stay there until the dial is turned up.',
  SUGGEST: 'Rules propose changes for you to approve, and every engine that honours the dial only counts what it would change. Each engine\'s line on the Levers board says whether it honours the dial. An engine still undoes its own earlier changes, such as giving back bids it lowered to their floor.',
  AUTO: 'Rules and engines make changes by themselves, inside the write gate and every guardrail.',
}

export interface AccountStatusView {
  stopped: boolean
  headline: string
  detail: string
  /** The button beside the dial: Resume clears a halt; Stop everything halts. A dial at Off gets neither. */
  action: 'resume' | 'halt' | null
  /** Why the dial cannot be moved here, shown as text in its place; null when it can. */
  dialLocked: string | null
}

export function accountStatus(g: AccountGlobal, acting: number, total: number, canManage: boolean): AccountStatusView {
  const off = g.autonomy === 'OFF'
  const stopped = g.envKill || g.halted || off
  const detail = g.envKill
    ? 'NEXUS_ADS_AUTOMATION_KILL is set — this cannot be cleared from here.'
    : g.halted
      ? off
        ? 'Halted, and the dial is at Off. Resume clears the halt; then turn the dial up to start again.'
        : 'Halted. No engine can write to Amazon until you resume.'
      : off
        ? 'The dial is at Off. Turn the dial to Suggest or Auto to start again.'
        : g.autonomy === 'SUGGEST'
          ? `The dial is at Suggest. ${DIAL_MEANS.SUGGEST}`
          : `${acting} of ${total} engines are acting on their own.`
  return {
    stopped,
    headline: stopped ? 'Automation is stopped' : 'Automation is running',
    detail,
    action: g.envKill ? null : g.halted ? 'resume' : off ? null : 'halt',
    dialLocked: g.degraded
      ? 'The dial could not be read.'
      : g.envKill
        ? 'The server kill switch stops everything, whatever the dial says.'
        : !canManage
          ? 'Changing the dial needs the ads automation permission.'
          : null,
  }
}

/** The confirmation before the dial moves (ActionConfirm), or null when there is nothing to move. */
export function dialMove(g: AccountGlobal, to: string): { to: Dial; impact: ActionImpact } | null {
  if (!isDial(to) || !isDial(g.autonomy) || g.autonomy === to) return null
  const from = g.autonomy
  const up = DIAL_LEVELS.indexOf(to) > DIAL_LEVELS.indexOf(from)
  const consequences = [
    `The account dial goes from ${DIAL_LABEL[from]} to ${DIAL_LABEL[to]} for this business, from each rule's and engine's next run.`,
    DIAL_MEANS[to],
  ]
  if (g.halted) consequences.push('Automation is halted and stays stopped until you press Resume. The dial does not clear a halt.')
  const impact: ActionImpact = up
    ? {
      level: 'confirm',
      title: `Turn the account dial up to ${DIAL_LABEL[to]}?`,
      consequences,
      reach: 'channel',
      reversal: { verb: 'Turn the dial back down', fidelity: 'lossy' },
      acknowledge: 'I understand automation acts from its next run, and what it changes stays changed when I turn the dial back down.',
    }
    : {
      level: 'confirm',
      title: `Turn the account dial down to ${DIAL_LABEL[to]}?`,
      consequences,
      reach: 'channel',
      reversal: { verb: 'Turn the dial back up', fidelity: 'exact' },
    }
  return { to, impact }
}
