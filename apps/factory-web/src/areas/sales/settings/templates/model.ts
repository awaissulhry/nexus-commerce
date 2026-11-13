import { INCOTERMS } from '@nexus/factory-domain/sales/quote-terms/rules'
import { TEMPLATE_LIMITS } from '@nexus/factory-domain/sales/quote-templates/rules'
import { parsePercent, parsePrice } from '../../quotes/model'
import type { QuoteTemplate, TemplateRow } from '../../quotes/new-from/api'
import type { Words } from '../../quotes/record/lines-depth/model'
import type { TemplateHeader, TemplateLineInput } from './api'

/**
 * Sales settings › Quote templates (design sales.settings sec:ssettings.templates; SAL-144), pure: the rows the status
 * filter keeps, the template as its dialog edits it (header and lines), what stops a save (the API says the same rules
 * first: templateHeaderProblems / templateLineProblems), the PATCH and PUT it sends, and what Archive N / Restore N reach.
 */

export { TEMPLATE_LIMITS, INCOTERMS }

export type TemplateStatusFilter = 'ACTIVE' | 'ARCHIVED' | 'ALL'

export const templatesShown = (rows: readonly TemplateRow[], status: TemplateStatusFilter): TemplateRow[] => rows.filter((row) => status === 'ALL' || row.status === status)

/** The ticked templates a move reaches: in the right state. */
export const movableTemplates = (rows: readonly TemplateRow[], ids: readonly string[], to: 'archive' | 'restore'): TemplateRow[] => rows.filter((row) => ids.includes(row.id) && row.status === (to === 'archive' ? 'ACTIVE' : 'ARCHIVED'))

export interface LineDraft {
  key: string
  section: string
  styleId: string
  styleCode: string
  styleName: string
  /** '' = chosen when the quote is made. */
  colourwayId: string
  colourwayCode: string
  /** Empty = typed when the quote is made. */
  sizes: Record<string, string>
  /** '' = the customer's price list prices it. */
  unitPrice: string
}

export interface TemplateDraft {
  name: string
  description: string
  /** '' = every company. */
  companyId: string
  language: 'it' | 'en'
  validityDays: string
  firmOffer: boolean
  acceptanceMode: 'SIGN' | 'SIGN_AND_PAY'
  depositPct: string
  depositKind: 'ACCONTO' | 'CAPARRA'
  termsVersion: string
  incoterm: string
  incotermPlace: string
  shipComplete: boolean
  lines: LineDraft[]
}

export const emptyDraft = (companyId: string): TemplateDraft => ({
  name: '',
  description: '',
  companyId,
  language: 'it',
  validityDays: '',
  firmOffer: false,
  acceptanceMode: 'SIGN',
  depositPct: '',
  depositKind: 'ACCONTO',
  termsVersion: '',
  incoterm: '',
  incotermPlace: '',
  shipComplete: false,
  lines: [],
})

export function draftOf(template: QuoteTemplate): TemplateDraft {
  return {
    name: template.name,
    description: template.description ?? '',
    companyId: template.companyId ?? '',
    language: template.language === 'en' ? 'en' : 'it',
    validityDays: template.validityDays === null ? '' : String(template.validityDays),
    firmOffer: template.firmOffer,
    acceptanceMode: template.acceptanceMode === 'SIGN' ? 'SIGN' : 'SIGN_AND_PAY',
    depositPct: template.depositPct ?? '',
    depositKind: template.depositKind === 'CAPARRA' ? 'CAPARRA' : 'ACCONTO',
    termsVersion: template.termsVersion ?? '',
    incoterm: template.incoterm ?? '',
    incotermPlace: template.incotermPlace ?? '',
    shipComplete: template.shipComplete,
    lines: [...template.lines]
      .filter((line) => line.kind === 'SIZE_GRID')
      .sort((a, b) => a.seq - b.seq)
      .map((line) => ({
        key: line.id,
        section: line.section ?? '',
        styleId: line.styleId,
        styleCode: line.style.code,
        styleName: line.style.name,
        colourwayId: line.colourwayId ?? '',
        colourwayCode: line.colourway?.code ?? '',
        sizes: Object.fromEntries(Object.entries(line.sizes ?? {}).map(([size, pieces]) => [size, String(pieces)])),
        unitPrice: line.unitPrice ?? '',
      })),
  }
}

const text = (value: string): string | null => (value.trim() === '' ? null : value.trim())
const whole = (value: string): number | null => (/^\d{1,6}$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : null)

/** What stops the template from being saved, in words. */
export function templateProblems(draft: TemplateDraft, grains: { price: boolean }): Words[] {
  const problems: Words[] = []
  if (draft.name.trim() === '') problems.push({ key: 'tpl.problem.name' })
  if (draft.name.trim().length > TEMPLATE_LIMITS.name) problems.push({ key: 'tpl.problem.nameLong', params: { max: TEMPLATE_LIMITS.name } })
  if (draft.validityDays.trim() !== '' && (whole(draft.validityDays) === null || whole(draft.validityDays)! < 1 || whole(draft.validityDays)! > TEMPLATE_LIMITS.validityDays)) problems.push({ key: 'tpl.problem.validity', params: { max: TEMPLATE_LIMITS.validityDays } })
  if (draft.depositPct.trim() !== '' && parsePercent(draft.depositPct) === null) problems.push({ key: 'tpl.problem.deposit' })
  if (draft.acceptanceMode === 'SIGN_AND_PAY' && (draft.depositPct.trim() === '' || Number(parsePercent(draft.depositPct) ?? 0) <= 0)) problems.push({ key: 'tpl.problem.payNeedsDeposit' })
  if ((draft.incoterm === '') !== (draft.incotermPlace.trim() === '')) problems.push({ key: 'tpl.problem.incoterm' })
  if (draft.incoterm !== '' && !(INCOTERMS as readonly string[]).includes(draft.incoterm)) problems.push({ key: 'tpl.problem.incoterm' })
  if (draft.lines.length > TEMPLATE_LIMITS.lines) problems.push({ key: 'tpl.problem.lines', params: { max: TEMPLATE_LIMITS.lines } })
  draft.lines.forEach((line, index) => {
    const n = index + 1
    if (Object.values(line.sizes).some((value) => value.trim() !== '' && whole(value) === null)) problems.push({ key: 'tpl.problem.pieces', params: { n } })
    if (line.unitPrice.trim() !== '' && (!grains.price || parsePrice(line.unitPrice) === null)) problems.push({ key: 'tpl.problem.price', params: { n } })
  })
  return problems
}

/** The header fields that changed, as PATCH takes them (empty text = null; clearing the Incoterm clears its place). */
export function headerPatch(before: TemplateDraft, after: TemplateDraft): TemplateHeader {
  const patch: TemplateHeader = {}
  if (after.name.trim() !== before.name.trim()) patch.name = after.name.trim()
  if (after.description !== before.description) patch.description = text(after.description)
  if (after.language !== before.language) patch.language = after.language
  if (after.validityDays !== before.validityDays) patch.validityDays = whole(after.validityDays)
  if (after.firmOffer !== before.firmOffer) patch.firmOffer = after.firmOffer
  if (after.acceptanceMode !== before.acceptanceMode) patch.acceptanceMode = after.acceptanceMode
  if (after.depositPct !== before.depositPct) patch.depositPct = after.depositPct.trim() === '' ? null : parsePercent(after.depositPct)
  if (after.depositKind !== before.depositKind) patch.depositKind = after.depositKind
  if (after.termsVersion !== before.termsVersion) patch.termsVersion = text(after.termsVersion)
  if (after.incoterm !== before.incoterm) patch.incoterm = after.incoterm === '' ? null : after.incoterm
  if (after.incotermPlace !== before.incotermPlace || (after.incoterm === '' && before.incoterm !== '')) patch.incotermPlace = after.incoterm === '' ? null : text(after.incotermPlace)
  if (after.shipComplete !== before.shipComplete) patch.shipComplete = after.shipComplete
  return patch
}

/** The lines as PUT …/lines (or the create) takes them: seq 10, 20, … in the order shown. */
export function linesBody(lines: readonly LineDraft[], grains: { price: boolean }): TemplateLineInput[] {
  return lines.map((line, index) => {
    const sizes = Object.fromEntries(Object.entries(line.sizes).flatMap(([size, value]) => { const pieces = whole(value); return pieces && pieces > 0 ? [[size, pieces]] : [] }))
    return {
      seq: (index + 1) * 10,
      section: text(line.section),
      kind: 'SIZE_GRID' as const,
      styleId: line.styleId,
      colourwayId: line.colourwayId || null,
      sizes: Object.keys(sizes).length > 0 ? sizes : null,
      ...(grains.price ? { unitPrice: line.unitPrice.trim() === '' ? null : parsePrice(line.unitPrice) } : {}),
    }
  })
}

/** The lines changed (their order, styles, colourways, pieces, sections, prices). */
export const linesChanged = (before: readonly LineDraft[], after: readonly LineDraft[], grains: { price: boolean }): boolean => JSON.stringify(linesBody(before, grains)) !== JSON.stringify(linesBody(after, grains))

/** Whether the person may keep a template of this company (null: every company), from the session's grants. */
export function mayKeep(permissions: readonly string[]): boolean {
  return permissions.includes('quotes.templates.manage')
}

let lineSeq = 0
export const newLineKey = (): string => `l${++lineSeq}`
