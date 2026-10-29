import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { LEGAL_CR_VI_LIMIT } from '../../inventory/receipts/rules'
import { Dec, parseDecimal, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * The quality step for incoming lots (B-W1-34; QHS-029, QHS-030, SCM-117, QHS-073; A1 §2.5 "Lot"; PLAN §4.7 stage
 * 09b-cr6; Owner question Q14 and design answer W3), pure. apps/factory-api's modules/quality/lab reads the facts and
 * writes through command(); the …_supply_guards trigger holds the lot's states for every login.
 *
 *   result     a chromium VI result of a lot (REACH Annex XVII entry 47: leather in contact with the skin below 3 mg/kg,
 *              tested by EN ISO 17075-1 or -2): the measured value in mg/kg, or "below the detection limit" with that
 *              limit; the verdict is COMPUTED against the lot's limit (the item's, the legal 3 or a brand's lower one),
 *              never typed: below the limit PASS, at or above it FAIL. Below a detection limit that is above the lot's
 *              limit proves nothing and is refused. A result rests on evidence: a lab report on this lot, or the
 *              supplier's report covering the article and a period that holds the lot's receipt day.
 *   rule       what counts as evidence is a setting (Q14): (a) a supplier report covering the article and the period
 *              counts (the default), or (b) a lab report for every lot. Loosening (b → a) asks for a fresh code.
 *   lot        PENDING → PASS | FAIL; a later FAIL on a PASS (new evidence) makes it FAIL and a RELEASED lot BLOCKED,
 *              with the trace of the work orders it went to; a FAIL is final (no override: the law).
 *   release    a lot in QUARANTINE, every check passed: Cr VI PASS (on evidence the rule accepts) when the lot needs the
 *              test, the certificate and the supplier's document of a certified PPE component, no hold of the receiver
 *              still open, a POSTED receipt (never a lot of a reversed one); by a person with the quality role who did
 *              not receive the lot, who types the lot's code. Always a person (W3 (A)): never automatic.
 *   reject     final (back to the supplier or scrapped), from QUARANTINE or BLOCKED, with the reason and the typed code.
 *   block      a RELEASED lot held after a later finding, with the reason; unblock = release it again (same checks).
 */

// ---- tests, methods, units -------------------------------------------------------------------------------------------------

/** The tests W1 records (QHS-029): chromium VI. Tear strength, rub fastness, abrasion and others come with W2b. */
export const LAB_TESTS = ['CR_VI'] as const
export type LabTest = (typeof LAB_TESTS)[number]

/** The methods of EN ISO 17075 (the standard REACH Annex XVII entry 47 names): colorimetric (-1) or chromatographic (-2). */
export const CR_VI_METHODS = ['EN ISO 17075-1', 'EN ISO 17075-2'] as const
export type CrViMethod = (typeof CR_VI_METHODS)[number]

/** Chromium VI is reported in mg/kg of the dry leather. */
export const CR_VI_UNIT = 'mg/kg'

/** Decimal(8,3) in the database: three decimals, below 100 000. */
export const CR_VI_SCALE = 3
const CR_VI_MAX = new Dec('99999.999')

export const LAB_LAW = 'REACH Annex XVII entry 47'

/** What a Cr VI result rests on (the Lot's crViEvidence; setting Q14). */
export const CR_VI_EVIDENCE = ['LOT_REPORT', 'SUPPLIER_REPORT'] as const
export type CrViEvidence = (typeof CR_VI_EVIDENCE)[number]

export const EVIDENCE_WORDS: Readonly<Record<CrViEvidence, string>> = Object.freeze({
  LOT_REPORT: 'a lab report on this lot',
  SUPPLIER_REPORT: "the supplier's report covering the article and the period",
})

// ---- the evidence rule (Q14) ----------------------------------------------------------------------------------------------

/** Q14: (a) a supplier report that covers the article and the period counts; (b) a lab report for every lot. */
export const EVIDENCE_RULES = ['SUPPLIER_REPORT_ACCEPTED', 'LOT_REPORT_REQUIRED'] as const
export type EvidenceRule = (typeof EVIDENCE_RULES)[number]

/** The Owner's default (Q14 (a), plan R-14): received lots and opening stock leave the hold on a supplier report. */
export const DEFAULT_EVIDENCE_RULE: EvidenceRule = 'SUPPLIER_REPORT_ACCEPTED'

export const EVIDENCE_RULE_WORDS: Readonly<Record<EvidenceRule, string>> = Object.freeze({
  SUPPLIER_REPORT_ACCEPTED: 'A supplier report that covers the article and the period counts as chromium VI evidence, as does a lab report on the lot.',
  LOT_REPORT_REQUIRED: 'Only a lab report on the lot itself counts as chromium VI evidence.',
})

/** The evidence a rule accepts. */
export function evidenceAccepted(rule: EvidenceRule, evidence: CrViEvidence): boolean {
  return evidence === 'LOT_REPORT' || rule === 'SUPPLIER_REPORT_ACCEPTED'
}

/** A change that accepts more evidence than before (asks for a fresh code and a reason). */
export function isLoosening(from: EvidenceRule, to: EvidenceRule): boolean {
  return from === 'LOT_REPORT_REQUIRED' && to === 'SUPPLIER_REPORT_ACCEPTED'
}

/** Where the rule in force comes from: the company's own row, the tenant-wide one, or the default. */
export const SETTING_SOURCES = ['COMPANY', 'TENANT', 'DEFAULT'] as const
export type SettingSource = (typeof SETTING_SOURCES)[number]

export interface StoredRule {
  readonly companyId: string | null
  readonly rule: EvidenceRule
}

/** The rule in force for a company: its own, else the tenant's, else the default (as the sales and costing settings). */
export function ruleInForce(companyId: string | null, rows: readonly StoredRule[]): { readonly rule: EvidenceRule; readonly source: SettingSource } {
  const own = companyId === null ? undefined : rows.find((row) => row.companyId === companyId)
  if (own) return { rule: own.rule, source: 'COMPANY' }
  const tenant = rows.find((row) => row.companyId === null)
  if (tenant) return { rule: tenant.rule, source: 'TENANT' }
  return { rule: DEFAULT_EVIDENCE_RULE, source: 'DEFAULT' }
}

// ---- a result and its verdict ---------------------------------------------------------------------------------------------

export const LAB_LIMITS = Object.freeze({ text: 200, note: 500 })

export interface CrViResultInput {
  readonly method: string
  /** The measured content, mg/kg, at most three decimals. Exactly one of this and belowDetectionLimit. */
  readonly valueMgKg?: string | null | undefined
  /** "Not detected": below the lab's detection limit (given). */
  readonly belowDetectionLimit?: boolean | undefined
  readonly detectionLimitMgKg?: string | null | undefined
  /** The laboratory, as on its report. */
  readonly lab: string
  readonly reportNumber?: string | null | undefined
  readonly testedOn: string
  readonly evidence: CrViEvidence
  /** A supplier report: the article it covers and its period (both days included). */
  readonly article?: string | null | undefined
  readonly periodFrom?: string | null | undefined
  readonly periodTo?: string | null | undefined
  readonly note?: string | null | undefined
}

export type Verdict = 'PASS' | 'FAIL'

export interface CrViVerdict {
  readonly verdict: Verdict
  readonly belowDetectionLimit: boolean
  /** The measured value, three decimals; null below the detection limit. */
  readonly valueMgKg: string | null
  readonly detectionLimitMgKg: string | null
  readonly limitMgKg: string
  /** "PASS: 1.2 mg/kg is below the limit of 3 mg/kg." */
  readonly words: string
}

const fixed = (value: Decimal): string => value.toFixed(CR_VI_SCALE)
const shown = (value: DecimalInput): string => new Dec(value).toString()

function mgKgProblem(value: unknown, path: string, positive: boolean): { value: Decimal | null; problem: Issue | null } {
  const parsed = typeof value === 'string' ? parseDecimal(value.trim()) : null
  if (parsed === null || parsed.isNegative() || (positive && parsed.isZero()) || parsed.greaterThan(CR_VI_MAX) || parsed.decimalPlaces() > CR_VI_SCALE) {
    return { value: null, problem: { path, message: `Expected mg/kg ${positive ? 'above' : 'from'} 0, with at most ${CR_VI_SCALE} decimals.` } }
  }
  return { value: parsed, problem: null }
}

/**
 * The verdict against the lot's limit (REACH Annex XVII entry 47: "equal to or greater than 3 mg/kg" is prohibited):
 * a value below the limit is a PASS, at or above it a FAIL. "Below the detection limit" is a PASS only when that
 * detection limit is at or below the lot's limit; above it, the result shows nothing about the limit and is refused.
 */
export function crViVerdict(
  input: Pick<CrViResultInput, 'valueMgKg' | 'belowDetectionLimit' | 'detectionLimitMgKg'>,
  limitMgKg: DecimalInput,
): { readonly verdict: CrViVerdict; readonly problems: readonly [] } | { readonly verdict: null; readonly problems: readonly Issue[] } {
  const limit = new Dec(limitMgKg)
  const measured = input.valueMgKg !== undefined && input.valueMgKg !== null && input.valueMgKg !== ''
  if (input.belowDetectionLimit === true) {
    if (measured) return { verdict: null, problems: [{ path: 'valueMgKg', message: 'Give the measured value or "below the detection limit", not both.' }] }
    const lod = mgKgProblem(input.detectionLimitMgKg, 'detectionLimitMgKg', true)
    if (lod.problem) return { verdict: null, problems: [lod.problem] }
    if (lod.value!.greaterThan(limit)) {
      return {
        verdict: null,
        problems: [
          {
            path: 'detectionLimitMgKg',
            message: `Below a detection limit of ${shown(lod.value!)} mg/kg does not show the lot is below its limit of ${shown(limit)} mg/kg: the lab needs a method whose detection limit is at most the limit (EN ISO 17075-2).`,
          },
        ],
      }
    }
    return {
      verdict: {
        verdict: 'PASS',
        belowDetectionLimit: true,
        valueMgKg: null,
        detectionLimitMgKg: fixed(lod.value!),
        limitMgKg: fixed(limit),
        words: `PASS: not detected, below the detection limit of ${shown(lod.value!)} mg/kg, so below the limit of ${shown(limit)} mg/kg.`,
      },
      problems: [],
    }
  }
  if (input.detectionLimitMgKg !== undefined && input.detectionLimitMgKg !== null && input.detectionLimitMgKg !== '') {
    return { verdict: null, problems: [{ path: 'detectionLimitMgKg', message: 'A detection limit goes with "below the detection limit" only.' }] }
  }
  if (!measured) return { verdict: null, problems: [{ path: 'valueMgKg', message: 'Give the measured value in mg/kg, or "below the detection limit" with that limit.' }] }
  const value = mgKgProblem(input.valueMgKg, 'valueMgKg', false)
  if (value.problem) return { verdict: null, problems: [value.problem] }
  const pass = value.value!.lessThan(limit)
  return {
    verdict: {
      verdict: pass ? 'PASS' : 'FAIL',
      belowDetectionLimit: false,
      valueMgKg: fixed(value.value!),
      detectionLimitMgKg: null,
      limitMgKg: fixed(limit),
      words: pass
        ? `PASS: ${shown(value.value!)} mg/kg is below the limit of ${shown(limit)} mg/kg.`
        : `FAIL: ${shown(value.value!)} mg/kg is at or above the limit of ${shown(limit)} mg/kg: this lot cannot be used (${LAB_LAW}).`,
    },
    problems: [],
  }
}

const text = (value: string | null | undefined): string => (value ?? '').trim()

/**
 * Everything wrong with a result before it reaches the lot, every problem at once (paths relative to the body): the
 * method, the value, the lab, the test day (not after today), the evidence and what the rule in force accepts, and a
 * supplier report's article and period (which must hold the lot's receipt day).
 */
export function resultProblems(
  input: CrViResultInput,
  facts: { readonly limitMgKg: DecimalInput; readonly rule: EvidenceRule; readonly lotCode: string; readonly receivedDay: BusinessDate | null; readonly today: BusinessDate },
): { readonly verdict: CrViVerdict | null; readonly problems: readonly Issue[] } {
  const problems: Issue[] = []
  if (!(CR_VI_METHODS as readonly string[]).includes(input.method)) problems.push({ path: 'method', message: `A chromium VI result is tested by ${CR_VI_METHODS.join(' or ')}.` })
  const verdict = crViVerdict(input, facts.limitMgKg)
  problems.push(...verdict.problems)
  if (text(input.lab) === '' || text(input.lab).length > LAB_LIMITS.text) problems.push({ path: 'lab', message: `Name the laboratory, as on its report (at most ${LAB_LIMITS.text} characters).` })
  if (text(input.reportNumber).length > LAB_LIMITS.text) problems.push({ path: 'reportNumber', message: `At most ${LAB_LIMITS.text} characters.` })
  if (text(input.note).length > LAB_LIMITS.note) problems.push({ path: 'note', message: `At most ${LAB_LIMITS.note} characters.` })
  if (!isBusinessDate(input.testedOn)) problems.push({ path: 'testedOn', message: 'Expected the day of the test, YYYY-MM-DD.' })
  else if (input.testedOn > facts.today) problems.push({ path: 'testedOn', message: `The test day ${input.testedOn} is after today (${facts.today}).` })

  if (!(CR_VI_EVIDENCE as readonly string[]).includes(input.evidence)) {
    problems.push({ path: 'evidence', message: `Expected ${CR_VI_EVIDENCE.join(' or ')}.` })
  } else if (!evidenceAccepted(facts.rule, input.evidence)) {
    problems.push({ path: 'evidence', message: `The evidence rule in force asks for a lab report on every lot (Q14): ${EVIDENCE_WORDS.SUPPLIER_REPORT} does not count for lot ${facts.lotCode}.` })
  }
  const covers = [input.article, input.periodFrom, input.periodTo].some((value) => text(value) !== '')
  if (input.evidence === 'SUPPLIER_REPORT') {
    if (text(input.article) === '' || text(input.article).length > LAB_LIMITS.text) problems.push({ path: 'article', message: "Name the article the supplier's report covers, as on the report." })
    const from = input.periodFrom ?? ''
    const to = input.periodTo ?? ''
    if (!isBusinessDate(from)) problems.push({ path: 'periodFrom', message: "Expected the first day the supplier's report covers, YYYY-MM-DD." })
    if (!isBusinessDate(to)) problems.push({ path: 'periodTo', message: "Expected the last day the supplier's report covers, YYYY-MM-DD." })
    if (isBusinessDate(from) && isBusinessDate(to)) {
      if (from > to) problems.push({ path: 'periodTo', message: 'The period ends before it starts.' })
      else if (facts.receivedDay !== null && (facts.receivedDay < from || facts.receivedDay > to)) {
        problems.push({ path: 'periodTo', message: `The supplier's report covers ${from} to ${to}; lot ${facts.lotCode} was received on ${facts.receivedDay}, outside that period.` })
      }
    }
  } else if (covers) {
    problems.push({ path: 'article', message: 'Only a supplier report names the article and the period it covers.' })
  }
  return { verdict: problems.length === 0 ? verdict.verdict : null, problems }
}

// ---- what a result does to the lot ----------------------------------------------------------------------------------------

export type LotQualityStatus = 'QUARANTINE' | 'RELEASED' | 'REJECTED' | 'BLOCKED'
export type CrViStatus = 'NOT_REQUIRED' | 'PENDING' | 'PASS' | 'FAIL'

export interface LotFacts {
  readonly code: string
  readonly qualityStatus: LotQualityStatus
  readonly requiresCrViTest: boolean
  readonly crViStatus: CrViStatus
  readonly crViEvidence: CrViEvidence | null
  readonly crViMgKg: string | null
  readonly crViLimitMgKg: string | null
  readonly isPpeComponent: boolean
  /** The receiver's hold while the lot is in QUARANTINE (Lot.qualityNote), else null. */
  readonly holdNote: string | null
  /** Who received it (Lot.createdById). */
  readonly receivedById: string | null
  readonly receivedDay: BusinessDate | null
}

export interface ResultEffect {
  readonly crViStatus: 'PASS' | 'FAIL'
  /** The lot's quality status after the result. */
  readonly qualityStatus: LotQualityStatus
  /** A later FAIL on a PASS: the earlier result is superseded and the lot's use is traced. */
  readonly laterFail: boolean
  readonly words: string
}

/** Whether a lot takes this result, and what it does; a string is the refusal in words. */
export function resultEffect(lot: Pick<LotFacts, 'code' | 'qualityStatus' | 'requiresCrViTest' | 'crViStatus'>, verdict: Verdict): ResultEffect | string {
  if (lot.qualityStatus === 'REJECTED') return `Lot ${lot.code} is rejected: it takes no new result.`
  if (!lot.requiresCrViTest || lot.crViStatus === 'NOT_REQUIRED') return `Lot ${lot.code} needs no chromium VI test: its material does not ask for one.`
  if (lot.crViStatus === 'FAIL') return `Lot ${lot.code} failed its chromium VI test already: a FAIL is final (${LAB_LAW}); reject the lot.`
  if (lot.crViStatus === 'PASS') {
    if (verdict === 'PASS') return `Lot ${lot.code} has a chromium VI PASS already; only a later FAIL on new evidence changes it.`
    const blocks = lot.qualityStatus === 'RELEASED'
    return {
      crViStatus: 'FAIL',
      qualityStatus: blocks ? 'BLOCKED' : lot.qualityStatus,
      laterFail: true,
      words: blocks
        ? `Lot ${lot.code} failed on later evidence: it is blocked, and the work orders it went to are listed.`
        : `Lot ${lot.code} failed on later evidence: it is never released.`,
    }
  }
  return {
    crViStatus: verdict,
    qualityStatus: lot.qualityStatus,
    laterFail: false,
    words: verdict === 'PASS' ? `Lot ${lot.code} has its chromium VI PASS.` : `Lot ${lot.code} failed its chromium VI test: reject it (back to the supplier or scrap).`,
  }
}

// ---- supplier documents (QHS-030) -----------------------------------------------------------------------------------------

/** What a supplier document of a lot is. */
export const LOT_DOCUMENT_KINDS = ['PPE_CERTIFICATE', 'CR_VI_STATEMENT', 'LWG_CERTIFICATE', 'FABRIC_TEST', 'OTHER'] as const
export type LotDocumentKind = (typeof LOT_DOCUMENT_KINDS)[number]

export const LOT_DOCUMENT_WORDS: Readonly<Record<LotDocumentKind, string>> = Object.freeze({
  PPE_CERTIFICATE: "the PPE component's certificate or declaration from the supplier",
  CR_VI_STATEMENT: "the supplier's chromium VI statement",
  LWG_CERTIFICATE: "the tannery's LWG certificate",
  FABRIC_TEST: 'a fabric test report',
  OTHER: 'another supplier document',
})

/**
 * The documents a lot must have before release (W1): a certified PPE component needs the supplier's certificate or
 * declaration for the lot. Leather, linings and fabrics need none in W1 (material profiles with their required
 * documents are W2b); they may still carry an LWG certificate or a test report.
 */
export function requiredDocuments(lot: Pick<LotFacts, 'isPpeComponent'>): LotDocumentKind[] {
  return lot.isPpeComponent ? ['PPE_CERTIFICATE'] : []
}

export interface DocumentInput {
  readonly kind: string
  readonly validTo?: string | null | undefined
  readonly note?: string | null | undefined
}

export function documentProblems(input: DocumentInput, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  if (!(LOT_DOCUMENT_KINDS as readonly string[]).includes(input.kind)) problems.push({ path: 'kind', message: `Expected ${LOT_DOCUMENT_KINDS.join(', ')}.` })
  if (input.validTo !== undefined && input.validTo !== null) {
    if (!isBusinessDate(input.validTo)) problems.push({ path: 'validTo', message: 'Expected the last day it is valid, YYYY-MM-DD.' })
    else if (input.validTo < today) problems.push({ path: 'validTo', message: `It expired on ${input.validTo}: attach a valid one.` })
  }
  if (text(input.note).length > LAB_LIMITS.note) problems.push({ path: 'note', message: `At most ${LAB_LIMITS.note} characters.` })
  if (input.kind === 'OTHER' && text(input.note) === '') problems.push({ path: 'note', message: 'Say what the document is.' })
  return problems
}

// ---- the release checklist ------------------------------------------------------------------------------------------------

export const CHECK_CODES = ['STATE', 'RECEIPT', 'CR_VI', 'PPE_CERTIFICATE', 'SUPPLIER_DOCUMENTS', 'HOLD', 'RELEASER'] as const
export type CheckCode = (typeof CHECK_CODES)[number]
export type CheckState = 'OK' | 'OPEN' | 'NOT_NEEDED'

export interface Check {
  readonly code: CheckCode
  readonly state: CheckState
  /** What is true now, in words. */
  readonly words: string
  /** How to clear it (OPEN only): what to do, and where. */
  readonly fix: string | null
}

export interface ReleaseFacts {
  readonly lot: LotFacts
  /** The receipt it came with (null: opening stock). */
  readonly receipt: { readonly number: string; readonly status: 'OPEN' | 'POSTED' | 'REVERSED' | 'CANCELLED' } | null
  readonly rule: EvidenceRule
  /** A VALID certificate in the register that covers the lot's item today (certified PPE components). */
  readonly ppeCertificate: { readonly number: string; readonly standard: string; readonly validTo: BusinessDate } | null
  /** The lot's supplier documents in force (attached, file available). */
  readonly documents: readonly { readonly kind: LotDocumentKind; readonly validTo: BusinessDate | null }[]
  readonly today: BusinessDate
  /** The person who would release it (the viewer; null: no one in particular). */
  readonly releaserId: string | null
}

export type ChecklistMode = 'RELEASE' | 'UNBLOCK'

export interface Checklist {
  readonly mode: ChecklistMode
  readonly checks: Check[]
  readonly open: Check[]
  readonly ready: boolean
  /** "Ready to release" or "Release · 2 checks open". */
  readonly words: string
}

const ok = (code: CheckCode, words: string): Check => ({ code, state: 'OK', words, fix: null })
const notNeeded = (code: CheckCode, words: string): Check => ({ code, state: 'NOT_NEEDED', words, fix: null })
const open = (code: CheckCode, words: string, fix: string | null): Check => ({ code, state: 'OPEN', words, fix })

function stateCheck(lot: LotFacts, mode: ChecklistMode): Check {
  const wanted = mode === 'RELEASE' ? 'QUARANTINE' : 'BLOCKED'
  if (lot.qualityStatus === wanted) return ok('STATE', mode === 'RELEASE' ? `Lot ${lot.code} is in quarantine.` : `Lot ${lot.code} is blocked.`)
  switch (lot.qualityStatus) {
    case 'RELEASED':
      return open('STATE', `Lot ${lot.code} is released already: usable stock.`, null)
    case 'REJECTED':
      return open('STATE', `Lot ${lot.code} is rejected: that is final, it is never used.`, null)
    case 'BLOCKED':
      return open('STATE', `Lot ${lot.code} is blocked after its release.`, 'Release it again with Unblock, once the finding is cleared.')
    default:
      return open('STATE', `Lot ${lot.code} is in quarantine, not blocked.`, 'Release it from quarantine instead.')
  }
}

function receiptCheck(receipt: ReleaseFacts['receipt']): Check {
  if (receipt === null) return notNeeded('RECEIPT', 'Opening stock: no receipt.')
  switch (receipt.status) {
    case 'POSTED':
      return ok('RECEIPT', `Received with ${receipt.number}.`)
    case 'REVERSED':
      return open('RECEIPT', `Receipt ${receipt.number} was reversed: its lots are never released.`, null)
    default:
      return open('RECEIPT', `Receipt ${receipt.number} is ${receipt.status}: nothing of it is in stock.`, null)
  }
}

function crViCheck(lot: LotFacts, rule: EvidenceRule): Check {
  if (!lot.requiresCrViTest) return notNeeded('CR_VI', 'Needs no chromium VI test.')
  const limit = shown(lot.crViLimitMgKg ?? LEGAL_CR_VI_LIMIT)
  switch (lot.crViStatus) {
    case 'PASS': {
      const evidence = lot.crViEvidence ?? 'LOT_REPORT'
      const measured = lot.crViMgKg === null ? 'not detected' : `${shown(lot.crViMgKg)} mg/kg`
      if (!evidenceAccepted(rule, evidence)) {
        return open('CR_VI', `Its chromium VI PASS rests on ${EVIDENCE_WORDS.SUPPLIER_REPORT}, and the evidence rule in force asks for a lab report on every lot (Q14).`, 'Record the result of a lab report on this lot.')
      }
      return ok('CR_VI', `Chromium VI PASS: ${measured}, below the limit of ${limit} mg/kg (${EVIDENCE_WORDS[evidence]}).`)
    }
    case 'FAIL':
      return open('CR_VI', `Failed its chromium VI test (at or above ${limit} mg/kg): it is never released (${LAB_LAW}).`, 'Reject the lot: back to the supplier or scrap.')
    default:
      return open(
        'CR_VI',
        `Waits for its chromium VI result (limit ${limit} mg/kg, ${LAB_LAW}).`,
        rule === 'LOT_REPORT_REQUIRED' ? 'Record the result of a lab report on this lot.' : "Record the result of a lab report on this lot, or of the supplier's report covering the article and the period.",
      )
  }
}

function certificateCheck(lot: LotFacts, certificate: ReleaseFacts['ppeCertificate']): Check {
  if (!lot.isPpeComponent) return notNeeded('PPE_CERTIFICATE', 'Not a certified PPE component.')
  if (certificate) return ok('PPE_CERTIFICATE', `Certificate ${certificate.number} (${certificate.standard}) covers the component, valid to ${certificate.validTo}.`)
  return open('PPE_CERTIFICATE', 'No valid certificate in the register covers this PPE component today (Reg. (EU) 2016/425).', 'Register its certificate with what it covers in Compliance › Certificates.')
}

function documentsCheck(lot: LotFacts, documents: ReleaseFacts['documents'], today: BusinessDate): Check {
  const needed = requiredDocuments(lot)
  if (needed.length === 0) return notNeeded('SUPPLIER_DOCUMENTS', 'This material needs no supplier documents.')
  const missing: string[] = []
  const expired: string[] = []
  for (const kind of needed) {
    const ofKind = documents.filter((document) => document.kind === kind)
    if (ofKind.some((document) => document.validTo === null || document.validTo >= today)) continue
    if (ofKind.length > 0) expired.push(`${LOT_DOCUMENT_WORDS[kind]} expired`)
    else missing.push(LOT_DOCUMENT_WORDS[kind])
  }
  if (missing.length === 0 && expired.length === 0) return ok('SUPPLIER_DOCUMENTS', `The supplier documents are here: ${needed.map((kind) => LOT_DOCUMENT_WORDS[kind]).join(', ')}.`)
  return open('SUPPLIER_DOCUMENTS', `Missing supplier documents (QHS-030): ${[...missing, ...expired].join('; ')}.`, 'Attach them to the lot.')
}

function holdCheck(lot: LotFacts, mode: ChecklistMode): Check {
  if (mode === 'UNBLOCK' || lot.qualityStatus !== 'QUARANTINE' || lot.holdNote === null) return notNeeded('HOLD', 'No hold from the receipt.')
  return open('HOLD', `Held at receipt: ${lot.holdNote}`, 'Check what the receiver held it for, then clear the hold with what you found.')
}

function releaserCheck(lot: LotFacts, releaserId: string | null): Check {
  if (releaserId !== null && lot.receivedById !== null && releaserId === lot.receivedById) {
    return open('RELEASER', 'You received this lot: another person with the quality role releases it (four eyes).', null)
  }
  return ok('RELEASER', 'Released by a person with the quality role who did not receive it.')
}

/**
 * The release checklist of a lot (design lt-release, ts-release; QHS-030): every check with its state and words, the
 * open ones with how to clear them. RELEASE: from quarantine; UNBLOCK: a blocked lot released again (the same checks
 * but the receiver's hold, which only a quarantine has).
 */
export function releaseChecklist(facts: ReleaseFacts, mode: ChecklistMode = 'RELEASE'): Checklist {
  const checks = [
    stateCheck(facts.lot, mode),
    receiptCheck(facts.receipt),
    crViCheck(facts.lot, facts.rule),
    certificateCheck(facts.lot, facts.ppeCertificate),
    documentsCheck(facts.lot, facts.documents, facts.today),
    holdCheck(facts.lot, mode),
    releaserCheck(facts.lot, facts.releaserId),
  ]
  const opened = checks.filter((check) => check.state === 'OPEN')
  const verb = mode === 'RELEASE' ? 'Release' : 'Unblock'
  return {
    mode,
    checks,
    open: opened,
    ready: opened.length === 0,
    words: opened.length === 0 ? `Ready to ${verb.toLowerCase()}` : `${verb} · ${opened.length} ${opened.length === 1 ? 'check' : 'checks'} open`,
  }
}

/** The refusal of a release (or unblock) with every open check, in words (issue paths `checks/<CODE>`). */
export function checklistRefusal(list: Checklist, code: string): { readonly message: string; readonly issues: Issue[] } {
  const verb = list.mode === 'RELEASE' ? 'released' : 'released again'
  return {
    message: `Lot ${code} cannot be ${verb} yet: ${list.open.map((check) => check.words).join(' ')}`,
    issues: list.open.map((check) => ({ path: `checks/${check.code}`, message: check.fix ? `${check.words} ${check.fix}` : check.words })),
  }
}

/** The typed confirmation: the lot's own code (spaces around it and letter case do not matter). */
export function codeMatches(typed: string, code: string): boolean {
  return typed.trim().toUpperCase() === code.trim().toUpperCase()
}

// ---- reject, block, clear the hold ------------------------------------------------------------------------------------------

/** Why a lot cannot be rejected now (null: it can). From QUARANTINE or BLOCKED; REJECTED is final. */
export function rejectProblem(lot: Pick<LotFacts, 'code' | 'qualityStatus'>): string | null {
  if (lot.qualityStatus === 'REJECTED') return `Lot ${lot.code} is rejected already.`
  if (lot.qualityStatus === 'RELEASED') return `Lot ${lot.code} is released: block it first (with the reason), then reject it.`
  return null
}

/** Why a lot cannot be blocked now (null: it can). Only a RELEASED lot is blocked; quarantine already holds the others. */
export function blockProblem(lot: Pick<LotFacts, 'code' | 'qualityStatus'>): string | null {
  switch (lot.qualityStatus) {
    case 'RELEASED':
      return null
    case 'BLOCKED':
      return `Lot ${lot.code} is blocked already.`
    case 'REJECTED':
      return `Lot ${lot.code} is rejected: that is final.`
    default:
      return `Lot ${lot.code} is in quarantine: it is not usable already; reject it, or release it when its checks pass.`
  }
}

/** Why the receiver's hold cannot be cleared now (null: it can): a lot in quarantine with a hold, by another person. */
export function clearHoldProblem(lot: Pick<LotFacts, 'code' | 'qualityStatus' | 'holdNote' | 'receivedById'>, personId: string | null): string | null {
  if (lot.qualityStatus !== 'QUARANTINE') return `Lot ${lot.code} is not in quarantine: it has no hold from the receipt.`
  if (lot.holdNote === null) return `Lot ${lot.code} has no hold from the receipt.`
  if (personId !== null && personId === lot.receivedById) return 'You received this lot and held it: another person with the quality role checks it and clears the hold (four eyes).'
  return null
}

/** A decision's reason: required, at most 500 characters. */
export function reasonProblem(reason: string | null | undefined, path = 'reason'): Issue | null {
  const value = text(reason)
  if (value === '') return { path, message: 'Give the reason.' }
  if (value.length > LAB_LIMITS.note) return { path, message: `At most ${LAB_LIMITS.note} characters.` }
  return null
}
