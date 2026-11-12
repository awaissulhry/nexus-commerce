import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { labelQrOf, senderWho, WARNING_PHRASE_KEYS, type ExpectedSender } from '@nexus/factory-domain/compliance/label-rules/marking'
import { resolveOperators } from '@nexus/factory-domain/compliance/operators/rules'
import type { LabelRuleFacts, RuleBody, RuleCertificate, RuleMarket, RuleStyle, RuleTemplate } from '@nexus/factory-domain/compliance/label-rules/rules'
import { LAYOUT_PRESETS, printedFields, type LabelQrTarget } from '@nexus/factory-domain/compliance/labels/rules'
import { publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import type { PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { publicDocPage } from '@nexus/factory-domain/compliance/public-doc/rules'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { classificationOf } from '@nexus/factory-domain/product/compliance/rules'
import type { PpeCategory, ProductType } from '@nexus/factory-domain/product/styles/rules'
import { processEmail } from '../../../platform/email-out/service'
import { certificateGateFor } from '../certificates/gate'
import { factsOf, type Reader, type TemplateRow } from '../labels/store'
import { rowFacts } from '../operators/operators'
import { approvedTexts } from '../phrases/store'
import { readMatchFacts } from '../public-doc/facts'
// B-W2b-288 (FU2:01): the label class warnings read the PPE consultant's yes per label template (office only).
import { labelLanguagesApproved } from '../ppe-texts/store'

/**
 * The facts of a label's marking checks (B-W2b-253), read with the caller's client one query after another: the template
 * (W1's row with B-W2b-218's columns), the style, the certificate covering a cell (W1's certificate gate), the notified
 * body directory's entries with the label's number, the revision's protector pockets, the warning phrases' approved
 * texts (B-W2b-249), the markets, the GPSR sender per market (operator roles, Owner Q3 / 11-09), and where the QR points.
 *
 * `office` false (the floor's label print, B-W2b-254's gate): the directory and the style's published declaration are
 * not read (the floor has no grant on NotifiedBody or ComplianceDocument; a refused query would abort the command).
 */

export const RULE_STYLE_SELECT = {
  id: true,
  code: true,
  name: true,
  companyId: true,
  productType: true,
  ppeCategory: true,
  ppeStandard: true,
  ppeClass: true,
  brandPartyId: true,
  soldUnderOurName: true,
  sizes: true,
  baseSize: true,
} as const satisfies Prisma.StyleSelect
export type RuleStyleRow = Prisma.StyleGetPayload<{ select: typeof RULE_STYLE_SELECT }>

const OPERATOR_FACTS_SELECT = {
  id: true,
  companyId: true,
  styleId: true,
  brandPartyId: true,
  marketCode: true,
  role: true,
  partyId: true,
  printedName: true,
  printedAddress: true,
  contact: true,
  validFrom: true,
  validTo: true,
} as const satisfies Prisma.EconomicOperatorRoleSelect

export const MARKET_SELECT = { id: true, code: true, name: true, companyId: true, switchedOn: true, labelLanguages: true, markings: true, gpsrContactNeeded: true, seq: true } as const satisfies Prisma.MarketProfileSelect
export type MarketRow = Prisma.MarketProfileGetPayload<{ select: typeof MARKET_SELECT }>

export const ruleStyleOf = (row: RuleStyleRow): RuleStyle => ({
  id: row.id,
  code: row.code,
  name: row.name,
  productType: row.productType as ProductType,
  ppeCategory: row.ppeCategory as PpeCategory,
  ppeStandard: row.ppeStandard,
  ppeClass: row.ppeClass,
  brandPartyId: row.brandPartyId,
  soldUnderOurName: row.soldUnderOurName,
  companyId: row.companyId,
})

export const ruleMarketOf = (row: MarketRow): RuleMarket => ({ code: row.code, name: row.name, switchedOn: row.switchedOn, labelLanguages: [...row.labelLanguages], markings: [...row.markings], gpsrContactNeeded: row.gpsrContactNeeded })

/** The template as the checks read it, with what it prints for the style (W1's printedFields, kind-aware). */
export function ruleTemplateOf(row: TemplateRow, style: RuleStyle): RuleTemplate {
  const facts = factsOf(row)
  return {
    id: row.id,
    code: row.code,
    revision: row.revision,
    status: row.status,
    kind: facts.kind ?? 'PPE_GARMENT',
    languages: [...facts.languages],
    makerPartyId: facts.makerPartyId,
    makerName: facts.makerName,
    makerAddress: facts.makerAddress,
    gpsrContact: row.gpsrContact,
    qrTarget: row.qrTarget as LabelQrTarget,
    notifiedBodyNumber: facts.layout.notifiedBodyNumber,
    ceHeight: LAYOUT_PRESETS[facts.layout.preset].ce,
    printed: printedFields(facts, classificationOf(style).isPpe),
  }
}

/** The work order a batch QR names, and whether its page answers (a released batch). */
export interface RuleWorkOrder {
  readonly id: string
  readonly reference: string
  readonly released: boolean
  /** The company that makes the batch (a tenant-wide style's maker company for the operator rows). */
  readonly companyId: string | null
}

export interface FactsQuestion {
  readonly template: TemplateRow
  readonly style: RuleStyleRow
  /** The style revision (its protector placement); null: none. */
  readonly revisionId: string | null
  /** The cell whose certificate the label prints; left out: the style's first ACTIVE colourway in its base size. */
  readonly colourwayId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly workOrder: RuleWorkOrder | null
  /** The languages the warnings are read in (the label's and the markets'). */
  readonly languages: readonly string[]
  readonly day: BusinessDate
  readonly office: boolean
}

/** The page's own sender is not needed to know whether it shows a declaration. */
const PLACEHOLDER_SENDER: PublicDocPage['sender'] = { companyId: '00000000-0000-7000-8000-000000000000', name: '', companyName: '', logoPath: null, logoDarkPath: null, accentColour: null }

const levelsOf = (value: unknown): Readonly<Record<string, string>> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : null

async function certificateOf(db: Reader, style: RuleStyleRow, ask: { colourwayId?: string | null | undefined; size?: string | null | undefined }, day: BusinessDate): Promise<RuleCertificate | null> {
  if (!classificationOf(ruleStyleOf(style)).certificateRequired) return null
  const colourway = ask.colourwayId
    ? { id: ask.colourwayId }
    : ((await db.colourway.findFirst({ where: { styleId: style.id, status: 'ACTIVE' }, select: { id: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })) ??
      (await db.colourway.findFirst({ where: { styleId: style.id }, select: { id: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })))
  const size = ask.size ?? style.baseSize ?? style.sizes[0] ?? null
  if (!colourway || size === null) return null
  const answer = await certificateGateFor(db, { styleId: style.id, colourwayId: colourway.id, size }, day)
  if (answer.outcome !== 'covered' || !answer.certificate) return null
  const row = await db.certificate.findUnique({ where: { id: answer.certificate.id }, select: { id: true, number: true, standard: true, ppeClass: true, notifiedBodyNumber: true, performanceLevels: true } })
  return row ? { id: row.id, number: row.number, standard: row.standard, ppeClass: row.ppeClass, notifiedBodyNumber: row.notifiedBodyNumber, levels: levelsOf(row.performanceLevels) } : null
}

/** Whether the style's public page shows a declaration today (B-W2b-166's own read). */
async function styleLive(db: Reader, styleId: string, day: BusinessDate): Promise<boolean> {
  const code = publicDocCodeOf(styleId)
  // readMatchFacts names a client; it only queries, so a command's transaction serves it as well.
  const read = await readMatchFacts(db as FactoryClient, { tenantId: 'office', kind: 'STYLE', id: styleId }, code, day)
  return read !== null && publicDocPage(read.facts, PLACEHOLDER_SENDER, { email: null }).declaration !== null
}

/** Everything the checks need but the market and its sender. */
export async function readRuleFacts(db: Reader, question: FactsQuestion): Promise<LabelRuleFacts> {
  const style = ruleStyleOf(question.style)
  const template = ruleTemplateOf(question.template, style)
  const certificate = await certificateOf(db, question.style, question, question.day)
  let bodies: RuleBody[] | null = null
  if (question.office && template.notifiedBodyNumber !== null) {
    bodies = (await db.notifiedBody.findMany({ where: { number: template.notifiedBodyNumber }, select: { number: true, name: true, status: true } })).map((body) => ({ ...body, status: body.status as string }))
  }
  const placements = question.revisionId ? await db.protectorPlacement.findMany({ where: { revisionId: question.revisionId }, select: { pocket: true }, orderBy: { seq: 'asc' } }) : []
  const keys = Object.values(WARNING_PHRASE_KEYS)
  const texts = await approvedTexts(db, keys, question.languages)
  const byKey = new Map<string, Map<string, string | null>>()
  const found = new Set<string>()
  for (const entry of texts) {
    if (entry.revision > 0) found.add(entry.key)
    if (!byKey.has(entry.key)) byKey.set(entry.key, new Map())
    byKey.get(entry.key)!.set(entry.language, entry.text)
  }
  // An ACTIVE phrase with no language asked is still found.
  if (question.languages.length === 0) for (const row of await db.phrase.findMany({ where: { key: { in: keys }, status: 'ACTIVE' }, select: { key: true } })) found.add(row.key)
  const origin = template.qrTarget === 'NONE' ? '' : processEmail().webOrigin
  const qr = labelQrOf(template.qrTarget, style, question.workOrder ? { id: question.workOrder.id, reference: question.workOrder.reference } : null, origin)
  let live: boolean | null = null
  if (qr?.kind === 'BATCH' && question.workOrder) live = question.workOrder.released
  if (qr?.kind === 'STYLE' && question.office) live = await styleLive(db, style.id, question.day)
  return {
    template,
    style,
    certificate,
    bodies: bodies ?? [],
    bodiesRead: bodies !== null,
    protectorPockets: [...new Set(placements.map((row) => row.pocket as string))],
    phraseKeys: found,
    texts: byKey,
    qr: { qr, origin, live },
    ppeTextsApproved: false,
    // B-W2b-288 (FU2:01): the languages a PPE consultant's yes covers for this label's code and revision (Compliance › Rules &
    // markets › Templates); the floor has no grant on the approvals: null there (the warnings wait, as before).
    ppeTextLanguages: question.office ? await labelLanguagesApproved(db, { code: question.template.code, revision: question.template.revision, companyId: question.template.companyId }) : null,
  }
}

/**
 * Who the label's GPSR contact names in a market (Owner 11-09): the MANUFACTURER operator row that applies (style, brand,
 * company, tenant; the market's before every market's). The company: the style's, else (a tenant-wide style) the work order's. For a private-label style sold under the brand's name only a
 * style or brand row counts (a company row names us, not the brand).
 */
export async function senderFor(db: Reader, style: RuleStyleRow, marketCode: string | null, day: BusinessDate, makerCompanyId: string | null = null): Promise<ExpectedSender> {
  const who = senderWho(style)
  const companyId = style.companyId ?? makerCompanyId
  // The rows as compliance/operators operatorsFor reads them, without the party relations: the floor has no grant on Party.
  const rows = await db.economicOperatorRole.findMany({
    where: {
      AND: [
        { OR: [{ styleId: style.id }, ...(style.brandPartyId ? [{ brandPartyId: style.brandPartyId }] : []), { styleId: null, brandPartyId: null }] },
        { OR: [{ marketCode: null }, ...(marketCode ? [{ marketCode }] : [])] },
      ],
    },
    select: OPERATOR_FACTS_SELECT,
  })
  const resolved = resolveOperators(rows.map(rowFacts), { styleId: style.id, companyId, brandPartyId: style.brandPartyId, soldUnderOurName: style.soldUnderOurName, marketCode, day })
  const maker = resolved.find((entry) => entry.role === 'MANUFACTURER')
  if (!maker || (who === 'BRAND' && maker.level !== 'STYLE' && maker.level !== 'BRAND')) return { who, name: null, address: null, contact: null, operatorId: null }
  return { who, name: maker.row.printedName, address: maker.row.printedAddress, contact: maker.row.contact, operatorId: maker.row.id }
}
