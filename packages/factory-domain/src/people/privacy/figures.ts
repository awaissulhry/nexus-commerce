import type { Issue } from '../../core/errors'
import { gateClosedWords } from './gate'
import type { GatePurpose } from './purposes'

/**
 * One person's figures stay private (B-W2b-27; feature MES-249 "individual efficiency is shown only to the worker, their
 * lead and HR; boards show line totals"; Owner answer H3 "at a site with the legal basis in place, who sees one worker's
 * efficiency? The worker and HR"; design people.settings "worker + HR, or worker + lead + HR (only when the recorded
 * legal basis covers leads)", people.efficiency "One person's figures": opened per person with a purpose, recorded,
 * no comparison, no export, no print; Statuto dei Lavoratori art. 4; GDPR art. 5).
 *
 * Who may open one person's figures for a purpose (ATTENDANCE or PERFORMANCE), in this order:
 *   1. the site's legal gate for the purpose is open (else nobody, not even the worker: GATE_CLOSED);
 *   2. the worker themselves (SELF; on the floor, My day);
 *   3. a person holding a role the company's People settings name (figureRoleKeys: HR by H3; empty by default, so
 *      nobody but the worker) over the person's company and site, with people.figures.view (FIGURE_ROLE);
 *   4. the lead of the person's team, where the site's gate lets leads see them (the recorded basis covers leads and
 *      the per-site choice is on), with people.figures.view in the office or floor.lead on the floor (LEAD);
 *   anyone else: NOT_ALLOWED. Opening someone else's figures needs a reason from OPEN_REASONS; the API writes every
 *   opening down (who, whose, which purpose, why) for HR and the data protection officer.
 */

export const FIGURE_ACCESS = ['SELF', 'FIGURE_ROLE', 'LEAD'] as const
export type FigureAccess = (typeof FIGURE_ACCESS)[number]

export const FIGURE_REFUSALS = ['GATE_CLOSED', 'NOT_ALLOWED'] as const
export type FigureRefusal = (typeof FIGURE_REFUSALS)[number]

/** Why someone else's figures are opened (design people.efficiency pop-up "purpose"). */
export const OPEN_REASONS = ['COACHING_ASKED', 'PAY_QUERY', 'WORKER_REQUEST'] as const
export type OpenReason = (typeof OPEN_REASONS)[number]

export const OPEN_REASON_WORDS: Readonly<Record<OpenReason, string>> = Object.freeze({
  COACHING_ASKED: 'Coaching the worker asked for',
  PAY_QUERY: 'A pay query',
  WORKER_REQUEST: "The worker's own request",
})

export const OPEN_NOTE_MAX = 500

export interface FigureViewer {
  /** The viewer is the person the figures are about. */
  readonly isSubject: boolean
  /** The viewer holds a role the company's People settings name, over the person's company and site, and may open figures. */
  readonly holdsFigureRole: boolean
  /** The viewer leads a team the person belongs to now, and may open figures. */
  readonly leadsSubject: boolean
}

export interface FigureGate {
  readonly open: boolean
  /** The site lets leads see one person's figures (the basis covers leads and the per-site choice is on). */
  readonly leadsSeeFigures: boolean
}

export type FigureDecision =
  | { readonly allowed: true; readonly as: FigureAccess; readonly needsReason: boolean }
  | { readonly allowed: false; readonly code: FigureRefusal; readonly words: string }

export const NOT_ALLOWED_WORDS =
  "One person's figures are seen only by the worker, by the roles People settings name (HR) and, where the site allows it, by the worker's team lead (Statuto dei Lavoratori art. 4)."

/** Who may open one person's figures for a purpose (see the module's comment). */
export function personFigureAccess(purpose: GatePurpose, gate: FigureGate, viewer: FigureViewer): FigureDecision {
  if (!gate.open) return { allowed: false, code: 'GATE_CLOSED', words: gateClosedWords(purpose) }
  if (viewer.isSubject) return { allowed: true, as: 'SELF', needsReason: false }
  if (viewer.holdsFigureRole) return { allowed: true, as: 'FIGURE_ROLE', needsReason: true }
  if (viewer.leadsSubject && gate.leadsSeeFigures) return { allowed: true, as: 'LEAD', needsReason: true }
  return { allowed: false, code: 'NOT_ALLOWED', words: NOT_ALLOWED_WORDS }
}

/** Everything wrong with an opening's reason: someone else's figures need one of OPEN_REASONS; the note is optional. */
export function openReasonProblems(decision: FigureDecision, reason: unknown, note: unknown): Issue[] {
  if (!decision.allowed || !decision.needsReason) return []
  const problems: Issue[] = []
  if (!(OPEN_REASONS as readonly unknown[]).includes(reason)) {
    problems.push({ path: 'body/reason', message: `Say why you open this person's figures: ${OPEN_REASONS.map((code) => OPEN_REASON_WORDS[code].toLowerCase()).join(', ')}.` })
  }
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.trim().length > OPEN_NOTE_MAX)) {
    problems.push({ path: 'body/note', message: `Keep the note to ${OPEN_NOTE_MAX} characters.` })
  }
  return problems
}

const ROLE_KEY = /^[a-z][a-z0-9_.-]*$/

/** The roles People settings may name: office roles of the tenant, by key. */
export interface NameableRole {
  readonly key: string
  readonly audience: 'OFFICE' | 'FLOOR'
}

/** Everything wrong with the roles named to see one person's figures (each an office role of the tenant, once). */
export function figureRoleKeysProblems(keys: readonly unknown[], roles: readonly NameableRole[], at = 'body/figureRoleKeys'): Issue[] {
  const problems: Issue[] = []
  const byKey = new Map(roles.map((role) => [role.key, role]))
  const seen = new Set<string>()
  keys.forEach((key, index) => {
    if (typeof key !== 'string' || !ROLE_KEY.test(key)) {
      problems.push({ path: `${at}/${index}`, message: 'Name a role by its key.' })
      return
    }
    if (seen.has(key)) problems.push({ path: `${at}/${index}`, message: `The role ${key} is named twice.` })
    seen.add(key)
    const role = byKey.get(key)
    if (!role) problems.push({ path: `${at}/${index}`, message: `There is no role ${key}.` })
    else if (role.audience !== 'OFFICE') problems.push({ path: `${at}/${index}`, message: `The role ${key} is a floor role: one person's figures are seen on the floor only by the worker themselves.` })
  })
  return problems
}

export type FigureRolesChange = 'WIDEN' | 'NARROW' | 'NONE'

/** Naming a role that was not named widens (a step-up), even when another one leaves; only removing narrows. */
export function figureRolesChangeOf(from: readonly string[], to: readonly string[]): FigureRolesChange {
  const before = new Set(from)
  const after = new Set(to)
  if ([...after].some((key) => !before.has(key))) return 'WIDEN'
  if ([...before].some((key) => !after.has(key))) return 'NARROW'
  return 'NONE'
}

/** What the viewer sees on a People page, said before anything is read (design PrivacyNote "What you see here"). */
export const SIGHT_LEVELS = ['GROUPS_ONLY', 'ONE_PERSON_ON_REQUEST'] as const
export type SightLevel = (typeof SIGHT_LEVELS)[number]

export function sightWords(input: { readonly purpose: GatePurpose; readonly gateOpen: boolean; readonly level: SightLevel; readonly minimumGroup: number; readonly leadsSeeFigures: boolean }): string[] {
  const words = [`Figures show per line, team or shift; a group of fewer than ${input.minimumGroup} people shows '—': too few people to show without identifying them.`]
  if (!input.gateOpen) {
    words.push(gateClosedWords(input.purpose))
    return words
  }
  words.push(
    input.level === 'ONE_PERSON_ON_REQUEST'
      ? "You may open one person's figures on request, with a reason; every opening is recorded and visible to HR and the data protection officer."
      : "One person's figures are seen only by the worker and by HR" + (input.leadsSeeFigures ? ", and by the worker's team lead at this site." : '.'),
  )
  return words
}
