/**
 * Group 1 (1g, review finding 2.9) — the account level (the "dial"), Stop now and Start again, as the Control Room
 * shows them. Pure: the page renders these with the design system's SegmentedControl and ActionConfirm, and the tests
 * drive them directly.
 *
 * Two brakes, two controls. A stop (a person's Stop now, or the anomaly breaker) is cleared by Start again. The level
 * at Off is cleared by the level: Start again cannot move it, so an account at Off gets no Start again button.
 *
 * CR rebuild 1 (Owner 2026-10-06): one level scale on every row of the Control Room — Off · Watch · Ask me · Auto. The
 * account level has no Watch. SUGGEST (shown as "Propose" before) is "Ask me". Every move asks first, Stop now too:
 * it was the one click on the page that changed the whole account with no question.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'

export type Dial = 'OFF' | 'SUGGEST' | 'AUTO'

/** The account-level facts the levers endpoint returns as `global`. */
export interface AccountGlobal { autonomy: string; halted: boolean; degraded: boolean; envKill: boolean }

export const DIAL_LEVELS: readonly Dial[] = ['OFF', 'SUGGEST', 'AUTO']
export const DIAL_LABEL: Record<Dial, string> = { OFF: 'Off', SUGGEST: 'Ask me', AUTO: 'Auto' }
export const isDial = (v: string): v is Dial => (DIAL_LEVELS as readonly string[]).includes(v)

/**
 * What each level does. SUGGEST: engines that honour the level only count what they would change; Who acts says per
 * engine what it may do now. OFF: the write gate still lets bid-lowering writes through (a stop must never hold bids
 * high), and refuses the raise that would bring a floored bid back.
 */
export const DIAL_MEANS: Record<Dial, string> = {
  OFF: 'Nothing changes your ads by itself, except lowering bids to their floor. Bids at their floor stay there until you raise the level.',
  SUGGEST: 'Rules ask you before each change. Engines only count what they would change. An engine can still give back bids it lowered to their floor.',
  AUTO: 'Rules and engines set to Auto change your ads by themselves, inside your limits.',
}

export interface AccountStatusView {
  stopped: boolean
  headline: string
  detail: string
  /** The button beside the level: Start again clears a stop; Stop now stops. A level at Off gets neither. */
  action: 'resume' | 'halt' | null
  /** Why the level cannot be moved here, shown as text in its place; null when it can. */
  dialLocked: string | null
}

/**
 * `runsAlone`: the rows of Who acts that change the ads by themselves now (whoActs.ts `rowCounts`), or null when that
 * could not be counted (still reading, or a read failed) — never shown as 0.
 */
export function accountStatus(g: AccountGlobal, runsAlone: number | null, canManage: boolean): AccountStatusView {
  const off = g.autonomy === 'OFF'
  const stopped = g.envKill || g.halted || off
  const view = (headline: string, detail: string) => ({ headline, detail })
  const text = g.envKill
    ? view('Stopped by the server', 'The server’s emergency switch stops all ads automation. Only a deploy can clear it.')
    : g.halted
      ? off
        ? view('Stopped', 'Stopped, and the level is Off. Press Start again, then raise the level. Bids can still go down to their floor.')
        : view('Stopped', 'Nothing raises or adds to your ads by itself until you press Start again. Bids can still go down to their floor.')
      : off
        ? view('Off', `Nothing changes your ads by itself. Raise the level to ${DIAL_LABEL.SUGGEST} or ${DIAL_LABEL.AUTO} to start again.`)
        : g.autonomy === 'SUGGEST'
          ? view('Ask me first', DIAL_MEANS.SUGGEST)
          : runsAlone == null
            ? view('Auto is allowed', 'What changes your ads by itself could not be counted yet.')
            : runsAlone > 0
              ? view('Running', `${runsAlone} ${runsAlone === 1 ? 'automation changes' : 'automations change'} your ads by ${runsAlone === 1 ? 'itself' : 'themselves'}.`)
              : view('Auto is allowed', 'No automation changes your ads by itself now.')
  return {
    stopped,
    ...text,
    action: g.envKill ? null : g.halted ? 'resume' : off ? null : 'halt',
    dialLocked: g.degraded
      ? 'The level could not be read.'
      : g.envKill
        ? 'The server’s emergency switch holds everything off, whatever the level says.'
        : !canManage
          ? 'Changing the level needs the ads automation permission.'
          : null,
  }
}

/** The confirmation before the level moves (ActionConfirm), or null when there is nothing to move. */
export function dialMove(g: AccountGlobal, to: string): { to: Dial; impact: ActionImpact } | null {
  if (!isDial(to) || !isDial(g.autonomy) || g.autonomy === to) return null
  const from = g.autonomy
  const up = DIAL_LEVELS.indexOf(to) > DIAL_LEVELS.indexOf(from)
  const consequences = [
    `The account level goes from ${DIAL_LABEL[from]} to ${DIAL_LABEL[to]} for this business, from each rule’s and engine’s next run.`,
    DIAL_MEANS[to],
  ]
  if (g.halted) consequences.push('Automation is stopped and stays stopped until you press Start again. The level does not clear a stop.')
  const impact: ActionImpact = up
    ? {
      level: 'confirm',
      title: `Raise the account level to ${DIAL_LABEL[to]}?`,
      consequences,
      reach: 'channel',
      reversal: { verb: `Set the level back to ${DIAL_LABEL[from]}`, fidelity: 'lossy' },
      acknowledge: 'I understand automation acts from its next run, and what it changes stays changed when I lower the level.',
      confirmLabel: `Raise to ${DIAL_LABEL[to]}`,
    }
    : {
      level: 'confirm',
      title: `Lower the account level to ${DIAL_LABEL[to]}?`,
      consequences,
      reach: 'channel',
      reversal: { verb: `Set the level back to ${DIAL_LABEL[from]}`, fidelity: 'exact' },
      confirmLabel: `Lower to ${DIAL_LABEL[to]}`,
    }
  return { to, impact }
}

/** The confirmation before Stop now. A brake: one plain question, no tick to arm it. */
export function haltMove(): ActionImpact {
  return {
    level: 'confirm',
    title: 'Stop all ads automation now?',
    consequences: [
      'No rule or engine raises or adds to your ads by itself until you press Start again.',
      'Bids can still go down to their floor: a stop never holds a bid high.',
      'Engines that only read or watch keep running.',
    ],
    reach: 'channel',
    reversal: { verb: 'Start again', fidelity: 'exact' },
    confirmLabel: 'Stop now',
  }
}

/**
 * The confirmation before Start again. Above Off it lets automation act again, and what it changes stays changed, so
 * the design system asks for the same tick as a raise (registry.ts: a lossy reversal on the channel needs one).
 */
export function resumeMove(g: AccountGlobal): ActionImpact {
  const level = isDial(g.autonomy) ? g.autonomy : null
  if (level === 'OFF') {
    return {
      level: 'confirm',
      title: 'Start ads automation again?',
      consequences: ['The stop is cleared. The level is Off, so nothing acts until you raise it.'],
      reach: 'channel',
      reversal: { verb: 'Stop now', fidelity: 'exact' },
      confirmLabel: 'Start again',
    }
  }
  return {
    level: 'confirm',
    title: 'Start ads automation again?',
    consequences: [`The stop is cleared. Rules and engines act again from their next run, at the account level ${level ? DIAL_LABEL[level] : 'in force'}.`],
    reach: 'channel',
    reversal: { verb: 'Stop now', fidelity: 'lossy' },
    acknowledge: 'I understand automation acts from its next run, and what it changes stays changed when I stop it again.',
    confirmLabel: 'Start again',
  }
}
