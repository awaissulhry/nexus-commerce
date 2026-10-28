import type { FactoryClient } from '@nexus/factory-db'
import {
  certificateGate,
  type BodyMeasures,
  type GateCover,
  type GateReason,
  type GateRequest,
  type GateResult,
  type Measurements,
  type PpeCategory,
} from '@nexus/factory-domain/compliance/cert-gate/gate'
import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { dayOf, officeOf, todayOf } from './certificates'

/**
 * The certificate gate through the API (QHS-051, PRD-284, PRD-288; Reg. (EU) 2016/425): reads what the domain's
 * `certificateGate` needs — the style, its ACTIVE coverages with their certificates, and for a made-to-measure unit the
 * rider's measurement profile and the body measures of the style's sizes — and answers covered, not required, or
 * refused with every reason. `POST /compliance/certificates/gate` asks it for a person; the label (B-W1-19, 44),
 * work-order (B-W1-38) and release (B-W1-45) steps call `certificateGateFor(client, …)` inside their own command, so
 * the answer and their write see the same rows.
 */

export interface GateQuestion {
  readonly styleId: string
  readonly colourwayId: string
  /** A garment in a standard size … */
  readonly size?: string | undefined
  /** … or a made-to-measure unit for this rider's measurement profile. */
  readonly measurementProfileId?: string | undefined
}

export interface GateAnswer {
  readonly allowed: boolean
  readonly outcome: GateResult['outcome']
  readonly route: GateResult['route']
  readonly date: BusinessDate
  readonly styleId: string
  readonly colourwayId: string
  readonly size: string | null
  readonly measurementProfileId: string | null
  readonly certificate: Extract<GateResult, { outcome: 'covered' }>['certificate'] | null
  readonly coverageId: string | null
  readonly message: string | null
  readonly reasons: GateReason[]
}

type Reader = FactoryClient | CommandTx

/** A JSON value as a decimal string, or null (body measures and measurements are stored as decimal strings). */
function decimalText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** Size.bodyMeasures as the gate reads it: entries that are not a { min, max, unit } range are left out. */
export function bodyMeasuresOf(value: unknown): BodyMeasures | null {
  if (value === null || value === undefined) return null
  const measures: Record<string, { min: string; max: string; unit: string }> = {}
  for (const [point, raw] of Object.entries(asRecord(value))) {
    const range = asRecord(raw)
    const min = decimalText(range.min)
    const max = decimalText(range.max)
    if (min !== null && max !== null && typeof range.unit === 'string') measures[point] = { min, max, unit: range.unit }
  }
  return measures
}

/** MeasurementProfile.measurements as the gate reads it: an unreadable entry stays, so the gate names it. */
export function measurementsOf(value: unknown): Measurements {
  const measurements: Record<string, { value: string; unit: string }> = {}
  for (const [point, raw] of Object.entries(asRecord(value))) {
    const entry = asRecord(raw)
    measurements[point] = { value: decimalText(entry.value) ?? '', unit: typeof entry.unit === 'string' ? entry.unit : '' }
  }
  return measurements
}

const invalid = (path: string, message: string) => new ValidationError('The gate question is not valid.', [{ path: `body/${path}`, message }])

/** The gate's request, read with this client (a request's, or a command's transaction). */
export async function gateRequestFor(client: Reader, question: GateQuestion, date: BusinessDate): Promise<{ request: GateRequest; companyId: string | null }> {
  if ((question.size === undefined) === (question.measurementProfileId === undefined)) {
    throw invalid('size', 'Ask about a standard size or a made-to-measure profile: exactly one of size and measurementProfileId.')
  }
  const style = await client.style.findUnique({
    where: { id: question.styleId },
    select: { id: true, code: true, companyId: true, ppeCategory: true, sizes: true, mtmAllowed: true, sizeScaleId: true },
  })
  if (!style) throw new NotFoundError('Style not found.')
  const colourway = await client.colourway.findFirst({ where: { id: question.colourwayId, styleId: style.id }, select: { id: true } })
  if (!colourway) throw invalid('colourwayId', 'Not a colourway of the style.')

  const coverages = await client.certificateCoverage.findMany({
    where: { styleId: style.id, status: 'ACTIVE' },
    select: {
      id: true,
      colourwayIds: true,
      sizes: true,
      allowsMadeToMeasure: true,
      certificate: {
        select: { id: true, number: true, standard: true, ppeClass: true, notifiedBodyName: true, notifiedBodyNumber: true, validFrom: true, validTo: true, status: true },
      },
    },
    orderBy: { id: 'asc' },
  })
  const covers: GateCover[] = coverages.map((coverage) => ({
    coverageId: coverage.id,
    colourwayIds: coverage.colourwayIds,
    sizes: coverage.sizes,
    allowsMadeToMeasure: coverage.allowsMadeToMeasure,
    certificate: { ...coverage.certificate, validFrom: dayOf(coverage.certificate.validFrom), validTo: dayOf(coverage.certificate.validTo) },
  }))
  const base = {
    style: { id: style.id, code: style.code, ppeCategory: style.ppeCategory as PpeCategory, sizes: style.sizes, mtmAllowed: style.mtmAllowed },
    colourwayId: colourway.id,
    date,
    covers,
  }
  if (question.size !== undefined) return { request: { ...base, size: question.size }, companyId: style.companyId }

  const profile = await client.measurementProfile.findUnique({ where: { id: question.measurementProfileId! }, select: { measurements: true } })
  if (!profile) throw new NotFoundError('Measurement profile not found.')
  const sizes = await client.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, bodyMeasures: true } })
  const sizeMeasures = Object.fromEntries(sizes.map((size) => [size.code, bodyMeasuresOf(size.bodyMeasures)]))
  return { request: { ...base, madeToMeasure: { measurements: measurementsOf(profile.measurements), sizeMeasures } }, companyId: style.companyId }
}

function answerOf(question: GateQuestion, date: BusinessDate, result: GateResult): GateAnswer {
  return {
    allowed: result.allowed,
    outcome: result.outcome,
    route: result.route,
    date,
    styleId: question.styleId,
    colourwayId: question.colourwayId,
    size: question.size ?? null,
    measurementProfileId: question.measurementProfileId ?? null,
    certificate: result.outcome === 'covered' ? result.certificate : null,
    coverageId: result.outcome === 'covered' ? result.coverageId : null,
    message: result.outcome === 'not_required' ? result.message : null,
    reasons: result.outcome === 'refused' ? [...result.reasons] : [],
  }
}

/** The gate's answer with this client, for a module's own command (it checks its own permission first). */
export async function certificateGateFor(client: Reader, question: GateQuestion, date: BusinessDate): Promise<GateAnswer> {
  const { request } = await gateRequestFor(client, question, date)
  return answerOf(question, date, certificateGate(request))
}

/** POST /compliance/certificates/gate: compliance.certificates.view over the style's company. */
export async function checkGate(caller: CommandCaller, question: GateQuestion & { readonly date?: BusinessDate | undefined }): Promise<GateAnswer> {
  const context = officeOf(caller)
  const date = question.date ?? todayOf()
  return caller.withClient(async (client) => {
    const { request, companyId } = await gateRequestFor(client, question, date)
    if (!can(actorOf(context), CERTIFICATES_VIEW, { companyId })) throw new ForbiddenError()
    return answerOf(question, date, certificateGate(request))
  })
}
