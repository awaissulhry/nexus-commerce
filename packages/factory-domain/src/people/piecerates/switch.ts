import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import type { MonitoringBasis, ScanSubject } from '../../production/settings/monitoring'
import { reasonProblems } from './rates'

/**
 * The legal switch of piece pay at a site (B-W2b-34; W2b plan §3 GATE-PIECE-PAY; design people.piecerates "Legal switch"
 * and the pop-up "Start piece pay"; factory-db PiecePaySwitch, one row per site with the site's own id, OFF by default).
 * Piece pay starts only when every precondition is on record, from a day not in the past, with a fresh code; it stops
 * at any time without one (narrowing is always allowed), and the pay of an earlier window stays payable.
 *
 * The preconditions, in the order the screen lists them (each with the law it rests on and where it is kept):
 *   SITE_BASIS        the site's scans name workers, with a legal basis on record (Production › Settings)    Statuto art. 4 c.1
 *   PERFORMANCE_GATE  the site's legal gate for one person's work figures is on (People › Settings)          Statuto art. 4 c.1
 *   WORKER_NOTICE     the company's published worker notice that covers piece pay (Admin › Privacy)         art. 4 c.3; GDPR art. 13
 *   DPIA              the company's stored impact assessment that covers it (Admin › Privacy)               GDPR art. 35
 *   CCNL              the CCNL and its article that allow piece work                                          c.c. art. 2100
 *   CONSULTANT        the labour consultant who agreed the scheme, the make-up and the statement, and when   GATE-PIECE-PAY
 *   SCHEME            an ACTIVE incentive scheme of the company (its own or a line's of the site) in force   c.c. arts. 2099-2100
 *                     on the first day (the guaranteed pay piece pay is made up to)
 *   RATES_PUBLISHED   rates in force on the first day, published to every active worker of the site         c.c. art. 2101
 *   EARNING_CODES     the company's earning codes mapped to the payroll provider's codes                      the payroll export
 * The database checks the first seven again when the switch turns ON (…_pay_w2b_guards); the last two are counted here.
 * The worker notice's acknowledgements (n of m) are shown, never a block: the law asks that the workers are told.
 */

export const PRECONDITION_CODES = ['SITE_BASIS', 'PERFORMANCE_GATE', 'WORKER_NOTICE', 'DPIA', 'CCNL', 'CONSULTANT', 'SCHEME', 'RATES_PUBLISHED', 'EARNING_CODES'] as const
export type PreconditionCode = (typeof PRECONDITION_CODES)[number]

export const PRECONDITION_LAW: Readonly<Record<PreconditionCode, string>> = Object.freeze({
  SITE_BASIS: 'Statuto dei Lavoratori art. 4 c.1',
  PERFORMANCE_GATE: 'Statuto dei Lavoratori art. 4 c.1',
  WORKER_NOTICE: 'Statuto dei Lavoratori art. 4 c.3; GDPR art. 13',
  DPIA: 'GDPR art. 35',
  CCNL: 'c.c. art. 2100',
  CONSULTANT: "The labour consultant's agreement (GATE-PIECE-PAY)",
  SCHEME: 'c.c. arts. 2099-2100',
  RATES_PUBLISHED: 'c.c. art. 2101',
  EARNING_CODES: 'The payroll export (GATE-PAYROLL)',
})

/** Where each precondition is kept (the navigation tree's page id); null: on this switch. */
export const PRECONDITION_PAGE: Readonly<Record<PreconditionCode, string | null>> = Object.freeze({
  SITE_BASIS: 'production.settings',
  PERFORMANCE_GATE: 'people.settings',
  WORKER_NOTICE: 'admin.privacy',
  DPIA: 'admin.privacy',
  CCNL: null,
  CONSULTANT: null,
  SCHEME: 'people.piecerates',
  RATES_PUBLISHED: 'people.piecerates',
  EARNING_CODES: 'people.payroll',
})

export const SWITCH_STATES = ['OFF', 'ON'] as const
export type SwitchState = (typeof SWITCH_STATES)[number]
export const TEXT_MAX = 200
export const NOTE_MAX = 2000

/** What the site and the company have on record towards piece pay (read by the API, judged here). */
export interface SwitchFacts {
  readonly today: BusinessDate
  /** The first day asked (the start), or today for the readiness shown before one is chosen. */
  readonly onFrom: BusinessDate
  readonly scanSubject: ScanSubject
  readonly siteBasis: { readonly kind: MonitoringBasis; readonly reference: string } | null
  readonly performanceGateOpen: boolean
  /** The preconditions recorded on the switch. */
  readonly ccnlName: string | null
  readonly ccnlArticle: string | null
  readonly workerNotice: { readonly id: string; readonly label: string; readonly kind: string; readonly status: string } | null
  readonly dpia: { readonly id: string; readonly versionNo: number; readonly status: string } | null
  readonly consultantName: string | null
  readonly consultantAgreedOn: BusinessDate | null
  readonly scheme: { readonly id: string; readonly name: string; readonly status: string; readonly siteId: string | null; readonly validFrom: BusinessDate; readonly validTo: BusinessDate | null } | null
  readonly siteId: string
  /** The rates: versions of the site's ACTIVE tables in force on the first day, and the ACTIVE workers not told them. */
  readonly ratesInForce: number
  readonly activeWorkers: number
  readonly workersNotTold: number
  /** The company's ACTIVE earning code mappings, and the codes with no provider code yet. */
  readonly earningCodes: number
  readonly unmappedEarningCodes: readonly string[]
}

export interface Precondition {
  readonly code: PreconditionCode
  readonly met: boolean
  readonly law: string
  readonly page: string | null
  readonly words: string
}

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''

/** Each precondition, met or not, in words (the design's LegalGate rows: "held with the missing items in words"). */
export function preconditionsOf(facts: SwitchFacts): Precondition[] {
  const item = (code: PreconditionCode, met: boolean, words: string): Precondition => ({ code, met, law: PRECONDITION_LAW[code], page: PRECONDITION_PAGE[code], words })
  const scheme = facts.scheme
  const schemeFits = scheme !== null && scheme.status === 'ACTIVE' && (scheme.siteId === null || scheme.siteId === facts.siteId) && scheme.validFrom <= facts.onFrom && (scheme.validTo === null || facts.onFrom <= scheme.validTo)
  return [
    item(
      'SITE_BASIS',
      facts.scanSubject === 'WORKER' && facts.siteBasis !== null,
      facts.scanSubject !== 'WORKER'
        ? "The site's scans record the station, not the worker: piece pay needs them to name workers, with a legal basis on record (Production › Settings)."
        : facts.siteBasis === null
          ? "The site's scans name workers but no legal basis is on record (a union agreement, the Ispettorato's authorisation or counsel's opinion; Production › Settings)."
          : `The site's scans name workers on a recorded basis (${facts.siteBasis.reference}).`,
    ),
    item(
      'PERFORMANCE_GATE',
      facts.performanceGateOpen,
      facts.performanceGateOpen ? "One person's work figures are switched on at this site." : "One person's work figures are switched off at this site: switch them on first (People › Settings)."
    ),
    item(
      'WORKER_NOTICE',
      facts.workerNotice !== null && facts.workerNotice.kind === 'WORKER_FLOOR' && facts.workerNotice.status === 'PUBLISHED',
      facts.workerNotice === null
        ? 'Name the worker notice that tells the workers about piece pay (Admin › Privacy & notices).'
        : facts.workerNotice.status !== 'PUBLISHED'
          ? `The worker notice ${facts.workerNotice.label} is ${facts.workerNotice.status.toLowerCase()}: name the one in force.`
          : `The worker notice ${facts.workerNotice.label} covers piece pay.`,
    ),
    item(
      'DPIA',
      facts.dpia !== null && facts.dpia.status === 'STORED',
      facts.dpia === null
        ? 'Name the impact assessment that covers piece pay (Admin › Privacy & notices).'
        : facts.dpia.status !== 'STORED'
          ? `Impact assessment version ${facts.dpia.versionNo} is ${facts.dpia.status.toLowerCase()}: name a stored one.`
          : `Impact assessment version ${facts.dpia.versionNo} covers piece pay.`,
    ),
    item(
      'CCNL',
      filled(facts.ccnlName) && filled(facts.ccnlArticle),
      filled(facts.ccnlName) && filled(facts.ccnlArticle) ? `${facts.ccnlName}, ${facts.ccnlArticle}.` : 'Record the CCNL and the article of it that allows piece work.',
    ),
    item(
      'CONSULTANT',
      filled(facts.consultantName) && facts.consultantAgreedOn !== null && facts.consultantAgreedOn <= facts.today,
      !filled(facts.consultantName) || facts.consultantAgreedOn === null
        ? 'Record the labour consultant who agreed the scheme, the make-up and the statement, and the day.'
        : facts.consultantAgreedOn > facts.today
          ? `The labour consultant's agreement is dated ${facts.consultantAgreedOn}, later than today.`
          : `${facts.consultantName} agreed on ${facts.consultantAgreedOn}.`,
    ),
    item(
      'SCHEME',
      schemeFits,
      scheme === null
        ? 'Name the incentive scheme piece pay starts with (its guaranteed pay is the labour consultant\'s).'
        : scheme.status !== 'ACTIVE'
          ? `The scheme "${scheme.name}" is ${scheme.status.toLowerCase()}: it must be active.`
          : scheme.siteId !== null && scheme.siteId !== facts.siteId
            ? `The scheme "${scheme.name}" is for a line of another site.`
            : !schemeFits
              ? `The scheme "${scheme.name}" is not in force on ${facts.onFrom} (from ${scheme.validFrom}${scheme.validTo ? ` to ${scheme.validTo}` : ''}).`
              : `The scheme "${scheme.name}" is in force from ${scheme.validFrom}.`,
    ),
    item(
      'RATES_PUBLISHED',
      facts.ratesInForce > 0 && facts.workersNotTold === 0 && facts.activeWorkers > 0,
      facts.ratesInForce === 0
        ? `No rate version is in force on ${facts.onFrom}: publish the rates to the workers and put them in force first.`
        : facts.activeWorkers === 0
          ? 'The site has no active worker to tell the rates to.'
          : facts.workersNotTold > 0
            ? `${facts.workersNotTold} of ${facts.activeWorkers} active workers have not been given the rates in force on ${facts.onFrom}: publish them to them before work starts.`
            : `The rates in force on ${facts.onFrom} were published to all ${facts.activeWorkers} active workers.`,
    ),
    item(
      'EARNING_CODES',
      facts.earningCodes > 0 && facts.unmappedEarningCodes.length === 0,
      facts.earningCodes === 0
        ? "The company has no earning code for the payroll export yet (People › Payroll export)."
        : facts.unmappedEarningCodes.length > 0
          ? `Earning codes not mapped to the payroll provider's codes yet: ${facts.unmappedEarningCodes.join(', ')}.`
          : `Every earning code (${facts.earningCodes}) is mapped for the payroll export.`,
    ),
  ]
}

/** The switch's own window as the rules read it. */
export interface SwitchWindow {
  readonly state: SwitchState
  readonly onFrom: BusinessDate | null
  readonly offFrom: BusinessDate | null
}

/** "Start piece pay at <site> from <day>": refused in words until every precondition is met, from a day to come. */
export function startProblems(input: { readonly facts: SwitchFacts; readonly window: SwitchWindow; readonly reason: string | null | undefined }): Issue[] {
  const { facts, window } = input
  if (window.state === 'ON') return [{ path: 'state', message: `Piece pay is on at this site already (from ${window.onFrom ?? '?'}).` }]
  const problems: Issue[] = []
  if (!isBusinessDate(facts.onFrom)) problems.push({ path: 'onFrom', message: 'The first day is a calendar day written YYYY-MM-DD.' })
  else {
    if (facts.onFrom < facts.today) problems.push({ path: 'onFrom', message: `Piece pay starts from today (${facts.today}) or a later day, never in the past.` })
    if (window.offFrom !== null && facts.onFrom < window.offFrom) problems.push({ path: 'onFrom', message: `The last window ended on ${window.offFrom}; start from that day or later.` })
  }
  for (const precondition of preconditionsOf(facts)) if (!precondition.met) problems.push({ path: `preconditions/${precondition.code}`, message: precondition.words })
  problems.push(...reasonProblems(input.reason))
  return problems
}

/** The first day piece pay no longer counts when it is stopped now: today, or its first day if that is still to come. */
export const stopDayOf = (onFrom: BusinessDate, today: BusinessDate): BusinessDate => (onFrom > today ? onFrom : today)

/** The earlier windows once a closed window is followed by a new one: the old list and the window just closed. */
export function windowsAfterRestart(earlier: readonly { readonly from: string; readonly to: string }[], closed: SwitchWindow): { from: string; to: string }[] {
  return closed.onFrom !== null && closed.offFrom !== null ? [...earlier, { from: closed.onFrom, to: closed.offFrom }] : [...earlier]
}

/** What recording the preconditions breaks (lengths and days; whether they are met is preconditionsOf). */
export function preconditionTextProblems(input: {
  readonly ccnlName?: string | null | undefined
  readonly ccnlArticle?: string | null | undefined
  readonly consultantName?: string | null | undefined
  readonly consultantAgreedOn?: string | null | undefined
  readonly preconditionsNote?: string | null | undefined
}): Issue[] {
  const problems: Issue[] = []
  for (const field of ['ccnlName', 'ccnlArticle', 'consultantName'] as const) {
    const value = input[field]
    if (typeof value === 'string' && value.trim().length > TEXT_MAX) problems.push({ path: field, message: `At most ${TEXT_MAX} characters.` })
  }
  if (typeof input.preconditionsNote === 'string' && input.preconditionsNote.trim().length > NOTE_MAX) problems.push({ path: 'preconditionsNote', message: `At most ${NOTE_MAX} characters.` })
  if (input.consultantAgreedOn !== undefined && input.consultantAgreedOn !== null && !isBusinessDate(input.consultantAgreedOn)) problems.push({ path: 'consultantAgreedOn', message: 'A calendar day written YYYY-MM-DD.' })
  return problems
}
