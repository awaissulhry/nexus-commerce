import { isBusinessDate, type BusinessDate } from '../../core/time'
import type { Issue } from '../../core/errors'
import { addDays, daysBetween } from '../certificates/rules'

/**
 * The register of laws and standards in use and the harmonised-standard watch (B-W2b-249; PRD-273, PRD-274; PPE Reg.
 * (EU) 2016/425 Annex V 7.1-7.3; design compliance.settings › rm-regs), pure. The tables are B-W2b-216's
 * (RegulationOrStandard, StandardChange); the database holds their shape and the watch's order (OPEN → ASSESSED → CLOSED,
 * the assessment filed once, a closed change frozen). Here: the words and choices the API makes before it writes.
 *
 * One register entry per edition: code ("EN 17092-4") + edition ("2020"). W1's certificates type their standard as one
 * text ("EN 17092-4:2020"); `namesEntry` matches the two. Nobody reads the Official Journal or NANDO for the factory (no
 * paid feed, GATE-SPEND): a person notices a change and records it. A new edition or a withdrawal entered in the register
 * (the entry moved to SUPERSEDED or WITHDRAWN) raises a change by itself (`raisedKind`), naming the registered certificates
 * that cite the entry; a person then assesses its impact, may open W2a's type-change review for the certificates that
 * need the notified body again, opens the impact task that lists the affected styles, and closes it.
 */

export const REGULATION_KINDS = ['REGULATION', 'DIRECTIVE', 'HARMONISED_STANDARD', 'STANDARD', 'NATIONAL_LAW', 'GUIDANCE'] as const
export type RegulationKind = (typeof REGULATION_KINDS)[number]
export const REGULATION_STATUSES = ['IN_FORCE', 'SUPERSEDED', 'WITHDRAWN'] as const
export type RegulationStatus = (typeof REGULATION_STATUSES)[number]
export const CHANGE_KINDS = ['REVISION', 'AMENDMENT', 'WITHDRAWAL', 'NEW_CITATION', 'OTHER'] as const
export type StandardChangeKind = (typeof CHANGE_KINDS)[number]
export const CHANGE_STATUSES = ['OPEN', 'ASSESSED', 'CLOSED'] as const
export type StandardChangeStatus = (typeof CHANGE_STATUSES)[number]
export const IMPACTS = ['NONE', 'REVIEW', 'RETEST'] as const
export type StandardChangeImpact = (typeof IMPACTS)[number]

/** The certificate statuses a change names: registered and in force (the database refuses a DRAFT one). */
export const TOUCHED_CERTIFICATE_STATUSES = ['VALID', 'SUSPENDED'] as const

export const CODE_MAX = 100
export const EDITION_MAX = 40
export const TITLE_MAX = 300
export const OJ_MAX = 200
export const NOTE_MAX = 2000
export const WORDS_MAX = 4000
export const SOURCE_MAX = 300
/** Days before a transition period ends when the watch says "ends soon". */
export const TRANSITION_SOON_DAYS = 30

const ONE_LINE = /^[^\p{Cc}]+$/u
const HTTPS = /^https:\/\/[^\s\p{Cc}]+$/u

/** The entry as a certificate types it: "EN 17092-4:2020"; an entry without an edition: its code. */
export const standardLabel = (code: string, edition: string | null): string => (edition ? `${code}:${edition}` : code)

const squeeze = (text: string): string => text.trim().replace(/\s+/g, ' ').replace(/\s*:\s*/g, ':').toUpperCase()

/** Whether a certificate's typed standard names this entry (spaces, the colon's spacing and case aside). */
export function namesEntry(typed: string, entry: { readonly code: string; readonly edition: string | null }): boolean {
  return squeeze(typed) === squeeze(standardLabel(entry.code, entry.edition))
}

/** The change a status move raises by itself: a new edition took over (REVISION) or the entry was withdrawn. */
export function raisedKind(from: RegulationStatus, to: RegulationStatus): StandardChangeKind | null {
  if (from === to) return null
  if (to === 'SUPERSEDED') return 'REVISION'
  if (to === 'WITHDRAWN') return 'WITHDRAWAL'
  return null
}

/** Where a change's transition period stands on a day: none given, running, ending within 30 days, or ended. */
export function transitionState(endsOn: BusinessDate | null, today: BusinessDate): 'NONE' | 'RUNNING' | 'ENDS_SOON' | 'ENDED' {
  if (endsOn === null) return 'NONE'
  if (endsOn < today) return 'ENDED'
  return daysBetween(today, endsOn) <= TRANSITION_SOON_DAYS ? 'ENDS_SOON' : 'RUNNING'
}

export interface EntryDraft {
  readonly code?: string | undefined
  readonly edition?: string | null | undefined
  readonly title?: string | undefined
  readonly titleI18n?: Readonly<Record<string, string>> | null | undefined
  readonly ojReference?: string | null | undefined
  readonly ojDate?: string | null | undefined
  readonly link?: string | null | undefined
  readonly note?: string | null | undefined
  readonly status?: RegulationStatus | undefined
  readonly supersededById?: string | null | undefined
}

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/

/** What is wrong with an entry's typed fields, in words (paths under `body/`). Only the fields given are checked. */
export function entryProblems(draft: EntryDraft): Issue[] {
  const problems: Issue[] = []
  const text = (path: string, value: string | null | undefined, max: number, what: string) => {
    if (value === undefined || value === null) return
    if (value.trim() === '' || value.length > max || !ONE_LINE.test(value)) problems.push({ path: `body/${path}`, message: `${what}: 1 to ${max} characters on one line.` })
  }
  text('code', draft.code, CODE_MAX, 'The code ("EN 17092-4", "Reg. (EU) 2016/425")')
  text('edition', draft.edition, EDITION_MAX, 'The edition ("2020")')
  text('title', draft.title, TITLE_MAX, 'The title')
  text('ojReference', draft.ojReference, OJ_MAX, 'The Official Journal citation ("OJ L 77, 5.3.2021")')
  if (draft.code !== undefined && /:/.test(draft.code)) problems.push({ path: 'body/code', message: 'Write the edition apart: code "EN 17092-4", edition "2020".' })
  if (draft.titleI18n) {
    for (const [language, words] of Object.entries(draft.titleI18n)) {
      if (!LANGUAGE.test(language) || words.trim() === '' || words.length > TITLE_MAX) problems.push({ path: `body/titleI18n/${language}`, message: `A title per language ("it", "en"): 1 to ${TITLE_MAX} characters.` })
    }
  }
  if (draft.ojDate !== undefined && draft.ojDate !== null && !isBusinessDate(draft.ojDate)) problems.push({ path: 'body/ojDate', message: 'A day (YYYY-MM-DD).' })
  if (draft.link !== undefined && draft.link !== null && (draft.link.length > 2000 || !HTTPS.test(draft.link))) problems.push({ path: 'body/link', message: 'An https address without spaces (EUR-Lex, the standard body’s page).' })
  if (draft.note !== undefined && draft.note !== null && (draft.note.trim() === '' || draft.note.length > NOTE_MAX)) problems.push({ path: 'body/note', message: `A note of 1 to ${NOTE_MAX} characters, or none.` })
  if (draft.supersededById && draft.status !== undefined && draft.status !== 'SUPERSEDED') problems.push({ path: 'body/supersededById', message: 'Only a SUPERSEDED entry names the edition that took its place.' })
  return problems
}

// ---- the impact task (design rm-regs "Change watch: … an impact task lists the affected styles") ------------------------

export type Locale = 'it' | 'en'

export interface ImpactTaskFacts {
  /** "EN 17092-3:2020" */
  readonly standard: string
  readonly kind: StandardChangeKind
  readonly whatChanged: string
  readonly transitionEndsOn: BusinessDate | null
  /** The affected styles: code and name, through the certificates the change names. */
  readonly styles: readonly { readonly code: string; readonly name: string; readonly certificate: string }[]
}

const KIND_WORDS: Readonly<Record<Locale, Readonly<Record<StandardChangeKind, string>>>> = {
  en: { REVISION: 'revised', AMENDMENT: 'amended', WITHDRAWAL: 'withdrawn', NEW_CITATION: 'newly cited in the Official Journal', OTHER: 'changed' },
  it: { REVISION: 'revisionata', AMENDMENT: 'modificata', WITHDRAWAL: 'ritirata', NEW_CITATION: 'citata di nuovo nella Gazzetta ufficiale', OTHER: 'cambiata' },
}

/** At most this many styles are one checklist item each; the rest are counted in the description. */
export const TASK_STYLES_MAX = 40

/** The impact task's words: what changed, by when, and one checklist item per affected style. */
export function impactTask(facts: ImpactTaskFacts, locale: Locale): { title: string; description: string; checklist: string[]; dueDate: BusinessDate | null } {
  const shown = facts.styles.slice(0, TASK_STYLES_MAX)
  const more = facts.styles.length - shown.length
  const what = facts.whatChanged.length > 600 ? `${facts.whatChanged.slice(0, 597)}…` : facts.whatChanged
  const due = facts.transitionEndsOn ? addDays(facts.transitionEndsOn, -TRANSITION_SOON_DAYS) : null
  if (locale === 'it') {
    return {
      title: `Norma ${facts.standard} ${KIND_WORDS.it[facts.kind]}: controllare i modelli`,
      description: [
        `${what}`,
        facts.transitionEndsOn ? `Il periodo di transizione finisce il ${facts.transitionEndsOn}.` : null,
        facts.styles.length === 0 ? 'Nessun certificato registrato cita questa norma: nessun modello da controllare.' : `Modelli coperti dai certificati che citano la norma: ${facts.styles.length}.${more > 0 ? ` Qui ne sono elencati ${shown.length}; gli altri nel controllo della norma.` : ''}`,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
      checklist: shown.map((style) => `${style.code} ${style.name} (certificato ${style.certificate}): controllare contro la nuova versione`),
      dueDate: due,
    }
  }
  return {
    title: `Standard ${facts.standard} ${KIND_WORDS.en[facts.kind]}: check the styles`,
    description: [
      `${what}`,
      facts.transitionEndsOn ? `The transition period ends on ${facts.transitionEndsOn}.` : null,
      facts.styles.length === 0 ? 'No registered certificate cites this standard: no style to check.' : `Styles covered by the certificates that cite it: ${facts.styles.length}.${more > 0 ? ` ${shown.length} are listed here; the rest in the standard's watch.` : ''}`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
    checklist: shown.map((style) => `${style.code} ${style.name} (certificate ${style.certificate}): check against the new edition`),
    dueDate: due,
  }
}

// ---- assessing (Annex V 7.2: the notified body is told of changes that may affect the approved type) --------------------

/** What a type-change review opened by a standard change says changed (W2a's `changes` entry, kind OTHER). */
export function reviewChangeEntry(standard: string, kind: StandardChangeKind, newStandard: string | null): { kind: 'OTHER'; what: string; before: string; after: string; bomLineId: null } {
  const after = newStandard ?? (kind === 'WITHDRAWAL' ? 'withdrawn' : `${standard} (${KIND_WORDS.en[kind]})`)
  return { kind: 'OTHER', what: 'Standard', before: standard, after, bomLineId: null }
}

/**
 * Why an assessment is refused, in words (null: fine): reviews are opened only for a change whose impact asks the
 * notified body (REVIEW or RETEST), and only for certificates the change names.
 */
export function assessRefusal(input: { readonly status: StandardChangeStatus; readonly impact: StandardChangeImpact; readonly reviewCertificateIds: readonly string[]; readonly named: readonly string[] }): { code: string; message: string } | null {
  if (input.status !== 'OPEN') return { code: 'NOT_OPEN', message: `This change is ${input.status}: its assessment is filed already.` }
  if (input.impact === 'NONE' && input.reviewCertificateIds.length > 0) return { code: 'NO_REVIEW_FOR_NONE', message: 'An impact of NONE opens no type-change review: choose REVIEW or RETEST, or leave the certificates out.' }
  const stranger = input.reviewCertificateIds.find((id) => !input.named.includes(id))
  if (stranger) return { code: 'NOT_NAMED', message: 'A type-change review is opened only for a certificate this change names: add the certificate to the change first.' }
  return null
}
