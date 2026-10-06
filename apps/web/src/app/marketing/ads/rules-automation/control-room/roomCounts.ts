/**
 * CR rebuild 1 — the numbers in the Control Room's top tiles. Pure: the page renders them with the design system's
 * MetricStrip, and the tests drive them directly.
 *
 * The three automation tiles split every row of Who acts by what it can do to the ads NOW (whoActs.ts `rowCounts`), so
 * they always add up to the Who acts count: it changes them by itself, it asks a person first, or it changes nothing.
 * A rule's level is its own setting, so the account level and a stop are applied to it here (`ruleInForce`), the way
 * the API already applies them to an engine's mode.
 *
 * "Waiting for you" is ONE number for every queue that holds a decision for a person: the Approvals queue (Claude's
 * requests and strategy raises) and the rules' suggestions. The old Activity tile counted only the second, and said 0
 * while Approvals held two requests.
 */
import type { Level } from './levelWords'

export type { Level }

export interface AccountLevel { autonomy: string; halted: boolean; envKill: boolean }

/** Today board keys the tiles show elsewhere: the top band says when automation is stopped, Waiting counts proposals. */
const NOT_A_PROBLEM = new Set(['automation-stopped', 'decisions-waiting'])

export interface ProblemRow { key: string; severity: 'critical' | 'warning' | 'info'; count: number }

/** What a rule may do now: a stop or the account level at Off holds it off, and Ask me holds Auto at asking. */
export function ruleInForce(level: Level, g: AccountLevel): Level {
  if (g.envKill || g.halted || g.autonomy === 'OFF') return 'OFF'
  if (g.autonomy === 'SUGGEST' && level === 'AUTO') return 'PROPOSE'
  return level
}

/** The quiet rows apart: watching, off, or on with nothing to change (the breaker, write delivery, no plans). */
export interface QuietSplit { watch: number; off: number; idle: number }

/** "2 watch · 5 off · 3 on, nothing to change" — only the parts that have one. */
export function quietHint(s: QuietSplit): string {
  const parts = [
    s.watch > 0 ? `${s.watch} watch` : null,
    s.off > 0 ? `${s.off} off` : null,
    s.idle > 0 ? `${s.idle} on, nothing to change` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'none'
}

/**
 * Waiting for you. `null` means the count could not be read — never shown as 0 (a 0 here says "nothing waits").
 * One side unread still shows the other, and the hint says which side is missing.
 */
export function waitingFor(needsYou: number | null, suggestions: number | null): { value: number | null; hint: string } {
  if (needsYou == null && suggestions == null) return { value: null, hint: 'Could not be read' }
  const value = (needsYou ?? 0) + (suggestions ?? 0)
  // Approvals holds every request that waits for a person in this business — ads and every other part of Nexus.
  const claude = needsYou == null ? 'Approvals could not be read' : `${needsYou} in Approvals (all of Nexus)`
  const rules = suggestions == null ? 'rule suggestions could not be read' : `${suggestions} rule suggestion${suggestions === 1 ? '' : 's'}`
  return { value, hint: `${claude} · ${rules}` }
}

/** The rule suggestions waiting, from the Today board (its decisions-waiting row; absent = none waiting). */
export function suggestionsWaiting(rows: readonly ProblemRow[] | null): number | null {
  if (!rows) return null
  return rows.find((r) => r.key === 'decisions-waiting')?.count ?? 0
}

/** The Today board's rows that are problems to look at, worst first, as the board already orders them. */
export function problemRows<T extends ProblemRow>(rows: readonly T[] | null): T[] | null {
  return rows ? rows.filter((r) => !NOT_A_PROBLEM.has(r.key)) : null
}

/** "1 critical · 2 need attention · 1 worth knowing", or "Nothing needs you". */
export function problemHint(rows: readonly ProblemRow[]): string {
  const n = (s: ProblemRow['severity']) => rows.filter((r) => r.severity === s).length
  const parts = [
    n('critical') > 0 ? `${n('critical')} critical` : null,
    n('warning') > 0 ? `${n('warning')} need${n('warning') === 1 ? 's' : ''} attention` : null,
    n('info') > 0 ? `${n('info')} worth knowing` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing needs you'
}
