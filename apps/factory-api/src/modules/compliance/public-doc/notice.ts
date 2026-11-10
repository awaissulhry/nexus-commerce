import type { FactoryClient } from '@nexus/factory-db'
import { noticesForPage, type PublishedRecall, type PublicSafetyNotice } from '@nexus/factory-domain/compliance/recall/public-notice'
import type { PublicNotice, PublicNoticeWords, RecallKind } from '@nexus/factory-domain/compliance/recall/rules'
import type { CodeMatch } from './facts'

/**
 * The safety notices of a public DoC page (B-W2b-260 RG1:01; design links.doc › sec:recall "A recall or safety warning for
 * this batch comes first"; Reg. (EU) 2023/988 art. 35-36). Read in the tenant's SYSTEM scope (the caller's client), as the
 * page's other facts: the recalls and withdrawals of the page's style whose public notice is published and not taken down
 * (index `(tenant, styleId)`), with what each calls back resolved to work orders — named, by batch number, through the
 * named serials and the named shipments' lines — so factory-domain compliance/recall/public-notice decides which notices
 * this batch (or style) shows. Codes, numbers and the published words only; no person, no price. A page without one
 * shows none (the section is not drawn).
 */

function wordsOf(value: unknown): PublicNotice {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, PublicNoticeWords> = {}
  for (const [language, words] of Object.entries(value as Record<string, unknown>)) {
    const w = words as Partial<Record<keyof PublicNoticeWords, unknown>> | null
    if (w && typeof w.title === 'string' && typeof w.problem === 'string' && typeof w.action === 'string' && typeof w.contact === 'string') {
      out[language] = { title: w.title, problem: w.problem, action: w.action, contact: w.contact }
    }
  }
  return out
}

export async function readPublicNotices(client: FactoryClient, match: CodeMatch): Promise<PublicSafetyNotice[]> {
  const batch = match.kind === 'BATCH' ? await client.workOrder.findUnique({ where: { id: match.id }, select: { id: true, styleId: true, batchNumber: true } }) : null
  const styleId = match.kind === 'BATCH' ? batch?.styleId : match.id
  if (!styleId) return []
  const actions = await client.recallAction.findMany({
    where: { styleId, noticePublishedAt: { not: null }, noticeWithdrawnAt: null, status: { in: ['ACTIVE', 'CLOSED'] } },
    select: { id: true, companyId: true, kind: true, number: true, noticePublishedAt: true, wholeStyle: true, batchNumbers: true, serials: true, workOrderIds: true, shipmentIds: true, publicNotice: true },
    orderBy: [{ noticePublishedAt: 'desc' }, { id: 'asc' }],
    take: 20,
  })
  const published: PublishedRecall[] = []
  for (const action of actions) {
    const words = wordsOf(action.publicNotice)
    if (Object.keys(words).length === 0) continue
    const whole =
      action.wholeStyle || (action.batchNumbers.length === 0 && action.workOrderIds.length === 0)
        ? []
        : await client.workOrder.findMany({
            where: { companyId: action.companyId, styleId, OR: [...(action.batchNumbers.length ? [{ batchNumber: { in: [...action.batchNumbers] } }] : []), ...(action.workOrderIds.length ? [{ id: { in: [...action.workOrderIds] } }] : [])] },
            select: { id: true, batchNumber: true },
          })
    const viaSerials = !action.wholeStyle && action.serials.length
      ? await client.garmentSerial.findMany({ where: { serial: { in: action.serials.slice(0, 10000) }, workOrderSize: { workOrder: { companyId: action.companyId, styleId } } }, select: { workOrderId: true } })
      : []
    const viaShipments = !action.wholeStyle && action.shipmentIds.length
      ? await client.shipmentLine.findMany({ where: { shipmentId: { in: [...action.shipmentIds] }, shipment: { companyId: action.companyId } }, select: { workOrderId: true } })
      : []
    published.push({
      kind: action.kind as RecallKind,
      number: action.number,
      publishedAt: action.noticePublishedAt!,
      wholeStyle: action.wholeStyle,
      wholeBatches: [...new Set([...action.batchNumbers, ...whole.map((row) => row.batchNumber).filter((value): value is string => value !== null)])],
      wholeWorkOrderIds: whole.map((row) => row.id),
      partWorkOrderIds: [...new Set([...viaSerials.map((row) => row.workOrderId), ...viaShipments.map((row) => row.workOrderId)])],
      bySerial: action.serials.length > 0,
      words,
    })
  }
  return noticesForPage(published, { kind: match.kind, workOrderId: batch?.id ?? null, batchNumber: batch?.batchNumber ?? null })
}
