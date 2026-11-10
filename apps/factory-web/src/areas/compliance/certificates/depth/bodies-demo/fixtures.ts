import { scopeCheck } from '@nexus/factory-domain/compliance/certificates-depth/bodies'
import { at, uid } from '../../../../quality/_shared/fixtures'
import { ready } from '../../../../quality/_shared/model'
import type { NotifiedBody, SupplierOption } from '../api'
import { closedBodies, type BodiesModel } from '../model'

/**
 * Made-up notified bodies and suppliers for the design cases (B-W2b-255; SCR-050, SCR-051, SCR-291): "Demo Test Lab"
 * (0000), "Demo Certification Office" (9990), "Demo Glove Lab" (9991) and an archived earlier 0000 entry. No real body,
 * number, company or person; the NANDO addresses are example.org. Kept apart from demo/fixtures.ts (which reads the register's
 * made-up rows) so the register's own fixtures can use it without a circular import.
 */

const body = (n: number, over: Partial<NotifiedBody> & Pick<NotifiedBody, 'number' | 'name'>): NotifiedBody => {
  const scopes = over.scopes ?? []
  return {
    id: uid('5521', n),
    address: 'Via Demo 1\n00100 Roma (RM)',
    country: 'IT',
    nandoUrl: `https://example.org/nando/${over.number}`,
    contactEmail: null,
    contactPhone: null,
    note: null,
    status: 'ACTIVE',
    certificates: 0,
    linked: 0,
    version: 2,
    createdAt: at(2, 9),
    updatedAt: at(10, 11),
    ...over,
    scopes,
    clothing: scopeCheck(scopes, 'GARMENT'),
  }
}

export const BODY_0000 = body(1, {
  number: '0000',
  name: 'Demo Test Lab',
  scopes: ['Regulation (EU) 2016/425 – protective clothing (demo)', 'Regulation (EU) 2016/425 – protective gloves (demo)'],
  contactEmail: 'certification@example.org',
  contactPhone: '+39 000 0000000',
  certificates: 5,
  linked: 3,
})
export const BODY_9990 = body(2, { number: '9990', name: 'Demo Certification Office', address: 'Demoweg 2\n00000 Demostadt', country: 'DE', scopes: ['Regulation (EU) 2016/425 – equipment against mechanical impact (demo)'], certificates: 3, linked: 1 })
export const BODY_9991 = body(3, { number: '9991', name: 'Demo Glove Lab', address: 'Rue Démo 3\n00000 Démoville', country: 'FR', nandoUrl: null, scopes: [], certificates: 0 })
export const BODY_ARCHIVED = body(4, { number: '0000', name: 'Demo Test Lab (earlier entry)', status: 'ARCHIVED', nandoUrl: null, scopes: [], note: 'Typed twice; the active entry replaces it.' })
export const BODIES: NotifiedBody[] = [BODY_0000, BODY_9990, BODY_9991, BODY_ARCHIVED]

export const SUPPLIERS: SupplierOption[] = [
  { id: uid('5522', 1), code: 'DEMO-SUP-1', legalName: 'Protezioni Demo S.r.l.', tradeName: 'Demo Armour' },
  { id: uid('5522', 2), code: 'DEMO-SUP-2', legalName: 'Fornitore Demo Due S.p.A.', tradeName: null },
]

export const bodiesModel = (over: Partial<BodiesModel> = {}): BodiesModel => ({
  ...closedBodies(),
  open: true,
  directory: ready({ bodies: BODIES, mayManage: true, asOf: at(29, 9, 40) }),
  ...over,
})
