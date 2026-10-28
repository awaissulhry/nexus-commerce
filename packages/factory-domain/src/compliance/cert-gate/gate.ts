import { Decimal } from 'decimal.js'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import type { CertificateStatus } from '../certificates/rules'
import { isExpiredOn } from '../certificates/rules'

/**
 * The certificate gate (QHS-051, PRD-284, PRD-288; Reg. (EU) 2016/425 art. 8 and Annex III (l)(m), Annex V; EN 17092):
 * may this garment be labelled, released and placed on the market? A PPE garment of category II or III needs a VALID
 * EU type-examination certificate, inside its validity on the day, with an active coverage of the garment's style that
 * includes its colourway and its size. A made-to-measure unit (one rider, no standard size) needs a coverage that
 * allows made-to-measure units, on a style that allows them, and the rider's body measures inside the body measures of
 * the covered sizes (the certified range of adaptation): every measurement point the covered sizes give a range for
 * (their `bodyMeasures` keys, the measurement point codes) must be measured and fall inside the range of at least one
 * covered size.
 *
 * Pure: the API loads the style, its active coverages with their certificates, the sizes' body measures and the
 * rider's measurements; the gate answers "covered by certificate X", "not required" (not PPE, or category I: no
 * notified body), or "refused" with every reason found, each in words for the person and with a stable code. Labels
 * (B-W1-19, 44), work orders (B-W1-38) and final release (B-W1-45) ask the same question through the API.
 */

/** Reg. 2016/425 Annex I: category I is self-certified (module A); categories II and III need a notified body. */
export const PPE_CATEGORIES = ['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III'] as const
export type PpeCategory = (typeof PPE_CATEGORIES)[number]
export const CERTIFIED_CATEGORIES: readonly PpeCategory[] = ['CATEGORY_II', 'CATEGORY_III']

export interface GateStyle {
  readonly id: string
  readonly code: string
  readonly ppeCategory: PpeCategory
  /** The style's size range (codes): a coverage without sizes covers all of them. */
  readonly sizes: readonly string[]
  /** Made-to-measure units may be made from it (Style.mtmAllowed). */
  readonly mtmAllowed: boolean
}

/** One active coverage of the style, with its certificate. */
export interface GateCover {
  readonly coverageId: string
  /** Empty: every colourway of the style. */
  readonly colourwayIds: readonly string[]
  /** Empty: the style's whole size range. */
  readonly sizes: readonly string[]
  readonly allowsMadeToMeasure: boolean
  readonly certificate: {
    readonly id: string
    readonly number: string
    readonly standard: string
    readonly ppeClass: string | null
    readonly notifiedBodyName: string
    readonly notifiedBodyNumber: string
    readonly validFrom: BusinessDate
    readonly validTo: BusinessDate
    readonly status: CertificateStatus
  }
}

/** One body measure range of a size: decimal strings and their unit ("cm"). */
export interface MeasureRange {
  readonly min: string
  readonly max: string
  readonly unit: string
}
/** A size's body measures by measurement point code (Size.bodyMeasures). */
export type BodyMeasures = Readonly<Record<string, MeasureRange>>
/** A rider's measurements by measurement point code (MeasurementProfile.measurements). */
export type Measurements = Readonly<Record<string, { readonly value: string; readonly unit: string }>>

interface GateBase {
  readonly style: GateStyle
  readonly colourwayId: string
  /** The business date the garment is labelled or released (Europe/Rome). */
  readonly date: BusinessDate
  /** The style's ACTIVE coverages, each with its certificate (any status: the gate says why one does not count). */
  readonly covers: readonly GateCover[]
}

/** A garment in a standard size. */
export interface SizeGateRequest extends GateBase {
  readonly size: string
}

/** A made-to-measure unit: the rider's measurements and the body measures of the style's sizes. */
export interface MadeToMeasureGateRequest extends GateBase {
  readonly madeToMeasure: {
    readonly measurements: Measurements
    /** The body measures of the style's sizes, by size code (null: the size gives none). */
    readonly sizeMeasures: Readonly<Record<string, BodyMeasures | null>>
  }
}

export type GateRequest = SizeGateRequest | MadeToMeasureGateRequest

export const GATE_REASON_CODES = [
  'no_certificate',
  'certificate_not_valid',
  'certificate_expired',
  'certificate_not_yet_valid',
  'colourway_not_covered',
  'size_not_covered',
  'style_not_made_to_measure',
  'made_to_measure_not_allowed',
  'body_measures_missing',
  'measurement_missing',
  'measurement_invalid',
  'measurement_outside',
] as const
export type GateReasonCode = (typeof GATE_REASON_CODES)[number]

export interface GateReason {
  readonly code: GateReasonCode
  /** For the person: what is missing or wrong, and where. */
  readonly message: string
  /** The certificate the reason is about (none for the style's own reasons). */
  readonly certificateId?: string
  /** The measurement point it is about (made-to-measure reasons). */
  readonly point?: string
}

export interface CoveringCertificate {
  readonly id: string
  readonly number: string
  readonly standard: string
  readonly ppeClass: string | null
  readonly notifiedBodyName: string
  readonly notifiedBodyNumber: string
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
}

export type GateRoute = 'SIZE' | 'MADE_TO_MEASURE'

export type GateResult =
  | { readonly allowed: true; readonly outcome: 'covered'; readonly route: GateRoute; readonly coverageId: string; readonly certificate: CoveringCertificate }
  | { readonly allowed: true; readonly outcome: 'not_required'; readonly route: GateRoute; readonly message: string }
  | { readonly allowed: false; readonly outcome: 'refused'; readonly route: GateRoute; readonly reasons: readonly GateReason[] }

const DECIMAL = /^\d{1,6}(?:\.\d{1,4})?$/
const sameUnit = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()
const isMadeToMeasure = (request: GateRequest): request is MadeToMeasureGateRequest => 'madeToMeasure' in request && request.madeToMeasure !== undefined

/** The made-to-measure reasons of one coverage: the rider's measures against the covered sizes' body measures. */
function measureReasons(cover: GateCover, coveredSizes: readonly string[], request: MadeToMeasureGateRequest): GateReason[] {
  const certificateId = cover.certificate.id
  const { measurements, sizeMeasures } = request.madeToMeasure
  // The ranges per point, over the covered sizes that give body measures.
  const ranges = new Map<string, { size: string; range: MeasureRange }[]>()
  for (const size of coveredSizes) {
    for (const [point, range] of Object.entries(sizeMeasures[size] ?? {})) ranges.set(point, [...(ranges.get(point) ?? []), { size, range }])
  }
  if (ranges.size === 0) {
    return [{ code: 'body_measures_missing', certificateId, message: `The covered sizes (${coveredSizes.join(', ') || 'none'}) give no body measures, so the certified range of certificate ${cover.certificate.number} is not known.` }]
  }
  const reasons: GateReason[] = []
  for (const point of [...ranges.keys()].sort()) {
    const measured = Object.hasOwn(measurements, point) ? measurements[point] : undefined
    if (!measured) {
      reasons.push({ code: 'measurement_missing', certificateId, point, message: `The rider's ${point} is not measured; the certified range is checked on it.` })
      continue
    }
    const usable = ranges.get(point)!.filter(({ range }) => DECIMAL.test(range.min) && DECIMAL.test(range.max) && sameUnit(range.unit, measured.unit))
    if (!DECIMAL.test(measured.value) || usable.length === 0) {
      reasons.push({ code: 'measurement_invalid', certificateId, point, message: `The rider's ${point} (${measured.value} ${measured.unit}) cannot be compared with the sizes' ${point} ranges (${ranges.get(point)![0]!.range.unit}).` })
      continue
    }
    const value = new Decimal(measured.value)
    const inside = usable.some(({ range }) => value.gte(range.min) && value.lte(range.max))
    if (!inside) {
      const lowest = Decimal.min(...usable.map(({ range }) => new Decimal(range.min)))
      const highest = Decimal.max(...usable.map(({ range }) => new Decimal(range.max)))
      reasons.push({
        code: 'measurement_outside',
        certificateId,
        point,
        message: `The rider's ${point} of ${measured.value} ${measured.unit} is outside the body measures of the covered sizes (${usable.map(({ size, range }) => `${size}: ${range.min}–${range.max}`).join(', ')}; ${lowest.toString()}–${highest.toString()} ${measured.unit} overall).`,
      })
    }
  }
  return reasons
}

/** Why one coverage does not cover the garment (empty: it covers it). */
function coverReasons(cover: GateCover, request: GateRequest): GateReason[] {
  const { certificate } = cover
  const certificateId = certificate.id
  const named = `Certificate ${certificate.number} (${certificate.standard}, notified body ${certificate.notifiedBodyNumber})`
  const reasons: GateReason[] = []
  if (certificate.status === 'EXPIRED' || (certificate.status === 'VALID' && isExpiredOn(certificate.validTo, request.date))) {
    reasons.push({ code: 'certificate_expired', certificateId, message: `${named} expired: its last valid day was ${certificate.validTo}.` })
  } else if (certificate.status !== 'VALID') {
    const why = { DRAFT: 'is a draft, not registered yet', SUSPENDED: 'is suspended by the notified body', WITHDRAWN: 'was withdrawn' }[certificate.status]
    reasons.push({ code: 'certificate_not_valid', certificateId, message: `${named} ${why}.` })
  } else if (request.date < certificate.validFrom) {
    reasons.push({ code: 'certificate_not_yet_valid', certificateId, message: `${named} is valid from ${certificate.validFrom}.` })
  }
  if (cover.colourwayIds.length > 0 && !cover.colourwayIds.includes(request.colourwayId)) {
    reasons.push({ code: 'colourway_not_covered', certificateId, message: `${named} does not cover this colourway of style ${request.style.code}.` })
  }
  const coveredSizes = cover.sizes.length > 0 ? cover.sizes : request.style.sizes
  if (isMadeToMeasure(request)) {
    if (!cover.allowsMadeToMeasure) {
      reasons.push({ code: 'made_to_measure_not_allowed', certificateId, message: `${named} does not cover made-to-measure units of style ${request.style.code}.` })
    } else {
      reasons.push(...measureReasons(cover, coveredSizes, request))
    }
  } else if (!coveredSizes.includes(request.size)) {
    reasons.push({ code: 'size_not_covered', certificateId, message: `${named} does not cover size ${request.size} of style ${request.style.code} (it covers ${coveredSizes.join(', ') || 'no size'}).` })
  }
  return reasons
}

/** The gate's answer for one garment (a standard size or a made-to-measure unit) on a business date. */
export function certificateGate(request: GateRequest): GateResult {
  if (!isBusinessDate(request.date)) throw new RangeError(`not a calendar day: ${String(request.date)}`)
  const route: GateRoute = isMadeToMeasure(request) ? 'MADE_TO_MEASURE' : 'SIZE'
  const { style } = request
  if (!CERTIFIED_CATEGORIES.includes(style.ppeCategory)) {
    const message =
      style.ppeCategory === 'NOT_PPE'
        ? `Style ${style.code} is not PPE: no certificate is needed.`
        : `Style ${style.code} is category I PPE: it is self-certified, no notified body certificate is needed (Reg. (EU) 2016/425 Annex I).`
    return { allowed: true, outcome: 'not_required', route, message }
  }

  const reasons: GateReason[] = []
  if (route === 'MADE_TO_MEASURE' && !style.mtmAllowed) {
    reasons.push({ code: 'style_not_made_to_measure', message: `Style ${style.code} is not made to measure.` })
  }
  if (request.covers.length === 0) {
    reasons.push({ code: 'no_certificate', message: `No certificate covers style ${style.code}: a category II or III PPE garment needs a valid EU type-examination certificate (Reg. (EU) 2016/425).` })
    return { allowed: false, outcome: 'refused', route, reasons }
  }
  const covering: GateCover[] = []
  for (const cover of request.covers) {
    const found = coverReasons(cover, request)
    if (found.length === 0) covering.push(cover)
    else reasons.push(...found)
  }
  if (covering.length === 0 || reasons.some((reason) => reason.code === 'style_not_made_to_measure')) {
    return { allowed: false, outcome: 'refused', route, reasons }
  }
  // Several certificates may cover it (an overlap at renewal): the one valid longest, then by number.
  const [chosen] = [...covering].sort((a, b) =>
    a.certificate.validTo !== b.certificate.validTo ? (a.certificate.validTo < b.certificate.validTo ? 1 : -1) : a.certificate.number.localeCompare(b.certificate.number),
  )
  const { id, number, standard, ppeClass, notifiedBodyName, notifiedBodyNumber, validFrom, validTo } = chosen!.certificate
  return { allowed: true, outcome: 'covered', route, coverageId: chosen!.coverageId, certificate: { id, number, standard, ppeClass, notifiedBodyName, notifiedBodyNumber, validFrom, validTo } }
}
