import { certificateGate, type GateResult, type MadeToMeasureGateRequest } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_BOM_VIEW } from '@nexus/factory-domain/product/bom/permissions'
import type { MtmCheckBody, MtmCheckView } from '@nexus/factory-domain/product/mtm-rules/contracts'
import { MTM_LIMITS, mtmCheck, type CertificateFacts, type ConsumptionLine, type Measures, type SizeFacts } from '@nexus/factory-domain/product/mtm-rules/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { todayOf } from '../../compliance/certificates/certificates'
import { bodyMeasuresOf, gateRequestFor, measurementsOf } from '../../compliance/certificates/gate'
import { checkTemplateOf, contextOf, readTemplate, type Reader } from './store'

/**
 * POST /product/made-to-measure/check (B-W2b-248; PRD-017, PRD-201 … PRD-204): the one check of a measurement set, read
 * only. Against a style (its flag, its template, the body measures of its range, its BOM, its certificate) or a template
 * alone; the measures of a rider's profile revision (sales.measurements.view over the profile's customer: body measures
 * are personal data) or typed ones. The template is the one named, else the style's, else the profile's garment type's.
 * The certificate is asked only for a colourway (the gate's made-to-measure route, B-W1-12), the consumption shown only to
 * product.bom.view. The office template and rider-profile pages (B-W1-17, B-W1-18, deferred behind GATE-MTM) and a quote's
 * made-to-measure line (W2b-5) ask this when they are built.
 */

const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The check cannot be made like this.', issues)
const PLAIN = /^\d{1,6}(?:\.\d{1,4})?$/

function bodyProblems(body: MtmCheckBody): Issue[] {
  const out: Issue[] = []
  if (!body.styleId && !body.templateId) out.push({ path: 'body/styleId', message: 'Name a style, or a measurement template.' })
  if ((body.measurementProfileId === undefined) === (body.measurements === undefined)) out.push({ path: 'body/measurements', message: 'Send the measures, or name a measurement profile: one of the two.' })
  if (!body.styleId) {
    for (const field of ['baseSize', 'colourwayId', 'revisionId', 'date'] as const) if (body[field] !== undefined) out.push({ path: `body/${field}`, message: 'Only with a style.' })
  }
  if (body.measurements) {
    const entries = Object.entries(body.measurements)
    if (entries.length > MTM_LIMITS.measures) out.push({ path: 'body/measurements', message: `At most ${MTM_LIMITS.measures} measures.` })
    for (const [code, entry] of entries) if (!PLAIN.test(entry.value)) out.push({ path: `body/measurements/${code}/value`, message: 'A number with at most 6 digits and 4 decimals ("100.5").' })
  }
  return out
}

/** The revision whose BOM is scaled: the one named (of the style), else the released one, else the newest draft. */
async function revisionOf(db: Reader, styleId: string, revisionId: string | undefined) {
  const select = { id: true, styleId: true, revision: true, status: true } as const
  if (revisionId !== undefined) {
    const row = isUuid(revisionId) ? await db.styleRevision.findUnique({ where: { id: revisionId }, select }) : null
    if (!row || row.styleId !== styleId) throw invalid([{ path: 'body/revisionId', message: 'Not a revision of this style.' }])
    return row
  }
  return (await db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select })) ?? (await db.styleRevision.findFirst({ where: { styleId, status: 'DRAFT' }, orderBy: { revision: 'desc' }, select }))
}

/**
 * The revision's BOM lines as the consumption reads them: the lines of every colourway and, with a colourway, that
 * colourway's own; a line that depends on an option is left out (the unit's options are not known here).
 */
async function consumptionLines(db: Reader, revisionId: string, colourwayId: string | undefined): Promise<{ lines: ConsumptionLine[]; leftOut: { colourway: number; option: number } }> {
  const rows = await db.bomLine.findMany({
    where: { revisionId },
    select: { id: true, seq: true, itemId: true, placement: true, qty: true, uom: true, wastagePct: true, sizeDependent: true, colourwayId: true, optionValueId: true, mtmScalePointId: true, mtmScaleFactor: true },
    orderBy: { seq: 'asc' },
  })
  const sizes = await db.bomLineSize.findMany({ where: { revisionId }, select: { bomLineId: true, size: true, qty: true } })
  const itemIds = [...new Set(rows.map((row) => row.itemId))]
  const items = new Map((itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true } })).map((item) => [item.id, item]))
  const pointIds = [...new Set(rows.flatMap((row) => (row.mtmScalePointId ? [row.mtmScalePointId] : [])))]
  const points = new Map((pointIds.length === 0 ? [] : await db.measurementPoint.findMany({ where: { id: { in: pointIds } }, select: { id: true, code: true } })).map((point) => [point.id, point.code]))
  const leftOut = { colourway: 0, option: 0 }
  const lines: ConsumptionLine[] = []
  for (const row of rows) {
    if (row.colourwayId !== null && row.colourwayId !== colourwayId) {
      leftOut.colourway += 1
      continue
    }
    if (row.optionValueId !== null) {
      leftOut.option += 1
      continue
    }
    const item = items.get(row.itemId)
    lines.push({
      id: row.id,
      seq: row.seq,
      item: { id: row.itemId, code: item?.code ?? '?', name: item?.name ?? '?' },
      placement: row.placement,
      qty: decimalText(row.qty.toString()),
      uom: row.uom,
      wastagePct: decimalText(row.wastagePct.toString()),
      sizeDependent: row.sizeDependent,
      sizes: Object.fromEntries(sizes.filter((entry) => entry.bomLineId === row.id).map((entry) => [entry.size, decimalText(entry.qty.toString())])),
      scale: row.mtmScalePointId && row.mtmScaleFactor !== null ? { pointCode: points.get(row.mtmScalePointId) ?? '?', factor: decimalText(row.mtmScaleFactor.toString()) } : null,
    })
  }
  return { lines, leftOut }
}

const certificateOf = (result: GateResult): CertificateFacts & { certificateNumber: string | null; message: string | null } => ({
  allowed: result.allowed,
  outcome: result.outcome,
  certificateNumber: result.outcome === 'covered' ? result.certificate.number : null,
  message: result.outcome === 'not_required' ? result.message : null,
  reasons: result.outcome === 'refused' ? result.reasons.map((reason) => ({ code: reason.code, message: reason.message, ...(reason.point ? { point: reason.point } : {}) })) : [],
})

/** POST /product/made-to-measure/check */
export async function checkMeasures(caller: CommandCaller, body: MtmCheckBody): Promise<MtmCheckView> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const problems = bodyProblems(body)
  if (problems.length > 0) throw invalid(problems)

  return caller.withClient(async (db) => {
    const style = body.styleId
      ? isUuid(body.styleId)
        ? await db.style.findUnique({ where: { id: body.styleId }, select: { id: true, code: true, companyId: true, mtmAllowed: true, measurementTemplateId: true, sizes: true, sizeScaleId: true } })
        : null
      : null
    if (body.styleId && (!style || !can(actor, PRODUCT_STYLES_VIEW, { companyId: style.companyId }))) throw new NotFoundError('Style not found.')

    const profile = body.measurementProfileId
      ? isUuid(body.measurementProfileId)
        ? await db.measurementProfile.findUnique({ where: { id: body.measurementProfileId }, select: { id: true, partyId: true, revision: true, garmentType: true, measurements: true } })
        : null
      : null
    if (body.measurementProfileId && (!profile || !can(actor, SALES_MEASUREMENTS_VIEW, { partyId: profile.partyId }))) throw new NotFoundError('Measurement profile not found.')

    const templateId = body.templateId ?? style?.measurementTemplateId ?? null
    const record = templateId ? await readTemplate(db, { id: templateId }) : profile ? await readTemplate(db, { code: profile.garmentType }) : null
    if (!record) {
      if (body.templateId) throw new NotFoundError('Measurement template not found.')
      throw new InvalidStateError(`Style ${style!.code} has no measurement template${profile ? `, and garment type ${profile.garmentType} has none either` : ''}: choose the template its made-to-measure units are measured with.`)
    }
    if (!can(actor, PRODUCT_STYLES_VIEW, { companyId: record.template.companyId })) throw new NotFoundError('Measurement template not found.')

    if (style && body.baseSize !== undefined && !style.sizes.includes(body.baseSize)) {
      throw invalid([{ path: 'body/baseSize', message: `${body.baseSize} is not a size of ${style.code}'s range (${style.sizes.join(', ') || 'none'}).` }])
    }
    const sizeRows = style ? await db.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, seq: true, bodyMeasures: true } }) : []
    const sizes: SizeFacts[] = sizeRows.map((row) => ({ code: row.code, seq: row.seq, bodyMeasures: bodyMeasuresOf(row.bodyMeasures) }))
    const measures: Measures = profile ? measurementsOf(profile.measurements) : (body.measurements ?? {})

    const notes: string[] = []
    const revision = style ? await revisionOf(db, style.id, body.revisionId) : null
    const seesBom = style !== null && can(actor, PRODUCT_BOM_VIEW, { companyId: style.companyId })
    let lines: ConsumptionLine[] | null = null
    if (style && seesBom) {
      if (!revision) notes.push(`Style ${style.code} has no revision: no BOM to scale.`)
      else {
        const read = await consumptionLines(db, revision.id, body.colourwayId)
        lines = read.lines
        if (read.leftOut.colourway > 0) notes.push(`${read.leftOut.colourway} line(s) of ${body.colourwayId ? 'other colourways' : 'one colourway only'} left out${body.colourwayId ? '' : ': name the colourway to include its own'}.`)
        if (read.leftOut.option > 0) notes.push(`${read.leftOut.option} line(s) that depend on an option left out.`)
      }
    }

    let certificate: ReturnType<typeof certificateOf> | null = null
    if (style && body.colourwayId) {
      const date = body.date ?? todayOf()
      // The gate's reading of the style, the colourway and its coverages (B-W1-12), asked for this unit's measures.
      const { request } = await gateRequestFor(db, { styleId: style.id, colourwayId: body.colourwayId, size: style.sizes[0] ?? '' }, date)
      const unit: MadeToMeasureGateRequest = {
        style: request.style,
        colourwayId: request.colourwayId,
        date: request.date,
        covers: request.covers,
        madeToMeasure: { measurements: measures, sizeMeasures: Object.fromEntries(sizes.map((size) => [size.code, size.bodyMeasures])) },
      }
      certificate = certificateOf(certificateGate(unit))
    } else if (style) {
      notes.push('The certificate is asked for a colourway: name one to have it checked.')
    }

    const template = checkTemplateOf(record)
    const result = mtmCheck({
      template,
      measures,
      garmentType: profile?.garmentType ?? null,
      style: style ? { code: style.code, mtmAllowed: style.mtmAllowed, measurementTemplateId: style.measurementTemplateId, sizes } : null,
      baseSize: body.baseSize ?? null,
      lines,
      certificate,
    })
    return {
      template: { id: record.template.id, code: record.template.code, name: record.template.name, rulesOn: record.template.rulesOn },
      style: style ? { id: style.id, code: style.code, mtmAllowed: style.mtmAllowed, revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null } : null,
      profile: profile ? { id: profile.id, revision: profile.revision, garmentType: profile.garmentType } : null,
      verdict: result.verdict,
      rulesOn: result.rulesOn,
      rules: result.rules.map((rule) => ({ ...rule, words: { ...rule.words } })),
      baseSize: { ...result.baseSize, points: result.baseSize.points.map((point) => ({ ...point })) },
      alterations: [...result.alterations],
      consumption: result.consumption ? [...result.consumption] : null,
      consumptionHidden: style !== null && !seesBom,
      certificate: certificate ? { allowed: certificate.allowed, outcome: certificate.outcome, certificateNumber: certificate.certificateNumber, message: certificate.message, reasons: [...certificate.reasons] } : null,
      insideCertifiedRange: result.insideCertifiedRange,
      blocks: result.blocks.map((finding) => ({ ...finding, words: finding.words ? { ...finding.words } : null })),
      warnings: result.warnings.map((finding) => ({ ...finding, words: finding.words ? { ...finding.words } : null })),
      notes: [...result.notes, ...notes],
    }
  })
}
