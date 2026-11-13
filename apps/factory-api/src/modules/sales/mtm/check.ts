import { certificateGate } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { mtmCheck, type MtmCheck, type SizeFacts } from '@nexus/factory-domain/product/mtm-rules/rules'
import { unitFindings, type ReviewStatus, type UnitFinding } from '@nexus/factory-domain/sales/mtm/rules'
import { bodyMeasuresOf, gateRequestFor, measurementsOf } from '../../compliance/certificates/gate'
import { checkTemplateOf, readTemplate } from '../../product/mtm-rules/store'
import type { Reader } from './store'

/**
 * One made-to-measure unit checked (B-W2b-358 calls B-W2b-248's check; PRD-017, PRD-201 … PRD-203, PRD-288): the style (flagged,
 * its template), the template's rules while they are on, the base size (typed, else the one the measures point to), the
 * alteration limits, and the certificate's made-to-measure route for the unit's colourway (B-W1-12's gate, read with this
 * client), then the unit's findings in words (factory-domain sales/mtm unitFindings). Read only, with the caller's client: the
 * quote and order line checks, the quote's made-to-measure line writes and the documents' units read use it. No consumption
 * (a quote line needs none).
 */

export interface UnitQuestion {
  readonly kind: 'QUOTE' | 'ORDER'
  readonly seq: number
  readonly styleId: string
  readonly colourwayId: string
  readonly profileId: string
  readonly baseSize: string | null
  readonly now: Date
}

export interface UnitAnswer {
  readonly check: MtmCheck
  readonly style: { readonly id: string; readonly code: string; readonly mtmAllowed: boolean; readonly sizes: readonly string[] }
  readonly colourwayCode: string
  readonly template: { readonly id: string; readonly code: string; readonly rulesOn: boolean } | null
  readonly profile: { readonly id: string; readonly partyId: string; readonly riderName: string; readonly garmentType: string; readonly revision: number; readonly latestRevision: number; readonly reviewStatus: ReviewStatus; readonly takenAt: Date }
  readonly findings: UnitFinding[]
}

/** The unit's check and findings; null when the style, colourway or profile is gone. */
export async function checkUnit(db: Reader, question: UnitQuestion): Promise<UnitAnswer | null> {
  const style = await db.style.findUnique({ where: { id: question.styleId }, select: { id: true, code: true, mtmAllowed: true, measurementTemplateId: true, sizes: true, sizeScaleId: true } })
  const colourway = await db.colourway.findFirst({ where: { id: question.colourwayId, styleId: question.styleId }, select: { id: true, code: true } })
  const profile = await db.measurementProfile.findUnique({ where: { id: question.profileId }, select: { id: true, partyId: true, riderName: true, garmentType: true, revision: true, reviewStatus: true, takenAt: true, measurements: true } })
  if (!style || !colourway || !profile) return null
  const latest = await db.measurementProfile.findFirst({ where: { partyId: profile.partyId, riderName: profile.riderName, garmentType: profile.garmentType }, orderBy: { revision: 'desc' }, select: { revision: true } })
  const record = style.measurementTemplateId ? await readTemplate(db, { id: style.measurementTemplateId }) : null
  const sizeRows = await db.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, seq: true, bodyMeasures: true } })
  const sizes: SizeFacts[] = sizeRows.map((row) => ({ code: row.code, seq: row.seq, bodyMeasures: bodyMeasuresOf(row.bodyMeasures) }))
  const today: BusinessDate = businessDate(question.now)

  let certificate: Parameters<typeof mtmCheck>[0]['certificate'] = null
  try {
    const { request } = await gateRequestFor(db, { styleId: style.id, colourwayId: colourway.id, measurementProfileId: profile.id }, today)
    const result = certificateGate(request)
    certificate = { allowed: result.allowed, outcome: result.outcome, reasons: result.outcome === 'refused' ? result.reasons.map((reason) => ({ code: reason.code, message: reason.message, ...(reason.point ? { point: reason.point } : {}) })) : [] }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
  }

  const template = record ? checkTemplateOf(record) : null
  const check: MtmCheck = template
    ? mtmCheck({ template, measures: measurementsOf(profile.measurements), garmentType: profile.garmentType, style: { code: style.code, mtmAllowed: style.mtmAllowed, measurementTemplateId: style.measurementTemplateId, sizes }, baseSize: question.baseSize, lines: null, certificate })
    : { rulesOn: false, rules: [], baseSize: { size: null, how: null, tie: false, points: [], detail: 'No template.', used: question.baseSize, typed: question.baseSize }, alterations: [], consumption: null, insideCertifiedRange: null, blocks: [], warnings: [], verdict: 'OK', notes: [] }
  const blocks = check.blocks.filter((finding) => finding.kind === 'RULE' || finding.kind === 'ALTERATION' || finding.kind === 'CERTIFICATE').map((finding) => finding.message)
  const findings = unitFindings({
    kind: question.kind,
    seq: question.seq,
    label: `Line ${question.seq} (${style.code} ${colourway.code})`,
    style: { code: style.code, mtmAllowed: style.mtmAllowed },
    template: template ? { code: template.code, rulesOn: template.rulesOn } : null,
    profile: { riderName: profile.riderName, garmentType: profile.garmentType, revision: profile.revision, latestRevision: latest?.revision ?? profile.revision, reviewStatus: profile.reviewStatus as ReviewStatus, takenOn: businessDate(profile.takenAt) },
    blocks,
    today,
  })
  return {
    check,
    style: { id: style.id, code: style.code, mtmAllowed: style.mtmAllowed, sizes: style.sizes },
    colourwayCode: colourway.code,
    template: template ? { id: template.id, code: template.code, rulesOn: template.rulesOn } : null,
    profile: { id: profile.id, partyId: profile.partyId, riderName: profile.riderName, garmentType: profile.garmentType, revision: profile.revision, latestRevision: latest?.revision ?? profile.revision, reviewStatus: profile.reviewStatus as ReviewStatus, takenAt: profile.takenAt },
    findings,
  }
}
