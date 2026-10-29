import type { Issue } from '../../core/errors'

/**
 * The quality release of finished garments, four eyes as a setting, the reversal and goods on hold (B-W1-45; QHS-051,
 * QHS-058, QHS-073, QHS-300, PLT-097; Owner answers Q1 (a), Q3 (a); Reg. (EU) 2016/425 arts. 8, 15; design
 * quality.inspections ins-release, ins-reverse, dec-sod, floor.final): pure rules, figures by hand in release.vitest.test.ts.
 *
 *   the gate       a release of N garments of one cell (colourway × size) from a PASSED inspection passes every check
 *                  at once, or is refused with every open one in words (PLT-097: "says exactly what is missing"): the
 *                  work order is released, in progress or completed; the inspection PASSED; N fits the cell (its
 *                  pieces less what is released, less reversals) and the inspection's lot (its releases, reversed ones
 *                  too: a reworked garment is released again only from a new inspection); a serial-tracked cell names
 *                  N of its MADE, unpacked serials; the garment labels are printed (BATCH: the cell's printed labels
 *                  hold every released garment; SERIAL: each serial's label); the certificate gate covers the cell
 *                  today (QHS-051); the DoC and the leaflet of the work order's style revision are on file (PPE, the
 *                  style compliance step's words); no material lot the work order took is on hold (quarantine, blocked,
 *                  rejected, a chromium VI FAIL); the releaser made none of the garments; and, where four eyes apply,
 *                  is not the inspector who signed the result.
 *   four eyes      (Q1 (a)) the inspection's decision is the first signature, the release the second. An inspector who
 *                  made none of the garments releases alone; a second person is needed when the inspection overrode
 *                  its computed result (OVERRIDE), when the cell's customer is listed (CUSTOMER), or for every release
 *                  when the rule is ALWAYS (Q1 (b), a setting). The company's rule wins over the tenant-wide one; the
 *                  listed customers of both apply.
 *   the reversal   garments of one release that no shipment holds (packed or gone) are taken back with a reason's kind
 *                  and a note; a serial-tracked release names exactly those serials, which go to MADE (rework) or VOID
 *                  (scrap). Shipped garments cannot be pulled back here: a PPE register entry follows them.
 *   on hold        (Q3 (a), before the Holds page of W2a) the newest decided inspection of a work order FAILED, or its
 *                  released garments were taken back since: its garments are on hold until a new inspection passes.
 */

export const RELEASE_STATUSES = ['RELEASED', 'IN_PROGRESS', 'COMPLETED'] as const

export const RELEASE_CHECKS = ['WORK_ORDER', 'INSPECTION', 'QUANTITY', 'SERIALS', 'LABELS', 'CERTIFICATE', 'DOCUMENTS', 'LOTS', 'MAKER', 'SECOND_PERSON'] as const
export type ReleaseCheckCode = (typeof RELEASE_CHECKS)[number]
export const CHECK_STATES = ['OK', 'OPEN', 'NOT_NEEDED'] as const
export type CheckState = (typeof CHECK_STATES)[number]

export interface ReleaseCheck {
  readonly code: ReleaseCheckCode
  readonly state: CheckState
  /** What is true, in words. */
  readonly message: string
  /** OPEN: ONE thing to do about it; else null. */
  readonly fix: string | null
}

export const SECOND_PERSON_REASONS = ['OVERRIDE', 'CUSTOMER', 'ALWAYS'] as const
export type SecondPersonReason = (typeof SECOND_PERSON_REASONS)[number]
export const SECOND_PERSON_WORDS: Readonly<Record<SecondPersonReason, string>> = Object.freeze({
  OVERRIDE: 'the inspection overrode its computed result',
  CUSTOMER: "the customer's garments always need a second person",
  ALWAYS: "the company's rule asks a second person for every final release",
})

export const FOUR_EYES_RULES = ['WHEN_REQUIRED', 'ALWAYS'] as const
export type FourEyesRule = (typeof FOUR_EYES_RULES)[number]
/** Owner answer Q1 (a). */
export const DEFAULT_FOUR_EYES_RULE: FourEyesRule = 'WHEN_REQUIRED'
export const FOUR_EYES_WORDS: Readonly<Record<FourEyesRule, string>> = Object.freeze({
  WHEN_REQUIRED: 'An inspector who made none of the garments releases alone; a second person only for overrides and the listed customers.',
  ALWAYS: "Every final release needs a second person after the inspector's signature.",
})
export type SettingSource = 'COMPANY' | 'TENANT' | 'DEFAULT'

export interface FourEyesRow {
  readonly releaseFourEyes: FourEyesRule | null
  readonly secondPersonPartyIds: readonly string[]
}

export interface FourEyesInForce {
  readonly rule: FourEyesRule
  readonly source: SettingSource
  /** The customers of the company's list and of the tenant-wide one. */
  readonly partyIds: readonly string[]
}

/** The rule in force for a company: its own row's rule, else the tenant-wide row's, else the default; both lists. */
export function fourEyesInForce(company: FourEyesRow | null, tenant: FourEyesRow | null): FourEyesInForce {
  const rule = company?.releaseFourEyes ?? tenant?.releaseFourEyes ?? null
  const source: SettingSource = company?.releaseFourEyes ? 'COMPANY' : tenant?.releaseFourEyes ? 'TENANT' : 'DEFAULT'
  return { rule: rule ?? DEFAULT_FOUR_EYES_RULE, source, partyIds: [...new Set([...(company?.secondPersonPartyIds ?? []), ...(tenant?.secondPersonPartyIds ?? [])])].sort() }
}

/** Loosening: ALWAYS → WHEN_REQUIRED, or a customer taken off the list (asks for a reason and a fresh code). */
export function isFourEyesLoosening(before: FourEyesRow, after: FourEyesRow): boolean {
  const beforeRule = before.releaseFourEyes ?? DEFAULT_FOUR_EYES_RULE
  const afterRule = after.releaseFourEyes ?? DEFAULT_FOUR_EYES_RULE
  if (beforeRule === 'ALWAYS' && afterRule !== 'ALWAYS') return true
  const kept = new Set(after.secondPersonPartyIds)
  return before.secondPersonPartyIds.some((partyId) => !kept.has(partyId))
}

/** Why a release of this cell needs a second person (the database writes the same, QualityRelease.secondPersonReasons). */
export function secondPersonReasons(input: { readonly overridden: boolean; readonly rule: FourEyesRule; readonly customerListed: boolean }): SecondPersonReason[] {
  const reasons: SecondPersonReason[] = []
  if (input.overridden) reasons.push('OVERRIDE')
  if (input.customerListed) reasons.push('CUSTOMER')
  if (input.rule === 'ALWAYS') reasons.push('ALWAYS')
  return reasons
}

export const secondPersonText = (reasons: readonly SecondPersonReason[]): string => reasons.map((reason) => SECOND_PERSON_WORDS[reason]).join('; ')

// ---- the release gate ------------------------------------------------------------------------------------------------------

export interface LotOnHold {
  readonly code: string
  readonly qualityStatus: string
  readonly crViStatus: string
}

export interface ReleaseFacts {
  readonly workOrder: { readonly number: string; readonly status: string }
  readonly inspection: { readonly label: string; readonly status: string; readonly lotSize: number; readonly releasedFrom: number } | null
  readonly cell: { readonly label: string; readonly pieces: number; readonly netReleased: number }
  /** Garments asked; null: the gate as it stands (a read: how many could be released now). */
  readonly quantity: number | null
  readonly tracking: 'BATCH' | 'SERIAL'
  /** SERIAL: the serials named and what is wrong with them (in words); BATCH: none. */
  readonly serials: { readonly named: number; readonly problems: readonly string[]; readonly available: number }
  /** BATCH: the cell's printed labels (reprints apart); SERIAL: the named serials whose label is printed. */
  readonly labels: { readonly printed: number }
  readonly certificate: { readonly allowed: boolean; readonly words: string }
  /** The compliance step's blockers of shipping (DoC, leaflet), in its words; empty: on file (or not PPE). */
  readonly documents: readonly { readonly code: string; readonly message: string }[]
  readonly lotsOnHold: readonly LotOnHold[]
  /** The releaser's maker check: null when there is no releaser yet (a read for the record). */
  readonly maker: { readonly made: boolean; readonly words: string } | null
  readonly secondPerson: { readonly reasons: readonly SecondPersonReason[]; readonly releaserIsInspector: boolean | null }
}

const ok = (code: ReleaseCheckCode, message: string): ReleaseCheck => ({ code, state: 'OK', message, fix: null })
const open = (code: ReleaseCheckCode, message: string, fix: string): ReleaseCheck => ({ code, state: 'OPEN', message, fix })
const notNeeded = (code: ReleaseCheckCode, message: string): ReleaseCheck => ({ code, state: 'NOT_NEEDED', message, fix: null })

/** How many garments of the cell the inspection may still release: the cell's room and the lot's. */
export function releasable(facts: Pick<ReleaseFacts, 'inspection' | 'cell'>): number {
  const cellRoom = Math.max(0, facts.cell.pieces - facts.cell.netReleased)
  if (!facts.inspection || facts.inspection.status !== 'PASSED') return 0
  return Math.min(cellRoom, Math.max(0, facts.inspection.lotSize - facts.inspection.releasedFrom))
}

/** Every check of the release, in a fixed order (OPEN ones refuse it; the record shows them all). */
export function releaseChecks(facts: ReleaseFacts): ReleaseCheck[] {
  const checks: ReleaseCheck[] = []
  const wo = facts.workOrder
  checks.push(
    (RELEASE_STATUSES as readonly string[]).includes(wo.status)
      ? ok('WORK_ORDER', `Work order ${wo.number} is ${wo.status.toLowerCase().replace('_', ' ')}.`)
      : open('WORK_ORDER', `Work order ${wo.number} is ${wo.status.toLowerCase().replace('_', ' ')}: its garments are released while it is released, in progress or completed.`, 'Release the work order first, or reopen the work.'),
  )
  const inspection = facts.inspection
  checks.push(
    !inspection
      ? open('INSPECTION', 'No final inspection is named.', 'Inspect the garments first, then release from that inspection.')
      : inspection.status === 'PASSED'
        ? ok('INSPECTION', `${inspection.label} PASSED.`)
        : open('INSPECTION', `${inspection.label} is ${inspection.status}: only a PASSED inspection releases garments (QHS-058).`, inspection.status === 'OPEN' ? 'Sign the inspection first.' : 'Rework the garments, then inspect them again.'),
  )

  const room = releasable(facts)
  const cellRoom = Math.max(0, facts.cell.pieces - facts.cell.netReleased)
  const lotRoom = inspection ? Math.max(0, inspection.lotSize - inspection.releasedFrom) : 0
  const asked = facts.quantity
  if (asked === null) {
    checks.push(room > 0 ? ok('QUANTITY', `${room} garment(s) of ${facts.cell.label} can be released from this inspection.`) : open('QUANTITY', quantityWords(facts.cell.label, cellRoom, lotRoom, inspection?.lotSize ?? 0), quantityFix(cellRoom, lotRoom)))
  } else if (!Number.isInteger(asked) || asked < 1) {
    checks.push(open('QUANTITY', 'A release is of at least one garment.', 'Say how many garments to release.'))
  } else if (asked > room) {
    checks.push(open('QUANTITY', `${quantityWords(facts.cell.label, cellRoom, lotRoom, inspection?.lotSize ?? 0)} ${asked} asked.`, quantityFix(cellRoom, lotRoom)))
  } else {
    checks.push(ok('QUANTITY', `${asked} of the ${room} garment(s) of ${facts.cell.label} that can be released.`))
  }

  if (facts.tracking === 'SERIAL') {
    const wanted = asked ?? Math.min(room, facts.serials.available)
    if (facts.serials.problems.length > 0) checks.push(open('SERIALS', facts.serials.problems.join(' '), 'Scan or pick the serials of these garments again.'))
    else if (asked !== null && facts.serials.named !== asked) checks.push(open('SERIALS', `Name exactly ${asked} serial(s) of ${facts.cell.label}: ${facts.serials.named} named.`, 'Name one serial per garment released.'))
    else if (asked === null && facts.serials.available === 0) checks.push(open('SERIALS', `${facts.cell.label} has no serial ready to release (MADE, not on a shipment).`, 'Print the garment labels at the final operation first.'))
    else checks.push(ok('SERIALS', `${asked === null ? facts.serials.available : wanted} serial(s) of ${facts.cell.label} ready.`))
  } else {
    checks.push(notNeeded('SERIALS', 'The style traces its garments by batch: no serial is named.'))
  }

  if (facts.tracking === 'BATCH') {
    const need = facts.cell.netReleased + (asked ?? 1)
    checks.push(
      facts.labels.printed >= need
        ? ok('LABELS', `${facts.labels.printed} garment label(s) printed for ${facts.cell.label}; ${facts.cell.netReleased} released.`)
        : open(
            'LABELS',
            `${facts.cell.label} has ${facts.labels.printed} garment label(s) printed and ${facts.cell.netReleased} garment(s) released: ${asked === null ? 'no more' : `${asked}`} can be released until ${need - facts.labels.printed} more label(s) are printed (QHS-051: labels before packing).`,
            'Print the garment labels at the final operation first.',
          ),
    )
  } else {
    checks.push(
      asked !== null && facts.labels.printed < facts.serials.named
        ? open('LABELS', `${facts.serials.named - facts.labels.printed} of the serials named have no garment label printed.`, 'Print the garment labels at the final operation first.')
        : ok('LABELS', 'Each serial has its garment label printed.'),
    )
  }

  checks.push(facts.certificate.allowed ? ok('CERTIFICATE', facts.certificate.words) : open('CERTIFICATE', facts.certificate.words, 'Ask the compliance lead: the certificate must cover this colourway and size today.'))
  checks.push(
    facts.documents.length === 0
      ? ok('DOCUMENTS', 'The Declaration of Conformity and the user information are on file (or not needed).')
      : open('DOCUMENTS', facts.documents.map((document) => document.message).join(' '), "Put the signed DoC and leaflet of the style's revision on file (Compliance)."),
  )
  checks.push(
    facts.lotsOnHold.length === 0
      ? ok('LOTS', 'No material lot the work order took is on hold.')
      : open('LOTS', `Material lot(s) on hold: ${facts.lotsOnHold.map(lotWords).join('; ')}. Garments made from them are not released.`, 'Ask quality to decide the lot (release it, or reject it and rework the garments).'),
  )
  checks.push(
    facts.maker === null
      ? notNeeded('MAKER', 'The releaser is checked when they sign: never someone who made the garments.')
      : facts.maker.made
        ? open('MAKER', facts.maker.words, 'Another inspector, who made none of these garments, releases them.')
        : ok('MAKER', facts.maker.words),
  )
  const reasons = facts.secondPerson.reasons
  checks.push(
    reasons.length === 0
      ? notNeeded('SECOND_PERSON', 'An inspector who made none of the garments releases alone (Owner answer Q1 (a)).')
      : facts.secondPerson.releaserIsInspector === true
        ? open('SECOND_PERSON', `You signed the result; a second person must release it: ${secondPersonText(reasons)}.`, 'Another inspector, who made none of the garments, releases it.')
        : ok('SECOND_PERSON', `A second person releases it (${secondPersonText(reasons)}): ${facts.secondPerson.releaserIsInspector === false ? 'not the inspector who signed the result.' : 'someone other than the inspector who signed the result.'}`),
  )
  return checks
}

function quantityWords(label: string, cellRoom: number, lotRoom: number, lotSize: number): string {
  if (cellRoom <= lotRoom) return `${label} has ${cellRoom} garment(s) left to release (its pieces less what is released, less reversals).`
  return `The inspection judged a lot of ${lotSize}; ${lotRoom} garment(s) of it are left to release (a reversed garment is released again only from a new inspection).`
}
const quantityFix = (cellRoom: number, lotRoom: number): string => (cellRoom <= lotRoom ? 'Release fewer garments.' : 'Release fewer, or inspect the rest in a new inspection.')

const LOT_WORDS: Readonly<Record<string, string>> = Object.freeze({ QUARANTINE: 'in quarantine', BLOCKED: 'blocked', REJECTED: 'rejected' })
export const lotWords = (lot: LotOnHold): string => `${lot.code} ${lot.crViStatus === 'FAIL' ? 'failed chromium VI' : (LOT_WORDS[lot.qualityStatus] ?? lot.qualityStatus.toLowerCase())}`

/** A lot holds the garments made from it: not RELEASED, or a chromium VI FAIL. */
export const lotHolds = (lot: Pick<LotOnHold, 'qualityStatus' | 'crViStatus'>): boolean => lot.qualityStatus !== 'RELEASED' || lot.crViStatus === 'FAIL'

export const openChecks = (checks: readonly ReleaseCheck[]): ReleaseCheck[] => checks.filter((check) => check.state === 'OPEN')

/** The 409's issues of a refused release: `checks/<CODE>` with the words, then its fix. */
export function releaseRefusalIssues(checks: readonly ReleaseCheck[]): Issue[] {
  return openChecks(checks).flatMap((check) => [{ path: `checks/${check.code}`, message: check.message }, { path: `checks/${check.code}/fix`, message: check.fix ?? '' }])
}

/** "Release · 2 checks open" / "Ready to release". */
export function releaseSummary(checks: readonly ReleaseCheck[]): string {
  const count = openChecks(checks).length
  return count === 0 ? 'Ready to release' : `Release · ${count} check${count === 1 ? '' : 's'} open`
}

// ---- the reversal ----------------------------------------------------------------------------------------------------------

export const REVERSAL_REASONS = ['WRONG_RESULT', 'DEFECT_FOUND_LATER', 'CERTIFICATE_PROBLEM', 'CUSTOMER_COMPLAINT', 'RECALL'] as const
export type ReversalReason = (typeof REVERSAL_REASONS)[number]
export const REVERSAL_REASON_WORDS: Readonly<Record<ReversalReason, string>> = Object.freeze({
  WRONG_RESULT: 'Wrong result recorded',
  DEFECT_FOUND_LATER: 'Defect found later',
  CERTIFICATE_PROBLEM: 'Certificate problem',
  CUSTOMER_COMPLAINT: 'Customer complaint',
  RECALL: 'Recall',
})
export const SERIALS_TO = ['MADE', 'VOID'] as const
export type SerialsTo = (typeof SERIALS_TO)[number]

export interface ReversalFacts {
  /** The release's garments, and those of it taken back already. */
  readonly released: number
  readonly reversed: number
  /** The cell's released garments less reversals, and those on shipments that are not cancelled by state. */
  readonly cell: { readonly netReleased: number; readonly onDraft: number; readonly packed: number; readonly shipped: number }
}

export interface ReversalImpact {
  /** Garments of the release that can be taken back now (no shipment holds them). */
  readonly reversible: number
  readonly onDraft: number
  readonly packed: number
  readonly shipped: number
  readonly words: string
}

/** What a reversal of the release would do (design ins-reverse: in stock → on hold, packed → unpack first, shipped → the register). */
export function reversalImpact(facts: ReversalFacts): ReversalImpact {
  const onShipments = facts.cell.onDraft + facts.cell.packed + facts.cell.shipped
  const reversible = Math.max(0, Math.min(facts.released - facts.reversed, facts.cell.netReleased - onShipments))
  const parts = [`${reversible} in the house → put on hold`]
  if (facts.cell.onDraft + facts.cell.packed > 0) parts.push(`${facts.cell.onDraft + facts.cell.packed} on a shipment not yet gone → remove the line (or cancel the shipment) first`)
  if (facts.cell.shipped > 0) parts.push(`${facts.cell.shipped} shipped → cannot be pulled back here: the PPE register entry follows them`)
  return { reversible, onDraft: facts.cell.onDraft, packed: facts.cell.packed, shipped: facts.cell.shipped, words: `${parts.join(' · ')}.` }
}

/** The reversal asked, every problem at once (the serials' own problems come from the API's read). */
export function reversalProblems(input: { readonly quantity: number; readonly impact: ReversalImpact; readonly tracking: 'BATCH' | 'SERIAL'; readonly serialIds: readonly string[]; readonly serialsTo: SerialsTo | null | undefined }): Issue[] {
  const problems: Issue[] = []
  if (!Number.isInteger(input.quantity) || input.quantity < 1) problems.push({ path: 'quantity', message: 'A reversal takes back at least one garment.' })
  else if (input.quantity > input.impact.reversible) {
    problems.push({ path: 'quantity', message: `${input.impact.reversible} garment(s) of this release can be taken back now: ${input.impact.words}` })
  }
  if (input.tracking === 'SERIAL') {
    if (new Set(input.serialIds).size !== input.serialIds.length) problems.push({ path: 'serialIds', message: 'Each serial once.' })
    if (input.serialIds.length !== input.quantity) problems.push({ path: 'serialIds', message: `Name exactly ${input.quantity} serial(s): one per garment taken back.` })
    if (!input.serialsTo) problems.push({ path: 'serialsTo', message: 'Say where the serials go: MADE (rework, then a new inspection) or VOID (scrapped).' })
  } else {
    if (input.serialIds.length > 0) problems.push({ path: 'serialIds', message: 'The style traces its garments by batch: name no serial.' })
    if (input.serialsTo) problems.push({ path: 'serialsTo', message: 'The style traces its garments by batch: no serial moves.' })
  }
  return problems
}

// ---- goods on hold (Owner answer Q3 (a)) -------------------------------------------------------------------------------------

/**
 * Is this inspection's work order on hold through it? Its newest decided inspection FAILED, or garments it released were
 * taken back since (and no inspection passed after): the garments wait for rework and a new inspection.
 */
export function inspectionHold(input: { readonly status: string; readonly reversed: number; readonly newestDecided: boolean }): { readonly onHold: boolean; readonly words: string | null } {
  if (!input.newestDecided) return { onHold: false, words: null }
  if (input.status === 'FAILED') return { onHold: true, words: 'FAILED: its garments are on hold until they are reworked and pass a new inspection.' }
  if (input.status === 'PASSED' && input.reversed > 0) return { onHold: true, words: `${input.reversed} released garment(s) were taken back: on hold until a new inspection passes.` }
  return { onHold: false, words: null }
}

/** A reversal's garments are on hold until an inspection of the work order passes after it. */
export const reversalHolds = (reversedAt: Date, passedAfter: readonly Date[]): boolean => !passedAfter.some((decidedAt) => decidedAt.getTime() > reversedAt.getTime())
