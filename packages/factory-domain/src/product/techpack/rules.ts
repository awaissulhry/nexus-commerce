import type { Issue } from '../../core/errors'
import { DOCUMENT_LANGUAGES, type DocumentLanguage } from '../../documents/model'
import { partyMaySee } from '../style-texts/private-label'

/**
 * The tech pack of a style revision (B-W2b-230; PRD-130 live tech pack, PRD-131 tech pack PDF, PRD-133 audience-specific,
 * PRD-134 construction details, PRD-136 labels and packaging page, PRD-138 QR to the current version, PRD-147 protection
 * and performance spec; design products.styles `style.techpack`). Pure.
 *
 * The tech pack is a VIEW of the live revision, section by section (design `style.tp.outline`: cover, sketches, BOM,
 * colourways, size spec, construction, labels and packaging, protection and performance, compliance, revision log); it
 * stores nothing of its own. Its PDF is a generated document (factory-db GeneratedDocument kind TECH_PACK, of the
 * StyleRevision) per audience; the audience decides what it shows, and the SERVER leaves the rest out (design
 * `style.tp.audience` "Money and names are removed on the server, not hidden on screen"):
 *
 *   INTERNAL        everything; a cost only on screen and only for the cost grain (a PDF never carries money: it travels)
 *   SUBCONTRACTOR   no money, no minutes (they make the labour cost and the piece pay), no supplier or workshop names, no
 *                   alternates, no material approval states, no customer names; the kit mark (what comes with the kit)
 *   BRAND           as the subcontractor, and no internal notes (BOM line notes, the revision's change note) and no kit mark;
 *                   a private-label style's brand copy only for that brand (B-W2b-227: only that brand may see its pack)
 *
 * Owner W2b-4 (plan §3 "Owner answers built in"): no partner sees a cost, a margin or a pay figure; the partner copy of the
 * tech pack has none (the tests scan every key of a partner copy).
 */

export const TECH_PACK_AUDIENCES = ['INTERNAL', 'SUBCONTRACTOR', 'BRAND'] as const
export type TechPackAudience = (typeof TECH_PACK_AUDIENCES)[number]

/** The design's contents, in its order (`style.tp.outline`). */
export const TECH_PACK_SECTIONS = ['COVER', 'SKETCHES', 'BOM', 'COLOURWAYS', 'SIZE_SPEC', 'CONSTRUCTION', 'LABELS', 'PROTECTION', 'COMPLIANCE', 'REVISION_LOG'] as const
export type TechPackSection = (typeof TECH_PACK_SECTIONS)[number]

/** The languages the PDF prints (the documents platform's: Italian and English; more languages are PRD-132, Later). */
export const TECH_PACK_LANGUAGES = DOCUMENT_LANGUAGES
export type TechPackLanguage = DocumentLanguage

/** What an audience never gets (the server leaves it out of the view and the PDF). */
export const LEFT_OUT_KINDS = ['MONEY', 'MINUTES', 'SUPPLIERS', 'ALTERNATES', 'APPROVALS', 'CUSTOMERS', 'INTERNAL_NOTES', 'PEOPLE'] as const
export type LeftOutKind = (typeof LEFT_OUT_KINDS)[number]

const PARTNER_LEAVES_OUT: readonly LeftOutKind[] = ['MONEY', 'MINUTES', 'SUPPLIERS', 'ALTERNATES', 'APPROVALS', 'CUSTOMERS', 'PEOPLE']

export const LEFT_OUT: Readonly<Record<TechPackAudience, readonly LeftOutKind[]>> = Object.freeze({
  INTERNAL: [],
  SUBCONTRACTOR: PARTNER_LEAVES_OUT,
  BRAND: [...PARTNER_LEAVES_OUT, 'INTERNAL_NOTES'],
})

/** In the API's words (screens say their own per kind). */
export const LEFT_OUT_WORDS: Readonly<Record<LeftOutKind, string>> = Object.freeze({
  MONEY: 'costs, margins and pay',
  MINUTES: 'standard minutes',
  SUPPLIERS: 'supplier and workshop names',
  ALTERNATES: 'alternate materials',
  APPROVALS: 'material approval states',
  CUSTOMERS: 'which customer sends a material',
  INTERNAL_NOTES: 'internal notes',
  PEOPLE: "people's names",
})

export const isPartnerAudience = (audience: TechPackAudience): boolean => audience !== 'INTERNAL'
export const leavesOut = (audience: TechPackAudience, kind: LeftOutKind): boolean => LEFT_OUT[audience].includes(kind)
/** The kit mark ("comes with the kit") is for the workshop and the office. */
export const showsKit = (audience: TechPackAudience): boolean => audience !== 'BRAND'

/**
 * The PDF's layout name per audience (GeneratedDocument.layout: "the document template's name"): the versions of one
 * revision count across audiences (the table's unique key), so the layout says which audience a version was for and a
 * scan compares a page with the newest version of the SAME audience and language.
 */
export const TECH_PACK_LAYOUTS: Readonly<Record<TechPackAudience, string>> = Object.freeze({
  INTERNAL: 'TECH_PACK_INTERNAL/1',
  SUBCONTRACTOR: 'TECH_PACK_SUBCONTRACTOR/1',
  BRAND: 'TECH_PACK_BRAND/1',
})

export const layoutOf = (audience: TechPackAudience): string => TECH_PACK_LAYOUTS[audience]

/** The audience a stored version's layout names (null: not a tech pack layout of this step). */
export function audienceOfLayout(layout: string | null): TechPackAudience | null {
  for (const audience of TECH_PACK_AUDIENCES) if (TECH_PACK_LAYOUTS[audience] === layout) return audience
  return null
}

/** The sections asked, in the design's order, each once; none asked: every section. */
export function orderedSections(asked: readonly TechPackSection[] | undefined): TechPackSection[] {
  if (asked === undefined || asked.length === 0) return [...TECH_PACK_SECTIONS]
  const set = new Set(asked)
  return TECH_PACK_SECTIONS.filter((section) => set.has(section))
}

/** What the sections asked of a PDF lack (the caller's permissions say which they may see), in words at their place. */
export function sectionProblems(asked: readonly TechPackSection[], allowed: ReadonlySet<TechPackSection>, why: Readonly<Partial<Record<TechPackSection, string>>>, at = 'body/sections'): Issue[] {
  const issues: Issue[] = []
  asked.forEach((section, index) => {
    if (asked.indexOf(section) !== index) issues.push({ path: `${at}/${index}`, message: `${SECTION_WORDS[section]} is asked twice.` })
    else if (!allowed.has(section)) issues.push({ path: `${at}/${index}`, message: why[section] ?? `You cannot see the ${SECTION_WORDS[section].toLowerCase()} section.` })
  })
  return issues
}

/** A section in the API's words (screens and the PDF say their own per language). */
export const SECTION_WORDS: Readonly<Record<TechPackSection, string>> = Object.freeze({
  COVER: 'Cover',
  SKETCHES: 'Sketches',
  BOM: 'BOM',
  COLOURWAYS: 'Colourways',
  SIZE_SPEC: 'Size spec',
  CONSTRUCTION: 'Construction',
  LABELS: 'Labels and packaging',
  PROTECTION: 'Protection and performance',
  COMPLIANCE: 'Compliance',
  REVISION_LOG: 'Revision log',
})

/** The party a copy is for, as the rules read it. */
export interface CopyParty {
  readonly id: string
  readonly code: string
  readonly roles: readonly string[]
  readonly status: string
}

/** The roles a party of each partner audience has (a brand copy goes to a customer or a brand; a workshop copy to a workshop). */
export const PARTY_ROLES_OF: Readonly<Record<Exclude<TechPackAudience, 'INTERNAL'>, readonly string[]>> = Object.freeze({
  SUBCONTRACTOR: ['SUBCONTRACTOR', 'SUPPLIER'],
  BRAND: ['CUSTOMER', 'BRAND'],
})

/**
 * Who a copy may be for (null: fine), in words at body/partyId (or body/audience):
 * - an internal copy names nobody;
 * - a partner copy may name its party (printed on the cover), of the audience's roles, not blocked or archived;
 * - a private-label style's brand copy is for that brand only, and must name it (B-W2b-227: only that brand may see its pack).
 */
export function copyPartyProblem(audience: TechPackAudience, style: { readonly code: string; readonly brandPartyId: string | null }, party: CopyParty | null, named: boolean): Issue | null {
  if (audience === 'INTERNAL') return named ? { path: 'body/partyId', message: 'An internal copy is for nobody outside: leave the party out.' } : null
  if (named && party === null) return { path: 'body/partyId', message: 'No such party.' }
  if (party !== null) {
    const roles = PARTY_ROLES_OF[audience]
    if (!party.roles.some((role) => roles.includes(role))) {
      return { path: 'body/partyId', message: audience === 'BRAND' ? `${party.code} is not a customer or a brand: a brand copy goes to a customer or a brand.` : `${party.code} is not a workshop or a supplier: a subcontractor copy goes to a workshop.` }
    }
    if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') return { path: 'body/partyId', message: `${party.code} is ${party.status === 'BLOCKED' ? 'blocked' : 'archived'}: no copy goes to it.` }
  }
  if (audience === 'BRAND' && style.brandPartyId !== null) {
    if (party === null) return { path: 'body/partyId', message: `Style ${style.code} is a brand's private-label style: say the brand the copy is for (only that brand may see its tech pack).` }
    if (!partyMaySee(style, party.id)) return { path: 'body/partyId', message: `Style ${style.code} is another brand's private-label style: only that brand may see its tech pack.` }
  }
  return null
}

/** The words of a key a partner copy never carries: money (the grains), minutes, suppliers and workshops, people. */
const PARTNER_FORBIDDEN_WORDS = new Set(['cost', 'costs', 'margin', 'margins', 'price', 'prices', 'amount', 'amounts', 'total', 'totals', 'wage', 'wages', 'pay', 'rate', 'rates', 'earning', 'earnings', 'minute', 'minutes', 'smv', 'supplier', 'suppliers', 'workshop', 'workshops', 'alternate', 'alternates', 'approval'])
const PARTNER_FORBIDDEN_KEYS = new Set(['releasedBy', 'createdBy', 'approvedBy', 'testedBy', 'customerSuppliedBy'])

/**
 * Whether a key may never be in a partner copy, whatever its place (the tests scan every key of a partner view and of its
 * paper): a camelCase word of it names money, minutes, a supplier or workshop, an alternate or an approval, or it names a
 * person.
 */
export function partnerForbiddenKey(key: string): boolean {
  if (PARTNER_FORBIDDEN_KEYS.has(key)) return true
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => PARTNER_FORBIDDEN_WORDS.has(word))
}

/** Every key of a value, deep (the tests' scan). */
export function keysOf(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, out)
  else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.add(key)
      keysOf(entry, out)
    }
  }
  return out
}
