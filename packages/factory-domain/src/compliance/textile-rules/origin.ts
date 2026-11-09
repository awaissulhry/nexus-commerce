import type { Finding } from './composition'

/**
 * The origin claim check, "Made in Italy" (B-W2b-208; PRD-344; D.L. 135/2009 art. 16 converted by L. 166/2009; Reg. (EU)
 * 952/2013 art. 60(2) with Delegated Reg. (EU) 2015/2446 Annex 22-01; L. 350/2003 art. 4(49)): read from where each
 * step of the style revision's routing is done. Pure.
 *
 *   in-house   a step with no workshop is done at the company's own plants (Site kind PLANT, ACTIVE; or the one site
 *              asked): its country is theirs, when they all share one
 *   workshop   a subcontracted step (RoutingOperation.supplierId) is done where the workshop receives the pieces: its
 *              default delivery address, else the country it is established in
 *
 *   "Made in Italy"        allowed when every step that makes the garment up after cutting (sewing, assembly, finishing,
 *                          and a subcontracted step whose work is not said) is done in Italy: a garment made in more than
 *                          one country takes the origin of its complete making-up (non-preferential origin)
 *   "100% Made in Italy"   allowed only when every step is done in Italy (art. 16(1): designed, planned, made and packed
 *                          in Italy; design and planning are not in the records and are left to the person)
 *
 * The routing says what is planned; a batch made with another workshop is not read here. The check is a switch, OFF until
 * the Owner says whether any step is done outside Italy (OWNER-QUESTIONS Q22, Q23).
 */

export const ITALY = 'IT'

/** The kinds of work centre whose steps make the garment up after cutting (origin); inspection and packing do not. */
export const MAKE_UP_KINDS: ReadonlySet<string> = new Set(['SEWING', 'ASSEMBLY', 'FINISHING', 'SUBCONTRACT'])

export interface PlaceFacts {
  readonly code: string
  readonly name: string
  /** ISO 3166-1 alpha-2; null when not on record. */
  readonly country: string | null
}

export interface StepFacts {
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly workCentreKind: string
  /** The workshop of a subcontracted step; null: in-house. */
  readonly workshop: PlaceFacts | null
}

export type Verdict = 'ALLOWED' | 'NOT_ALLOWED' | 'UNKNOWN'

export interface StepPlace {
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly workCentreKind: string
  readonly makesUp: boolean
  readonly where: 'IN_HOUSE' | 'WORKSHOP'
  /** The plants or the workshop. */
  readonly places: readonly PlaceFacts[]
  /** The one country it is done in; null when not known or the plants are in several. */
  readonly country: string | null
}

export interface OriginCheck {
  readonly madeInItaly: Verdict
  readonly fullMadeInItaly: Verdict
  readonly steps: readonly StepPlace[]
  /** The style's customs country of origin (Style.originCountry). */
  readonly styleOrigin: string | null
  readonly findings: readonly Finding[]
}

const countryOfPlaces = (places: readonly PlaceFacts[]): string | null => {
  const countries = new Set(places.map((place) => place.country))
  if (countries.size !== 1) return null
  return [...countries][0] ?? null
}

const verdictOf = (steps: readonly StepPlace[]): Verdict => {
  if (steps.some((step) => step.country !== null && step.country !== ITALY)) return 'NOT_ALLOWED'
  if (steps.some((step) => step.country === null)) return 'UNKNOWN'
  return 'ALLOWED'
}

const placeWords = (step: StepPlace): string =>
  step.where === 'WORKSHOP' ? `workshop ${step.places[0]?.name ?? '?'}` : step.places.length === 1 ? `plant ${step.places[0]!.code}` : `our plants (${step.places.map((place) => place.code).join(', ')})`

/** The check over the steps (`plants`: where in-house steps are done). */
export function originCheck(steps: readonly StepFacts[], plants: readonly PlaceFacts[], styleOrigin: string | null): OriginCheck {
  const findings: Finding[] = []
  const placed: StepPlace[] = steps.map((step) => {
    const places = step.workshop ? [step.workshop] : plants
    return {
      seq: step.seq,
      code: step.code,
      name: step.name,
      workCentreKind: step.workCentreKind,
      makesUp: MAKE_UP_KINDS.has(step.workCentreKind),
      where: step.workshop ? 'WORKSHOP' : 'IN_HOUSE',
      places,
      country: places.length === 0 ? null : countryOfPlaces(places),
    }
  })
  if (plants.length === 0 && placed.some((step) => step.where === 'IN_HOUSE')) {
    findings.push({ path: 'plants', severity: 'WARN', message: 'No active plant of the company is on record: where the in-house steps are done is not known.' })
  }
  for (const step of placed) {
    if (step.country !== null) continue
    if (step.places.length > 1) findings.push({ path: `steps/${step.seq}`, severity: 'WARN', message: `Step ${step.seq} (${step.name}) is done at ${placeWords(step)}, which are in different countries: ask for one plant to read its country.` })
    else if (step.places.length === 1) findings.push({ path: `steps/${step.seq}`, severity: 'WARN', message: `Step ${step.seq} (${step.name}): the country of ${placeWords(step)} is not on record.` })
  }
  const makeUp = placed.filter((step) => step.makesUp)
  const madeInItaly: Verdict = makeUp.length === 0 ? 'UNKNOWN' : verdictOf(makeUp)
  if (makeUp.length === 0) findings.push({ path: 'steps', severity: 'WARN', message: 'The routing has no sewing, assembly or finishing step: the origin cannot be read from it.' })
  const fullMadeInItaly: Verdict = placed.length === 0 ? 'UNKNOWN' : verdictOf(placed)
  for (const step of placed) {
    if (step.country === null || step.country === ITALY) continue
    findings.push({
      path: `steps/${step.seq}`,
      severity: step.makesUp ? 'FAIL' : 'WARN',
      message: step.makesUp
        ? `Step ${step.seq} (${step.name}) makes the garment up in ${step.country} at ${placeWords(step)}: "Made in Italy" is not allowed.`
        : `Step ${step.seq} (${step.name}) is done in ${step.country} at ${placeWords(step)}: "100% Made in Italy" is not allowed (D.L. 135/2009 art. 16(1)).`,
    })
  }
  if (styleOrigin === ITALY && madeInItaly === 'NOT_ALLOWED') {
    findings.push({ path: 'style/originCountry', severity: 'FAIL', message: 'The style\'s country of origin says IT, but the garment is made up outside Italy: correct the origin or the routing (L. 350/2003 art. 4(49): a false origin is an offence).' })
  }
  if (styleOrigin !== null && styleOrigin !== ITALY && madeInItaly === 'ALLOWED') {
    findings.push({ path: 'style/originCountry', severity: 'WARN', message: `The style's country of origin says ${styleOrigin}, but every making-up step is done in Italy: check the origin.` })
  }
  // A failing step's FAIL stands only when the origin is claimed: without a claim it is what the check found.
  if (madeInItaly === 'NOT_ALLOWED' && styleOrigin !== ITALY) {
    for (let index = 0; index < findings.length; index += 1) if (findings[index]!.severity === 'FAIL') findings[index] = { ...findings[index]!, severity: 'WARN' }
  }
  return { madeInItaly, fullMadeInItaly, steps: placed, styleOrigin, findings }
}
