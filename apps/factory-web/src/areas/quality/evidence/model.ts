import type { CheckState } from '../_shared/parts'
import type { LiveState, Read } from '../_shared/model'
import type { Evidence, EvidenceKind } from './api'

/**
 * The evidence trail's chain (design compliance.techfiles#evidence-trail ev-chain): the links in order — style revision,
 * certificates, DoC and user information, label, materials, production, final inspection, release, shipment, PPE
 * register — each with its state (present / a gap / not needed yet / unknown) worked out from the API's facts, and the
 * verdict "everything required is present (n of m)" or "k gaps". Pure: no React, no API.
 */

export const LINKS = ['style', 'certificate', 'documents', 'label', 'materials', 'production', 'inspection', 'release', 'shipment', 'register'] as const
export type LinkId = (typeof LINKS)[number]

export interface ChainLink {
  readonly id: LinkId
  readonly state: CheckState
  /** The message key of the link's state sentence (namespace `quality`, `evidence.link.<id>.<word>`). */
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  /** Another word for the state (a later step: "Not yet"). */
  readonly word?: string
}

const link = (id: LinkId, state: CheckState, word: string, params?: Record<string, string | number>): ChainLink => ({ id, state, key: `evidence.link.${id}.${word}`, ...(params ? { params } : {}) })

/** Each link of the chain, in order, with its state. */
export function chainOf(evidence: Evidence): ChainLink[] {
  const links: ChainLink[] = []
  const revision = evidence.revision
  links.push(revision ? link('style', revision.status === 'RELEASED' || revision.status === 'OBSOLETE' ? 'OK' : 'OPEN', revision.status === 'DRAFT' ? 'draft' : 'released', { revision: revision.revision }) : link('style', 'UNKNOWN', 'none'))

  const certificates = evidence.releases.flatMap((release) => release.certificates)
  if (certificates.length === 0) links.push(link('certificate', 'UNKNOWN', 'notYet'))
  else {
    const notValid = certificates.filter((certificate) => certificate.statusNow !== 'VALID').length
    links.push(notValid === 0 ? link('certificate', 'OK', 'valid', { count: new Set(certificates.map((certificate) => certificate.id)).size }) : link('certificate', 'OPEN', 'notValid', { count: notValid }))
  }

  const issued = evidence.documents.filter((document) => document.status === 'ISSUED')
  const doc = issued.some((document) => document.kind === 'DECLARATION_OF_CONFORMITY')
  const leaflet = issued.some((document) => document.kind === 'USER_INFORMATION')
  links.push(doc && leaflet ? link('documents', 'OK', 'present', { count: issued.length }) : link('documents', 'OPEN', !doc && !leaflet ? 'missingBoth' : !doc ? 'missingDoc' : 'missingLeaflet'))

  const prints = evidence.labelPrints.reduce((sum, print) => sum + print.quantity, 0)
  links.push(
    !evidence.labelTemplate
      ? link('label', 'OPEN', 'noTemplate')
      : prints === 0
        ? link('label', 'OPEN', 'notPrinted', { code: evidence.labelTemplate.code, revision: evidence.labelTemplate.revision })
        : link('label', 'OK', 'printed', { code: evidence.labelTemplate.code, revision: evidence.labelTemplate.revision, count: prints }),
  )

  const lots = evidence.lots
  const lotsOnHold = lots.filter((lot) => lot.qualityStatus !== 'RELEASED' || lot.crVi.status === 'FAIL' || lot.crVi.status === 'PENDING').length
  links.push(lots.length === 0 ? link('materials', 'UNKNOWN', 'none') : lotsOnHold === 0 ? link('materials', 'OK', 'released', { count: lots.length }) : link('materials', 'OPEN', 'onHold', { count: lotsOnHold }))

  const good = evidence.scans.reduce((sum, scan) => sum + scan.good, 0)
  links.push(evidence.scans.length === 0 ? link('production', 'UNKNOWN', 'noScans', { workOrder: evidence.subject.workOrder.number }) : link('production', 'OK', 'made', { workOrder: evidence.subject.workOrder.number, count: good }))

  const passed = evidence.inspections.filter((inspection) => inspection.status === 'PASSED')
  links.push(passed.length > 0 ? link('inspection', 'OK', 'passed', { count: passed.length }) : evidence.inspections.length > 0 ? link('inspection', 'OPEN', 'notPassed') : link('inspection', 'OPEN', 'none'))

  const released = evidence.releases.reduce((sum, release) => sum + release.quantity, 0)
  const back = evidence.releases.reduce((sum, release) => sum + release.reversed, 0)
  links.push(released === 0 ? link('release', 'OPEN', 'none') : back > 0 ? link('release', 'OK', 'withReversals', { count: released, back }) : link('release', 'OK', 'released', { count: released }))

  const left = evidence.shipments.filter((shipment) => shipment.status === 'SHIPPED' || shipment.status === 'DELIVERED')
  links.push(left.length > 0 ? link('shipment', 'OK', 'shipped', { count: left.length }) : { ...link('shipment', 'NOT_NEEDED', 'notYet'), word: 'check.NOT_YET' })

  const open = evidence.registerEntries.filter((entry) => entry.status === 'OPEN').length
  links.push(evidence.registerEntries.length === 0 ? link('register', 'OK', 'none') : open > 0 ? link('register', 'OPEN', 'open', { count: open }) : link('register', 'OK', 'closed', { count: evidence.registerEntries.length }))
  return links
}

/** The verdict: how many required links are present, and how many are gaps (not needed and unknown are not gaps). */
export function verdictOf(chain: readonly ChainLink[]): { present: number; required: number; gaps: number; unknown: number } {
  const required = chain.filter((entry) => entry.state === 'OK' || entry.state === 'OPEN')
  return { present: required.filter((entry) => entry.state === 'OK').length, required: required.length, gaps: required.filter((entry) => entry.state === 'OPEN').length, unknown: chain.filter((entry) => entry.state === 'UNKNOWN').length }
}

/** Scans per operation (no person: the trail counts the work, never who did how much). */
export function scansByOperation(evidence: Pick<Evidence, 'scans'>): { key: string; seq: number | null; code: string; name: string; good: number; scrap: number; rework: number }[] {
  const by = new Map<string, { key: string; seq: number | null; code: string; name: string; good: number; scrap: number; rework: number }>()
  for (const scan of evidence.scans) {
    const key = scan.operation ? `${scan.operation.seq}:${scan.operation.code}` : 'none'
    const row = by.get(key) ?? { key, seq: scan.operation?.seq ?? null, code: scan.operation?.code ?? '—', name: scan.operation?.name ?? '—', good: 0, scrap: 0, rework: 0 }
    row.good += scan.good
    row.scrap += scan.scrap
    row.rework += scan.rework
    by.set(key, row)
  }
  return [...by.values()].sort((a, b) => (a.seq ?? 999) - (b.seq ?? 999))
}

export interface EvidenceModel {
  readonly prefix: string
  readonly kind: EvidenceKind | null
  readonly subject: string
  readonly can: { readonly view: boolean }
  readonly evidence: Read<Evidence>
  readonly asOf: string | null
  readonly live?: LiveState
}
