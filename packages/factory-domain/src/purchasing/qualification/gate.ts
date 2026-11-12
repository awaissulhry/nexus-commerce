import { createHash } from 'node:crypto'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { cleanNote } from '../../parties/rules'
import type { SupplierKind } from '../suppliers-depth/rules'
import type { ComplianceSendCheckCode } from './codes'
import { askStateOf, bestDocument, dayWords, listWords, type VaultDocument } from './vault'

/**
 * The compliance gate on a purchase order (B-W2b-315; SCM-022; design purchasing.orders › Send "documents valid (W2b
 * gate)", Lines "Held compliance mark: 'Chromium VI test for A12 expired 2 Oct — this PO can't be sent' + Override",
 * pop-up "Send without a valid document?"), pure. Rule 2 of the plan: chromium VI and protector certificates are legal
 * evidence the receipt checks today (W1: the lot's Cr VI test and its PPE certificate at the receipt hold); the gate moves
 * the check to BEFORE the money is spent. W1's receipt checks stay as they are.
 *
 * A line is held at Send when (what the vault asks per supplier kind, ./vault.ts, applied to the line's material)
 *   CR_VI_TEST_REPORT  the supplier is a TANNERY, its leather needs a chromium VI test (the line's flag, from the material)
 *                      and none of the supplier's test reports is in force today (REACH Annex XVII entry 47: below 3 mg/kg
 *                      in leather in contact with the skin) — an upload naming its articles counts only for those articles;
 *   PPE_CERTIFICATE    the supplier is a PROTECTOR_MAKER, the material a PPE component and no VALID certificate of the
 *                      register covers it today (an ACTIVE coverage of the item, no supplier named or this one: Reg. (EU)
 *                      2016/425 — the garment's type examination names its protectors);
 *   RULE               a company rule asks a document of the order before it is SENT (B-W2b-177's required documents:
 *                      level Blocks holds it, Warns warns).
 * A supplier whose kinds are not set is asked nothing by kind (B-W2b-311: no backfill): the answer names the lines the
 * gate could not check (`notChecked`, words for the screen; no send check, so W1's orders go on as before).
 * What lapses before the line's need date warns. A held order goes only with an override: a reason, asked of a second
 * person, who says yes or no (never the one who asked, the Owner included; the database refuses it too). The yes covers
 * exactly what was held when asked (its fingerprint): a new line or another missing document holds the order again.
 */

export const REQUIREMENT_KINDS = ['CR_VI_TEST_REPORT', 'PPE_CERTIFICATE', 'RULE'] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

export const REQUIREMENT_STATES = ['MET', 'EXPIRING', 'EXPIRES_BEFORE_NEED', 'EXPIRED', 'MISSING'] as const
export type RequirementState = (typeof REQUIREMENT_STATES)[number]

export const LAW: Readonly<Record<Exclude<RequirementKind, 'RULE'>, string>> = Object.freeze({ CR_VI_TEST_REPORT: 'REACH Annex XVII entry 47', PPE_CERTIFICATE: 'Reg. (EU) 2016/425' })

export interface GateLine {
  readonly id: string
  readonly seq: number
  readonly itemId: string
  readonly itemCode: string
  /** The codes the supplier may know the article by: the line's supplier article code, the material's, our code. */
  readonly articleCodes: readonly string[]
  readonly needDate: BusinessDate
  readonly requiresCrViTest: boolean
  readonly isPpeComponent: boolean
}

export interface GateCertificate {
  readonly id: string
  readonly number: string
  readonly standard: string
  readonly validTo: BusinessDate
}

export interface GateRule {
  readonly ruleId: string
  readonly level: 'BLOCK' | 'WARN'
  readonly met: boolean
  readonly sentence: string
}

export interface GateFacts {
  readonly orderId: string
  readonly supplierName: string
  /** The supplier's kinds (B-W2b-311): a TANNERY owes its leathers' chromium VI test reports, a PROTECTOR_MAKER its protectors' certificates. */
  readonly supplierKinds: readonly SupplierKind[]
  readonly today: BusinessDate
  readonly lines: readonly GateLine[]
  /** The supplier's current documents of the vault (TEST_REPORT for the chromium VI test). */
  readonly documents: readonly VaultDocument[]
  /** The certificate of the register covering each PPE component today (null: none). */
  readonly certificates: ReadonlyMap<string, GateCertificate | null>
  /** The company's required-document rules for the order before SENT, with whether each is met. */
  readonly rules: readonly GateRule[]
}

export interface Requirement {
  readonly kind: RequirementKind
  readonly state: RequirementState
  readonly severity: 'BLOCKS' | 'WARNING' | null
  readonly lineIds: readonly string[]
  readonly seqs: readonly number[]
  readonly itemIds: readonly string[]
  readonly itemCodes: readonly string[]
  readonly documentFileId: string | null
  readonly certificateId: string | null
  readonly ruleId: string | null
  readonly expiresOn: BusinessDate | null
  readonly law: string | null
  readonly words: string
}

/** The latest request to send the order without its documents, as the API reads it (the order's override history). */
export interface OverrideState {
  readonly state: 'WAITING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN'
  readonly fingerprint: string
  readonly reason: string
  readonly askedById: string
  readonly askedByName: string | null
  readonly askedAt: string
  readonly decidedByName: string | null
  readonly decidedAt: string | null
  readonly words: string | null
}

export interface GateCheck {
  readonly code: ComplianceSendCheckCode
  readonly severity: 'BLOCKS' | 'WARNING'
  readonly path: string
  readonly message: string
}

export interface GateAnswer {
  readonly requirements: Requirement[]
  readonly blocks: Requirement[]
  readonly warnings: Requirement[]
  /** Each line with its held mark (the requirements that hold it). */
  readonly lines: { readonly lineId: string; readonly seq: number; readonly held: boolean; readonly kinds: RequirementKind[]; readonly words: string[] }[]
  /** What an override covers: the order and the requirements that hold it now. */
  readonly fingerprint: string | null
  /** An APPROVED override covers exactly what holds it now. */
  readonly overridden: boolean
  readonly checks: GateCheck[]
  readonly ready: boolean
  /** Lines the gate could not check because the supplier's kinds do not say what to ask (words for the screen). */
  readonly notChecked: string[]
}

const lineWords = (lines: readonly GateLine[]): string => listWords(lines.map((line) => `${line.seq} (${line.itemCode})`))
const plural = (lines: readonly unknown[], one: string, many: string): string => (lines.length === 1 ? one : many)

/** The requirements of the order's open lines and rules (MET ones included, so a screen shows what is in order too). */
export function requirementsOf(facts: GateFacts): Requirement[] {
  const out: Requirement[] = []
  const base = { certificateId: null, ruleId: null } as const

  // Chromium VI: per line its best document (an upload naming articles covers only those), grouped by document and state.
  const crVi = facts.lines.filter((line) => line.requiresCrViTest && facts.supplierKinds.includes('TANNERY'))
  const groups = new Map<string, { doc: VaultDocument | null; state: RequirementState; lines: GateLine[] }>()
  for (const line of crVi) {
    const doc = bestDocument(facts.documents, 'TEST_REPORT', facts.today, line.articleCodes)
    let state: RequirementState = askStateOf(doc, facts.today)
    if ((state === 'MET' || state === 'EXPIRING') && doc?.expiresOn && doc.expiresOn < line.needDate) state = 'EXPIRES_BEFORE_NEED'
    const key = `${doc?.fileId ?? 'none'}|${state}`
    const group = groups.get(key) ?? { doc, state, lines: [] }
    group.lines.push(line)
    groups.set(key, group)
  }
  for (const { doc, state, lines } of groups.values()) {
    const severity = state === 'MISSING' || state === 'EXPIRED' ? 'BLOCKS' : state === 'EXPIRES_BEFORE_NEED' ? 'WARNING' : null
    const who = `${plural(lines, 'line', 'lines')} ${lineWords(lines)}`
    const words =
      state === 'MISSING'
        ? `Chromium VI test report: ${facts.supplierName} has none in force; ${who} ${plural(lines, 'needs', 'need')} one to be sent (${LAW.CR_VI_TEST_REPORT}).`
        : state === 'EXPIRED'
          ? `Chromium VI test report of ${facts.supplierName} expired on ${dayWords(doc!.expiresOn!)}: ${who} cannot be sent until a renewed one is in force (${LAW.CR_VI_TEST_REPORT}).`
          : state === 'EXPIRES_BEFORE_NEED'
            ? `Chromium VI test report of ${facts.supplierName} expires on ${dayWords(doc!.expiresOn!)}, before ${who} ${plural(lines, 'is', 'are')} needed: ask for the renewed report.`
            : `Chromium VI test report of ${facts.supplierName} in force${doc?.expiresOn ? ` until ${dayWords(doc.expiresOn)}` : ''} for ${who}.`
    out.push({ ...base, kind: 'CR_VI_TEST_REPORT', state, severity, lineIds: lines.map((line) => line.id), seqs: lines.map((line) => line.seq), itemIds: [...new Set(lines.map((line) => line.itemId))], itemCodes: [...new Set(lines.map((line) => line.itemCode))], documentFileId: doc?.fileId ?? null, expiresOn: doc?.expiresOn ?? null, law: LAW.CR_VI_TEST_REPORT, words })
  }

  // PPE components: per material, its certificate of the register today.
  const ppeLines = facts.supplierKinds.includes('PROTECTOR_MAKER') ? facts.lines.filter((line) => line.isPpeComponent) : []
  const ppeItems = [...new Set(ppeLines.map((line) => line.itemId))]
  for (const itemId of ppeItems) {
    const lines = ppeLines.filter((line) => line.itemId === itemId)
    const certificate = facts.certificates.get(itemId) ?? null
    const earliest = lines.map((line) => line.needDate).sort()[0]!
    const state: RequirementState = !certificate ? 'MISSING' : certificate.validTo < earliest ? 'EXPIRES_BEFORE_NEED' : askStateOf({ expiresOn: certificate.validTo }, facts.today)
    const severity = state === 'MISSING' ? 'BLOCKS' : state === 'EXPIRES_BEFORE_NEED' ? 'WARNING' : null
    const code = lines[0]!.itemCode
    const who = `${plural(lines, 'line', 'lines')} ${listWords(lines.map((line) => String(line.seq)))}`
    const words =
      state === 'MISSING'
        ? `No valid certificate in the register covers ${code} (${who}): a garment with it could not be released as PPE (${LAW.PPE_CERTIFICATE}).`
        : state === 'EXPIRES_BEFORE_NEED'
          ? `Certificate ${certificate!.number} (${certificate!.standard}) of ${code} ends on ${dayWords(certificate!.validTo)}, before ${who} ${plural(lines, 'is', 'are')} needed: ask the notified body's renewal.`
          : `Certificate ${certificate!.number} (${certificate!.standard}) covers ${code} until ${dayWords(certificate!.validTo)}.`
    out.push({ kind: 'PPE_CERTIFICATE', state, severity, lineIds: lines.map((line) => line.id), seqs: lines.map((line) => line.seq), itemIds: [itemId], itemCodes: [code], documentFileId: null, certificateId: certificate?.id ?? null, ruleId: null, expiresOn: certificate?.validTo ?? null, law: LAW.PPE_CERTIFICATE, words })
  }

  // The company's rules before SENT.
  for (const rule of facts.rules) {
    out.push({ kind: 'RULE', state: rule.met ? 'MET' : 'MISSING', severity: rule.met ? null : rule.level === 'BLOCK' ? 'BLOCKS' : 'WARNING', lineIds: [], seqs: [], itemIds: [], itemCodes: [], documentFileId: null, certificateId: null, ruleId: rule.ruleId, expiresOn: null, law: null, words: rule.sentence })
  }
  return out
}

/** The fingerprint an override covers: the order and the requirements that hold it (kind, material, lines, rule). */
export function holdFingerprint(orderId: string, blocks: readonly Requirement[]): string | null {
  if (blocks.length === 0) return null
  const keys = blocks.map((entry) => `${entry.kind}:${entry.ruleId ?? ''}:${[...entry.itemIds].sort().join(',')}:${[...entry.lineIds].sort().join(',')}`).sort()
  return createHash('sha256').update(`factory compliance hold v1|${orderId}|${keys.join('|')}`).digest('hex')
}

const CODE_OF: Readonly<Record<RequirementKind, { readonly blocks: ComplianceSendCheckCode; readonly warns: ComplianceSendCheckCode }>> = Object.freeze({
  CR_VI_TEST_REPORT: { blocks: 'COMPLIANCE_DOCUMENT_MISSING', warns: 'COMPLIANCE_EXPIRES_BEFORE_NEED' },
  PPE_CERTIFICATE: { blocks: 'COMPLIANCE_CERTIFICATE_MISSING', warns: 'COMPLIANCE_EXPIRES_BEFORE_NEED' },
  RULE: { blocks: 'COMPLIANCE_RULE_MISSING', warns: 'COMPLIANCE_RULE_WARNING' },
})

const pathOf = (entry: Requirement): string => (entry.seqs.length > 0 ? `lines/${entry.seqs[0]}/compliance` : `compliance/${entry.ruleId ?? entry.kind}`)

/** The gate's answer for the order now, with the latest override request (null: none). */
export function gateOf(facts: GateFacts, override: OverrideState | null): GateAnswer {
  const requirements = requirementsOf(facts)
  const blocks = requirements.filter((entry) => entry.severity === 'BLOCKS')
  const warnings = requirements.filter((entry) => entry.severity === 'WARNING')
  const fingerprint = holdFingerprint(facts.orderId, blocks)
  const overridden = fingerprint !== null && override !== null && override.state === 'APPROVED' && override.fingerprint === fingerprint
  const checks: GateCheck[] = []
  if (overridden) {
    checks.push({ code: 'COMPLIANCE_OVERRIDDEN', severity: 'WARNING', path: 'compliance/override', message: `Sent without a valid document on ${override.decidedByName ?? 'a second person'}'s yes${override.decidedAt ? ` of ${dayWords(override.decidedAt.slice(0, 10))}` : ''}: ${override.reason}` })
  } else {
    for (const entry of blocks) checks.push({ code: CODE_OF[entry.kind].blocks, severity: 'BLOCKS', path: pathOf(entry), message: entry.words })
    if (fingerprint !== null && override?.state === 'WAITING' && override.fingerprint === fingerprint) {
      checks.push({ code: 'COMPLIANCE_OVERRIDE_WAITING', severity: 'BLOCKS', path: 'compliance/override', message: `A request to send it without the document waits for a second person's yes (asked by ${override.askedByName ?? 'a colleague'} on ${dayWords(override.askedAt.slice(0, 10))}).` })
    }
  }
  for (const entry of warnings) checks.push({ code: CODE_OF[entry.kind].warns, severity: 'WARNING', path: pathOf(entry), message: entry.words })
  const lines = facts.lines.map((line) => {
    const holding = blocks.filter((entry) => entry.lineIds.includes(line.id))
    return { lineId: line.id, seq: line.seq, held: holding.length > 0 && !overridden, kinds: holding.map((entry) => entry.kind), words: holding.map((entry) => entry.words) }
  })
  const notChecked: string[] = []
  const leathers = facts.lines.filter((line) => line.requiresCrViTest && !facts.supplierKinds.includes('TANNERY'))
  if (leathers.length > 0) notChecked.push(`${facts.supplierName} is not set as a tannery: the chromium VI test report of ${plural(leathers, 'line', 'lines')} ${lineWords(leathers)} is not checked at Send (set its supplier kinds).`)
  const protectors = facts.lines.filter((line) => line.isPpeComponent && !facts.supplierKinds.includes('PROTECTOR_MAKER'))
  if (protectors.length > 0) notChecked.push(`${facts.supplierName} is not set as a protector maker: the certificate of ${plural(protectors, 'line', 'lines')} ${lineWords(protectors)} is not checked at Send (set its supplier kinds).`)
  return { requirements, blocks, warnings, lines, fingerprint, overridden, checks, ready: !checks.some((check) => check.severity === 'BLOCKS'), notChecked }
}

export const OVERRIDE_LIMITS = Object.freeze({ reason: 2000, reasonMin: 3, words: 2000 })

export const OVERRIDE_REFUSALS = Object.freeze({
  nothingHeld: 'Nothing holds this order at Send: no override is needed.',
  waiting: 'A request to send it without the document waits for its yes already.',
  notWaiting: 'No request to send it without the document waits for a yes.',
  own: 'You asked to send it without the document: a second person decides, the Owner included.',
  notDraft: 'Only a draft is held at Send: this order is not a draft any more.',
  changed: 'What holds the order changed since the request was asked: ask again for what holds it now.',
  notAsker: 'Only the person who asked takes the request back.',
})

/** The override's reason: 3 to 2000 characters (lines kept). */
export function overrideReasonOf(value: string | null | undefined): { readonly reason: string } | { readonly issue: Issue } {
  const reason = cleanNote(value ?? null)
  if (reason === null || reason.length < OVERRIDE_LIMITS.reasonMin || reason.length > OVERRIDE_LIMITS.reason) return { issue: { path: 'body/reason', message: `Why it goes without the document, in ${OVERRIDE_LIMITS.reasonMin} to ${OVERRIDE_LIMITS.reason} characters.` } }
  return { reason }
}

/** The decision's words: required for a no (1 to 2000), optional for a yes. */
export function decisionWordsOf(decision: 'APPROVED' | 'REJECTED', value: string | null | undefined): { readonly words: string | null } | { readonly issue: Issue } {
  const words = cleanNote(value ?? null)
  if (words !== null && words.length > OVERRIDE_LIMITS.words) return { issue: { path: 'body/words', message: `At most ${OVERRIDE_LIMITS.words} characters.` } }
  if (decision === 'REJECTED' && words === null) return { issue: { path: 'body/words', message: 'Say why not: the person who asked reads it.' } }
  return { words }
}
