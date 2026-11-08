import { PARTNER_ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { STEP_UP_CLOSED } from '../../../admin/shared/model'
import type { PartnerKind, PartnerPerson, PartnerRole, PortalAccess } from '../../../admin/users/partners/api'
import type { PartnerCan } from '../../../admin/users/partners/model'
import type { PortalAccessModel, RequestRow } from './model'

/**
 * Made-up partner portals for the design review (B-W2b-180): never a real customer, supplier, person or address. The roles
 * are factory-domain's own partner templates (as the API offers them), so the cards and words match the real ones.
 */

export const PREFIX = '/w/DEMO'
export const DEMO_NOW = '2026-10-29T09:42:00.000Z'
export const DEMO_TODAY = '2026-10-29'
const at = (day: number, hour: number, minute = 0, month = 9) => new Date(Date.UTC(2026, month, day, hour, minute)).toISOString()
const uid = (n: number) => `0190f0e2-a180-7000-8000-${String(n).padStart(12, '0')}`

export const ALL_RIGHTS: PartnerCan = { view: true, invite: true, manage: true, preview: true, requests: true }
export const READ_ONLY: PartnerCan = { view: true, invite: false, manage: false, preview: false, requests: false }

export function rolesOf(kinds: readonly PartnerKind[], allowed: readonly string[] = []): PartnerRole[] {
  return PARTNER_ROLE_TEMPLATES.filter((template) => template.kind !== null && kinds.includes(template.kind)).map((template) => ({
    key: template.key,
    kind: template.kind!,
    name: template.name,
    description: template.description,
    seesPrices: template.grains.includes('price'),
    admin: template.admin,
    capabilities: { allowed: [...template.capabilities.allowed], byDefault: [...template.capabilities.byDefault] },
    offered: allowed.length === 0 || allowed.includes(template.key),
  }))
}

const person = (n: number, over: Partial<PartnerPerson> & Pick<PartnerPerson, 'displayName' | 'email'>): PartnerPerson => ({
  id: uid(n),
  kind: 'CUSTOMER',
  status: 'ACTIVE',
  roleKey: 'customer-buyer',
  roleName: 'Buyer',
  seesPrices: true,
  admin: false,
  capabilities: ['comment', 'upload', 'approve'],
  accessUntil: null,
  accessEndsSoon: false,
  lastSignInAt: at(28, 15, 10),
  invitation: null,
  version: 3,
  ...over,
})

export const CUSTOMER_PEOPLE: PartnerPerson[] = [
  person(1, { displayName: 'Giulia Esempio', email: 'giulia.esempio@example.com', roleKey: 'customer-admin', roleName: 'Admin', admin: true, lastSignInAt: at(29, 8, 55) }),
  person(2, { displayName: 'Marco Prova', email: 'marco.prova@example.com' }),
  person(3, { displayName: 'Sara Demo', email: 'sara.demo@example.com', roleKey: 'customer-finance', roleName: 'Finance', capabilities: ['comment', 'upload'], accessUntil: at(3, 22, 59, 10), accessEndsSoon: true }),
  person(4, { displayName: 'Paolo Campione', email: 'paolo.campione@example.com', status: 'INVITED', roleKey: null, roleName: null, seesPrices: false, capabilities: [], lastSignInAt: null, invitation: { id: uid(40), expiresAt: at(4, 9, 0, 10) }, version: 1 }),
  person(5, { displayName: 'Elena Modello', email: 'elena.modello@example.com', status: 'SUSPENDED', roleKey: 'customer-quality', roleName: 'Quality', seesPrices: false, capabilities: ['comment'], lastSignInAt: at(12, 11, 0) }),
  person(6, { displayName: 'Luca Passato', email: 'luca.passato@example.com', status: 'DEACTIVATED', roleKey: 'customer-viewer', roleName: 'Viewer', seesPrices: false, capabilities: [], lastSignInAt: at(2, 9, 0) }),
]

export const SUPPLIER_PEOPLE: PartnerPerson[] = [
  person(11, { displayName: 'Anna Conceria', email: 'anna@conceria-demo.example', kind: 'SUPPLIER', roleKey: 'supplier-admin', roleName: 'Admin', admin: true, seesPrices: false, lastSignInAt: at(29, 7, 40) }),
  person(12, { displayName: 'Bruno Spedizioni', email: 'bruno@conceria-demo.example', kind: 'SUPPLIER', roleKey: 'supplier-orders', roleName: 'Orders', seesPrices: false }),
  person(13, { displayName: 'Carla Fatture', email: 'carla@conceria-demo.example', kind: 'SUPPLIER', status: 'INVITED', roleKey: null, roleName: null, seesPrices: false, capabilities: [], lastSignInAt: null, invitation: { id: uid(41), expiresAt: at(2, 9, 0, 10) }, version: 1 }),
]

export function customerAccess(over: Partial<PortalAccess> = {}): PortalAccess {
  return {
    party: { id: '0190f0e2-1000-7000-8000-000000000001', code: 'MODA-DEMO', name: 'Moda Demo', roles: ['CUSTOMER'], status: 'ACTIVE', companyId: '0190f0e2-0001-7000-8000-000000000001' },
    kinds: ['CUSTOMER'],
    settings: { portalOn: true, progressShared: false, maxUsers: 10, allowedRoleKeys: [], version: 4 },
    seats: { taken: 5, max: 10 },
    roles: rolesOf(['CUSTOMER']),
    people: CUSTOMER_PEOPLE,
    termsInForce: true,
    ...over,
  }
}

export function supplierAccess(over: Partial<PortalAccess> = {}): PortalAccess {
  return {
    party: { id: '0190f0e2-1000-7000-8000-000000000011', code: 'CONCERIA-DEMO', name: 'Conceria Demo', roles: ['SUPPLIER'], status: 'ACTIVE', companyId: '0190f0e2-0001-7000-8000-000000000001' },
    kinds: ['SUPPLIER'],
    settings: { portalOn: true, progressShared: false, maxUsers: null, allowedRoleKeys: [], version: 2 },
    seats: { taken: 3, max: null },
    roles: rolesOf(['SUPPLIER']),
    people: SUPPLIER_PEOPLE,
    termsInForce: true,
    ...over,
  }
}

export const REQUESTS: RequestRow[] = [
  {
    id: uid(60),
    kind: 'UPLOAD_DOCUMENT',
    verb: { it: 'Carica', en: 'Upload' },
    words: { it: 'Carica il documento richiesto per Moda Demo', en: 'Upload the document we asked for on Moda Demo' },
    record: { type: 'Party', id: '0190f0e2-1000-7000-8000-000000000001', label: 'Moda Demo' },
    companyId: '0190f0e2-0001-7000-8000-000000000001',
    dueAt: at(27, 22, 59),
    due: 'OVERDUE',
    askedBy: 'Chiara Ufficio',
    status: 'OPEN',
    closedAt: null,
    version: 1,
    createdAt: at(20, 10, 0),
    href: `${PREFIX}/sales/customers/0190f0e2-1000-7000-8000-000000000001`,
  },
  {
    id: uid(61),
    kind: 'ANSWER_MESSAGE',
    verb: { it: 'Rispondi', en: 'Answer' },
    words: { it: 'Rispondi al nostro messaggio su SO-2026-0042', en: 'Answer our message on SO-2026-0042' },
    record: { type: 'SalesOrder', id: uid(62), label: 'SO-2026-0042' },
    companyId: '0190f0e2-0001-7000-8000-000000000001',
    dueAt: at(5, 22, 59, 10),
    due: 'LATER',
    askedBy: null,
    status: 'OPEN',
    closedAt: null,
    version: 2,
    createdAt: at(28, 16, 0),
    href: `${PREFIX}/sales/orders/${uid(62)}`,
  },
]

export function portalModel(side: 'customers' | 'suppliers', over: Partial<PortalAccessModel> = {}): PortalAccessModel {
  const access = side === 'customers' ? customerAccess() : supplierAccess()
  return {
    side,
    prefix: PREFIX,
    partyName: access.party.name,
    access,
    problem: null,
    can: ALL_RIGHTS,
    today: DEMO_TODAY,
    now: DEMO_NOW,
    asOf: DEMO_NOW,
    live: 'live',
    signedIn: null,
    showLeft: false,
    selected: [],
    dialog: null,
    busy: false,
    dialogProblem: null,
    notice: null,
    stepUp: STEP_UP_CLOSED,
    requests: { items: side === 'customers' ? REQUESTS : [], problem: null, selected: [] },
    previewing: false,
    ...over,
  }
}
