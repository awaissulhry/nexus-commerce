import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { LABEL_RULES_VIEW } from '@nexus/factory-domain/compliance/label-rules/permissions'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { actorOf } from '../../../core/context'
import { officeOf, readTemplate, todayOf } from '../labels/store'
import { companyReach } from '../register-of-rules/common'
import { MARKET_SELECT, RULE_STYLE_SELECT, type RuleWorkOrder } from './facts'
import { evaluateLabel } from './gate'

/**
 * A label's marking checks per market, read side (B-W2b-253; design compliance.labels › lb-checks, lb-rule; the screens are
 * B-W2b-270). Office only: the label with the certificate register's view over its company (W1's readTemplate: else not
 * found), the style likewise. Reads only: nothing is written, no audit row.
 *
 *   style      the one asked, else the revision's, else the work order's, else the label's own (a shared label needs one)
 *   revision   the one asked (of the style), else the work order's, else the newest naming the label, else the RELEASED one,
 *              else the newest (its protector placement asks the removable protectors' warning)
 *   work order one the caller may view (workorders.view over its company and site): its batch is the QR's page
 *   markets    the one asked (an ACTIVE market, switched on or not), else every ACTIVE market switched on, in their order;
 *              none: the label alone
 */

export interface ChecksQuery {
  readonly styleId?: string | undefined
  readonly styleRevisionId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly marketCode?: string | undefined
  readonly colourwayId?: string | undefined
  readonly size?: string | undefined
}

const invalid = (path: string, message: string) => new ValidationError('The label cannot be checked for this.', [{ path, message }])

/** GET /compliance/label-rules/templates/:templateId */
export async function templateChecks(request: FastifyRequest, templateId: string, query: ChecksQuery) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const template = await readTemplate(request, templateId)
  const day = todayOf()
  return request.withClient(async (db) => {
    let workOrder: (RuleWorkOrder & { styleId: string; styleRevisionId: string | null; batchNumber: string | null }) | null = null
    if (query.workOrderId !== undefined) {
      const row = isUuid(query.workOrderId)
        ? await db.workOrder.findUnique({ where: { id: query.workOrderId }, select: { id: true, number: true, companyId: true, siteId: true, styleId: true, styleRevisionId: true, batchNumber: true, releasedAt: true } })
        : null
      if (!row || !can(actor, WORKORDERS_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Work order not found.')
      workOrder = { id: row.id, reference: row.number, released: row.batchNumber !== null && row.releasedAt !== null, companyId: row.companyId, styleId: row.styleId, styleRevisionId: row.styleRevisionId, batchNumber: row.batchNumber }
    }

    let styleId = query.styleId ?? null
    let revisionId: string | null = null
    if (query.styleRevisionId !== undefined) {
      const revision = isUuid(query.styleRevisionId) ? await db.styleRevision.findUnique({ where: { id: query.styleRevisionId }, select: { id: true, styleId: true } }) : null
      if (!revision) throw invalid('querystring/styleRevisionId', 'No such style revision.')
      if (styleId !== null && styleId !== revision.styleId) throw invalid('querystring/styleId', "The style revision is another style's.")
      styleId = revision.styleId
      revisionId = revision.id
    }
    if (workOrder) {
      if (styleId !== null && styleId !== workOrder.styleId) throw invalid('querystring/workOrderId', "The work order makes another style.")
      styleId = workOrder.styleId
      revisionId ??= workOrder.styleRevisionId
    }
    styleId ??= template.styleId
    if (styleId === null) throw invalid('querystring/styleId', 'A shared label is checked on a style: name the style, one of its revisions or a work order.')
    const style = isUuid(styleId) ? await db.style.findUnique({ where: { id: styleId }, select: RULE_STYLE_SELECT }) : null
    if (!style || !can(actor, LABEL_RULES_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
    if (template.styleId !== null && template.styleId !== style.id) throw invalid('querystring/styleId', `Label ${template.code} r${template.revision} is another style's label, not style ${style.code}'s.`)
    if (revisionId === null) {
      const revisions = await db.styleRevision.findMany({ where: { styleId: style.id }, select: { id: true, status: true, labelTemplateId: true }, orderBy: { revision: 'desc' } })
      revisionId = (revisions.find((entry) => entry.labelTemplateId === template.id) ?? revisions.find((entry) => entry.status === 'RELEASED') ?? revisions[0])?.id ?? null
    }
    if (query.size !== undefined && !style.sizes.includes(query.size)) throw invalid('querystring/size', `Size ${query.size} is not in the size range of style ${style.code} (${style.sizes.join(', ') || 'none'}).`)
    if (query.colourwayId !== undefined) {
      const colourway = isUuid(query.colourwayId) ? await db.colourway.findFirst({ where: { id: query.colourwayId, styleId: style.id }, select: { id: true } }) : null
      if (!colourway) throw invalid('querystring/colourwayId', `Not a colourway of style ${style.code}.`)
    }

    const markets = await db.marketProfile.findMany({
      where: { AND: [companyReach(actor) as Prisma.MarketProfileWhereInput, { status: 'ACTIVE' }, query.marketCode !== undefined ? { code: query.marketCode } : { switchedOn: true }] },
      select: MARKET_SELECT,
      orderBy: [{ seq: 'asc' }, { code: 'asc' }],
    })
    if (query.marketCode !== undefined && markets.length === 0) throw new NotFoundError(`There is no market ${query.marketCode}.`)

    const evaluated = await evaluateLabel(db, { template, style, revisionId, colourwayId: query.colourwayId, size: query.size, workOrder, markets, day, office: true })
    return {
      label: { id: template.id, code: template.code, revision: template.revision, status: template.status, kind: template.kind, qrTarget: template.qrTarget, gpsrContact: template.gpsrContact, languages: [...template.languages], version: template.version },
      style: { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass, productType: style.productType, soldUnderOurName: style.soldUnderOurName },
      revisionId,
      workOrder: workOrder ? { id: workOrder.id, number: workOrder.reference, batchNumber: workOrder.batchNumber, released: workOrder.released } : null,
      markets: evaluated.markets.map((entry) => ({
        market: entry.market ? { ...entry.market, labelLanguages: [...entry.market.labelLanguages], markings: [...entry.market.markings] } : null,
        sender: { ...entry.sender },
        blocks: entry.blocks,
        checks: entry.checks.map((check) => ({ ...check, law: check.law.map((ref) => ({ ...ref })), findings: check.findings.map((finding) => ({ ...finding })) })),
      })),
      marking: {
        qr: evaluated.marking.qr ? { ...evaluated.marking.qr } : null,
        warnings: evaluated.marking.warnings.map((warning) => ({ ...warning, texts: warning.texts.map((text) => ({ ...text })) })),
        glove: evaluated.marking.glove ? { level: { ...evaluated.marking.glove.level }, text: evaluated.marking.glove.text, granted: evaluated.marking.glove.granted ? { ...evaluated.marking.glove.granted } : null } : null,
        gpsr: { typed: evaluated.marking.gpsr.typed, expected: { ...evaluated.marking.gpsr.expected }, suggested: evaluated.marking.gpsr.suggested },
      },
      asOf: day,
    }
  })
}
