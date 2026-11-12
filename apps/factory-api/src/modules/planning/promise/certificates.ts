import { decide, type GateLine, type GateMarket, type GateTarget } from '@nexus/factory-domain/compliance/gates/gate'
import { checkOf } from '@nexus/factory-domain/compliance/requirements/rules'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { checkerFor, checksAsked, marketOfCountry, readGateStyle, readMarkets, styleLabelTemplateId } from '../../compliance/gates/facts'
import { gateRequirements } from '../../compliance/requirements/store'
// B-W2b-283 (FU1:01): the markets the style is sold in.
import { soldThereTargets, styleMarketCodes } from '../../product/markets/store'
import type { Reader } from '../store'

/**
 * Only certified sizes are promised (B-W2b-301; PLN-179; the requirements gate of B-W2b-254; design planning.promise ›
 * calc "Certificate check through the ship date"): the one gate's SHIPMENT question for the style, colourway × size for
 * the market the goods go to, on the day they would ship. A size whose certificate requirement (certificate.coverage,
 * certificate.gloveLevels) blocks shipment that day is not promised, in the gate's own words; another requirement that
 * would hold the shipment is said as a warning. Nothing is recorded (no GateEvent: a promise is a question, not a step),
 * no override counts (an override is per work order or shipment).
 */

export const CERTIFICATE_STATES = ['OK', 'EXPIRING', 'MISSING', 'NOT_NEEDED'] as const
export type CertificateState = (typeof CERTIFICATE_STATES)[number]

export interface SizeCertificate {
  readonly state: CertificateState
  readonly words: string
  /** The covering certificate and the day it ends (EN 17092 valid until …); null: none covers it. */
  readonly certificate: string | null
  readonly validTo: BusinessDate | null
  /** The requirement that refuses it (MISSING). */
  readonly requirementCode: string | null
  /** Another requirement would hold the shipment that day (not a certificate one), in the gate's words. */
  readonly heldAtShipment: string | null
}

export interface CertificateAsk {
  readonly key: string
  readonly colourwayId: string
  readonly colourwayCode: string
  readonly size: string
}

const isCertificate = (line: GateLine): boolean => line.check === 'certificate.coverage' || line.check === 'certificate.gloveLevels'
const refuses = (line: GateLine): boolean => line.blocks && line.state === 'MISSING'
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/** The market of a destination country (null: none named, or no market profile names it). */
export async function marketFor(db: Reader, country: string | null): Promise<{ market: GateMarket | null; destination: string | null }> {
  if (!country) return { market: null, destination: null }
  const markets = await readMarkets(db)
  const destination = country.trim().toUpperCase()
  return { market: marketOfCountry(destination, markets), destination }
}

/** Per asked colourway × size: the certificate answer on `day` (one gate question for all of them). */
export async function certificatesOn(
  db: Reader,
  input: { readonly styleId: string; readonly styleCode: string; readonly asks: readonly CertificateAsk[]; readonly market: GateMarket | null; readonly destination: string | null; readonly day: BusinessDate; readonly now: Date },
): Promise<Map<string, SizeCertificate>> {
  const out = new Map<string, SizeCertificate>()
  if (input.asks.length === 0) return out
  const style = await readGateStyle(db, input.styleId)
  if (!style) return out
  const requirements = await gateRequirements(db)
  const labelTemplateId = await styleLabelTemplateId(db, input.styleId)
  const asked: GateTarget[] = input.asks.map((ask) => ({ key: ask.key, label: `${ask.colourwayCode} ${ask.size}`, colourwayId: ask.colourwayId, colourwayCode: ask.colourwayCode, size: ask.size, destination: input.destination, market: input.market, sellsThere: false }))
  const targets = soldThereTargets(asked, await styleMarketCodes(db, input.styleId))
  const check = await checkerFor(db, {
    style,
    labelTemplateId,
    day: input.day,
    checks: checksAsked(requirements, checkOf),
    marketCodes: targets.flatMap((target) => (target.market ? [target.market.code] : [])),
    targets,
    subject: null,
    companyId: style.row.companyId,
  })
  const decision = decide({ gate: 'SHIPMENT', subjectWords: `A promise of ${input.styleCode}`, style: style.subject, targets, requirements, check, overrides: [], day: input.day, now: input.now })
  for (const target of targets) {
    const lines = decision.lines.filter((line) => line.target.key === target.key)
    const certificateLines = lines.filter(isCertificate)
    const refusal = decision.refusedTargets.find((entry) => entry.line.target.key === target.key) ?? null
    const missing = certificateLines.find(refuses)
    const covered = certificateLines.find((line) => line.check === 'certificate.coverage' && (line.state === 'OK' || line.state === 'EXPIRING'))
    const notNeeded = certificateLines.length === 0 || certificateLines.every((line) => line.state === 'NOT_NEEDED' || line.state === 'MANUAL')
    const held = refusal && !isCertificate(refusal.line) ? refusal.words : null
    if (missing) {
      const words = decision.refusedTargets.find((entry) => entry.line === missing)?.words ?? missing.message
      out.set(target.key, { state: 'MISSING', words, certificate: null, validTo: null, requirementCode: missing.requirement.code, heldAtShipment: null })
    } else if (covered) {
      out.set(target.key, {
        state: covered.state === 'EXPIRING' ? 'EXPIRING' : 'OK',
        words: covered.message,
        certificate: text(covered.facts.certificate),
        validTo: text(covered.facts.validTo),
        requirementCode: null,
        heldAtShipment: held,
      })
    } else {
      out.set(target.key, { state: notNeeded ? 'NOT_NEEDED' : 'OK', words: certificateLines[0]?.message ?? 'No certificate requirement applies to it.', certificate: null, validTo: null, requirementCode: null, heldAtShipment: held })
    }
  }
  return out
}
