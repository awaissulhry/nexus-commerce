import { certificateKindOf, scopeCheck } from '@nexus/factory-domain/compliance/certificates-depth/bodies'
import { gloveMarking, LEVEL_VOCABULARY, levelFamilyOf } from '@nexus/factory-domain/compliance/certificates-depth/levels'
import { fiveYearCheck } from '@nexus/factory-domain/compliance/certificates-depth/validity'
import { uid } from '../../../../quality/_shared/fixtures'
import { failedRead, reading, ready } from '../../../../quality/_shared/model'
import type { Certificate } from '../../api'
import { byNumber, CERTIFICATES, PROTECTOR, TODAY } from '../../fixtures'
import type { CertificateSummary, Depth, NotifiedBody } from '../api'
import { BODIES, BODY_9991, SUPPLIERS } from '../bodies-demo/fixtures'
import { blankDepthDraft, type DepthModel } from '../model'

/**
 * Made-up data for the design cases of certificates in depth (B-W2b-255; SCR-050, SCR-051, SCR-291): the CERT-DEMO-…
 * register of SCR-050, the made-up notified bodies "Demo Test Lab" (0000), "Demo Certification Office" (9990), an
 * archived earlier entry and "Demo Glove Lab" (9991), made-up suppliers. No real body, number, company or person; the
 * NANDO addresses are example.org.
 */

const summary = (certificate: Certificate): CertificateSummary => ({
  id: certificate.id,
  number: certificate.number,
  standard: certificate.standard,
  kind: certificateKindOf(certificate.standard),
  ppeClass: certificate.ppeClass,
  status: certificate.status,
  validFrom: certificate.validFrom,
  validTo: certificate.validTo,
  companyId: certificate.companyId,
  holderPartyId: certificate.holderPartyId,
  notifiedBodyNumber: certificate.notifiedBodyNumber,
})

/** A certificate in depth as the API would answer it, from the register's made-up row. */
export function demoDepth(certificate: Certificate, over: Partial<Omit<Depth, 'certificate'>> & { directory?: NotifiedBody | null; levelValues?: Record<string, string> | null } = {}): Depth {
  const kind = certificateKindOf(certificate.standard)
  const directory = over.directory === undefined ? (BODIES.find((entry) => entry.status === 'ACTIVE' && entry.number === certificate.notifiedBodyNumber) ?? null) : over.directory
  const family = levelFamilyOf(certificate.standard)
  const { directory: _directory, levelValues, ...rest } = over
  const values = levelValues ?? null
  const others = CERTIFICATES.filter((entry) => entry.notifiedBodyNumber === certificate.notifiedBodyNumber && entry.id !== certificate.id).map(summary)
  return {
    certificate: { ...summary(certificate), version: certificate.version, notifiedBodyName: certificate.notifiedBodyName, registered: certificate.status !== 'DRAFT' },
    validity: fiveYearCheck(certificate.validFrom, certificate.validTo),
    body: {
      typed: { name: certificate.notifiedBodyName, number: certificate.notifiedBodyNumber },
      directory,
      matching: BODIES.filter((entry) => entry.status === 'ACTIVE' && entry.number === certificate.notifiedBodyNumber),
      scope: directory ? scopeCheck(directory.scopes, kind === 'OTHER' ? 'GARMENT' : kind) : null,
      others,
    },
    levels: {
      family,
      properties: family ? LEVEL_VOCABULARY[family].properties.map((property) => ({ key: property.key, values: [...property.values], required: property.required, zone: property.zone ?? false })) : [],
      values,
      marking: family === 'EN13594' ? gloveMarking(values) : null,
      problems: [],
    },
    ownBrand: { brandHeld: certificate.holderPartyId !== null, base: null, standing: null, outlivesBaseDays: 0, sameStandard: null, restingOnThis: [], candidates: [] },
    boughtIn: [],
    mayManage: true,
    today: TODAY,
    ...rest,
  } as Depth
}

const GARMENT = byNumber('CERT-DEMO-0001')
const PROTECTOR_CERT = byNumber('CERT-DEMO-0003')
const GLOVE = byNumber('CERT-DEMO-0006')
const OWN = byNumber('CERT-DEMO-0008')

/** CERT-DEMO-0001: the factory's garment certificate, body 0000 from the directory, CERT-DEMO-0008 resting on it. */
export const DEPTH_GARMENT = demoDepth(GARMENT, { ownBrand: { brandHeld: false, base: null, standing: null, outlivesBaseDays: 0, sameStandard: null, restingOnThis: [summary(OWN)], candidates: [] } })

/** CERT-DEMO-0001 before its body is picked: the typed 0000 matches the directory's. */
export const DEPTH_GARMENT_TYPED = demoDepth(GARMENT, { directory: null })

/** CERT-DEMO-0003: a protector under 9990 (not listed for clothing; listed for impact), zones and parts with suppliers. */
export const DEPTH_PROTECTOR = demoDepth(PROTECTOR_CERT, {
  levelValues: { shoulder: '2', elbow: '2', type: 'B' },
  boughtIn: [
    { coverageId: uid('5506', 31), version: 2, item: PROTECTOR, supplier: { id: SUPPLIERS[0]!.id, name: 'Demo Armour' }, supplierArticleCode: 'DA-SH-L2-B', note: 'Shoulder protectors of the touring jackets.' },
    { coverageId: uid('5506', 32), version: 1, item: { id: uid('5505', 2), code: 'DEMO-PROT-GOMITO', name: 'Demo elbow protector level 2' }, supplier: null, supplierArticleCode: null, note: null },
  ],
})

/** CERT-DEMO-0006: a glove certificate (expired) under 9990, level 1 KP. */
export const DEPTH_GLOVE = demoDepth(GLOVE, { levelValues: { level: '1', knuckle: 'KP' } })

/** A glove draft (made up, beside the register): body 9991 picked, no levels yet. */
export const GLOVE_DRAFT: Certificate = { ...GLOVE, id: uid('5502', 61), number: 'CERT-DEMO-0061', status: 'DRAFT', ppeClass: '2', validFrom: '2026-11-01', validTo: '2031-10-31', notifiedBodyName: 'Demo Glove Lab', notifiedBodyNumber: '9991', version: 1, daysToExpiry: 1826, nextStatuses: ['VALID', 'WITHDRAWN'], statusReason: null, statusChangedAt: null }
export const DEPTH_GLOVE_DRAFT = demoDepth(GLOVE_DRAFT, { directory: BODY_9991 })

const ownBrand = (state: 'HOLDS' | 'SUSPENDED'): Depth['ownBrand'] => ({
  brandHeld: true,
  base: { ...summary(GARMENT), status: state === 'HOLDS' ? 'VALID' : 'SUSPENDED' },
  standing: { state, number: GARMENT.number, validFrom: GARMENT.validFrom, validTo: GARMENT.validTo },
  outlivesBaseDays: 446,
  sameStandard: true,
  restingOnThis: [],
  candidates: [summary(GARMENT), summary(byNumber('CERT-DEMO-0002'))],
})

/** CERT-DEMO-0008: the brand's own certificate on CERT-DEMO-0001 (holds; outlives it by 446 days). */
export const DEPTH_OWN = demoDepth(OWN, { ownBrand: ownBrand('HOLDS') })
/** The same with the base suspended: the gate refuses what it covers. */
export const DEPTH_OWN_SUSPENDED = demoDepth(OWN, { ownBrand: ownBrand('SUSPENDED') })
/** A brand's draft with no base yet. */
export const DEPTH_OWN_NO_BASE = demoDepth({ ...OWN, status: 'DRAFT', version: 1 }, { ownBrand: { ...ownBrand('HOLDS'), base: null, standing: null, outlivesBaseDays: 0, sameStandard: null } })

export const depthModel = (depth: Depth | null, over: Partial<DepthModel> = {}): DepthModel => ({
  depth: depth ? ready(depth) : reading(),
  bodies: ready(BODIES.filter((entry) => entry.status === 'ACTIVE')),
  suppliers: ready(SUPPLIERS),
  dialog: null,
  draft: blankDepthDraft(),
  busy: false,
  problem: null,
  lines: [],
  ...over,
})

export const DEPTH_STATES = {
  loading: depthModel(null),
  error: depthModel(null, { depth: failedRead('problem.unavailable') }),
}
