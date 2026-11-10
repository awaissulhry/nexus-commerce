import type { LabelQr } from '../labels/render'
import type { LabelQrTarget } from '../labels/rules'
import { formatPublicDocCode, publicDocAddress, publicDocCodeOf } from '../public-doc/code'

/**
 * What a PPE label must say beyond W1's fields (B-W2b-253; PRD-335, PRD-336, PRD-346, PRD-349), pure: the QR's address,
 * the phrase keys of the class warnings, the glove's EN 13594 level, and who the GPSR contact names. The checks
 * (./rules.ts) and the renderer (compliance/labels render.ts, through the API's preview and garmentLabelFor) read them.
 */

// ---- the QR to the public DoC page (PRD-349, B-W2b-166) -------------------------------------------------------------------

/** The record a batch QR names: the work order once released (its batch number and release day). */
export interface QrWorkOrder {
  readonly id: string
  /** As a person names it ("WO-00012"). */
  readonly reference: string | null
}

/**
 * Where the label's QR points: the public DoC page of the garment's batch (BATCH_DOC: the work order's code), or of its
 * style (STYLE_DOC: the style's current declaration and the earlier ones). The code is the end of the record's id
 * (public-doc/code.ts), so the address never needs a lookup; a batch QR has no address until the work order is known
 * (a template's preview). Null when the template carries no QR.
 */
export function labelQrOf(target: LabelQrTarget, style: { readonly id: string; readonly code: string }, workOrder: QrWorkOrder | null, webOrigin: string): LabelQr | null {
  if (target === 'NONE') return null
  if (target === 'STYLE_DOC') {
    const code = publicDocCodeOf(style.id)
    return { kind: 'STYLE', address: publicDocAddress(webOrigin, code), printed: formatPublicDocCode(code), recordType: 'Style', recordId: style.id, reference: style.code }
  }
  if (workOrder === null) return { kind: 'BATCH', address: null, printed: null, recordType: null, recordId: null, reference: null }
  const code = publicDocCodeOf(workOrder.id)
  return { kind: 'BATCH', address: publicDocAddress(webOrigin, code), printed: formatPublicDocCode(code), recordType: 'WorkOrder', recordId: workOrder.id, reference: workOrder.reference }
}

/** A web origin a printed QR must not carry for ten years: plain http, or a loopback or local host name. */
export function localOrigin(webOrigin: string): boolean {
  try {
    const url = new URL(webOrigin)
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return url.protocol !== 'https:' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || /^127\./.test(host) || host === '0.0.0.0'
  } catch {
    return true
  }
}

// ---- the class warnings (PRD-335; EN 17092-5, EN 17092-6) ---------------------------------------------------------------

/** Why a warning is asked: an EN 17092 class B or class C garment, or impact protectors that can be taken out. */
export const WARNING_REASONS = ['CLASS_B', 'CLASS_C', 'REMOVABLE_PROTECTORS'] as const
export type WarningReason = (typeof WARNING_REASONS)[number]

/**
 * The phrase each warning prints, by key in the phrase library (B-W2b-249; kind WARNING). The words are the library's,
 * typed and approved by people, and stay drafts on the label until a PPE consultant says yes to the label's texts
 * (GATE-PPE-TEXTS).
 */
export const WARNING_PHRASE_KEYS: Readonly<Record<WarningReason, string>> = Object.freeze({
  CLASS_B: 'warning.class-b',
  CLASS_C: 'warning.class-c',
  REMOVABLE_PROTECTORS: 'warning.protectors-removable',
})

export const WARNING_WORDS: Readonly<Record<WarningReason, string>> = Object.freeze({
  CLASS_B: 'the class B warning (EN 17092-5: a garment without impact protectors)',
  CLASS_C: 'the class C warning (EN 17092-6: a garment made to hold impact protectors, not to resist abrasion)',
  REMOVABLE_PROTECTORS: 'the warning that the impact protectors can be taken out and the class holds only with them in place',
})

/** The class of an EN 17092 style or of the certificate covering it; the pockets of its revision's protector placements. */
export interface WarningFacts {
  readonly standardCode: string | null
  readonly ppeClass: string | null
  /** The pockets that hold a protector in the revision (ProtectorPlacement): a protector in a pocket can be taken out. */
  readonly protectorPockets: readonly string[]
}

/** The warnings an EN 17092 garment label must carry, in order. Class B garments have no impact protectors to take out. */
export function warningsAsked(facts: WarningFacts): WarningReason[] {
  if (facts.standardCode !== 'EN 17092') return []
  const asked: WarningReason[] = []
  if (facts.ppeClass === 'B') asked.push('CLASS_B')
  if (facts.ppeClass === 'C') asked.push('CLASS_C')
  if (facts.protectorPockets.length > 0 && facts.ppeClass !== 'B') asked.push('REMOVABLE_PROTECTORS')
  return asked
}

// ---- glove marking (PRD-336; EN 13594) -------------------------------------------------------------------------------------

/** A glove's EN 13594 level as marked: "1" or "2", with KP for knuckle protection. */
export interface GloveLevel {
  readonly level: string
  readonly knuckle: boolean
}

/** "2KP" → level 2 with knuckle protection; null for anything that is not an EN 13594 level. */
export function gloveLevelOf(ppeClass: string | null): GloveLevel | null {
  const match = ppeClass === null ? null : /^([12])(KP)?$/.exec(ppeClass.trim().toUpperCase())
  return match ? { level: match[1]!, knuckle: match[2] === 'KP' } : null
}

/** A certificate's EN 13594 levels (B-W2b-216 performanceLevels `{ "level": "2", "knuckle": "KP" }`); null when not given. */
export function certificateGloveLevel(levels: Readonly<Record<string, string>> | null): GloveLevel | null {
  const level = levels?.level?.trim()
  if (!level || !/^[12]$/.test(level)) return null
  return { level, knuckle: (levels?.knuckle ?? '').trim().toUpperCase() === 'KP' }
}

export const gloveLevelText = (level: GloveLevel): string => `${level.level}${level.knuckle ? ' KP' : ''}`

// ---- the GPSR contact (PRD-346; Reg. (EU) 2023/988 art. 9) --------------------------------------------------------------------

/**
 * Who the GPSR contact names (Owner 11-09, the public DoC sender's rule): the brand for a private-label style sold under its
 * own name, our company for our own styles and for brand styles sold under our name. The economic operator row that
 * applies (compliance/operators resolveOperators: Owner Q3) gives what is printed; without one, the brand's or our name.
 */
export interface ExpectedSender {
  readonly who: 'BRAND' | 'COMPANY'
  readonly name: string | null
  readonly address: string | null
  readonly contact: string | null
  /** The MANUFACTURER operator row it comes from; null: none applies (Rules & markets › Operators). */
  readonly operatorId: string | null
}

export const senderWho = (style: { readonly brandPartyId: string | null; readonly soldUnderOurName: boolean }): ExpectedSender['who'] =>
  style.brandPartyId !== null && !style.soldUnderOurName ? 'BRAND' : 'COMPANY'

/** An e-mail address or a web address in the typed contact (the electronic address of art. 9(6)). */
export const hasElectronicAddress = (text: string): boolean =>
  /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/.test(text) || /\bhttps?:\/\/\S+\.\S+/i.test(text) || /\bwww\.\S+\.\S+/i.test(text)

/** A postal address names a number (street number or postal code): the same test as W1's maker address. */
export const hasPostalAddress = (text: string): boolean => /\d/.test(text)

const comparable = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Whether the typed text names `name` (case, accents, spaces and punctuation aside: "S.p.A." = "SpA"). */
export const namesSender = (text: string, name: string): boolean => {
  const wanted = comparable(name)
  return wanted !== '' && ` ${comparable(text)} `.includes(` ${wanted} `)
}

/** The contact a person may start from: the operator row's printed name, address and contact, one per line. */
export function suggestedContact(sender: ExpectedSender): string | null {
  const lines = [sender.name, sender.address, sender.contact].filter((line): line is string => line !== null && line.trim() !== '')
  return lines.length === 0 ? null : lines.join('\n').slice(0, 500)
}
