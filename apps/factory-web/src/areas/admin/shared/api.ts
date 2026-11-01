import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * The Admin pages' calls (B-W0-27), one place: the tenancy core (`/org/*`, platform/admin/org), the people and roles
 * (`/auth/users`, `/auth/invitations`, `/auth/roles`, platform/auth), the floor (`/auth/floor/*`: devices, workers,
 * badges, PINs, a site's floor times) and the printers (`/print/*`), plus the reads the set-up checklist makes (mail
 * identities, number series, privacy duties, imports). Each answer is checked against its shape (an answer that does
 * not match is a `contract` error, never half-read). Only containers call these; views draw what they map.
 *
 * Mirrors apps/factory-api contracts (named per block); the web never imports the API's source.
 */

// ---- shared shapes ---------------------------------------------------------------------------------------------------

export const GRAINS = ['price', 'cost', 'margin', 'wages', 'pay'] as const
export type Grain = (typeof GRAINS)[number]
export const MASTER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type MasterStatus = (typeof MASTER_STATUSES)[number]

const address = z.object({
  line1: z.string(),
  line2: z.string().nullable().optional(),
  postalCode: z.string(),
  city: z.string(),
  province: z.string().nullable().optional(),
  country: z.string(),
})
export type Address = z.infer<typeof address>

// ---- platform/admin/org/contract.ts ----------------------------------------------------------------------------------

export const SITE_KINDS = ['PLANT', 'WAREHOUSE', 'OFFICE'] as const
export type SiteKind = (typeof SITE_KINDS)[number]
export const WORK_CENTRE_KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING', 'SUBCONTRACT'] as const
export type WorkCentreKind = (typeof WORK_CENTRE_KINDS)[number]
/** The org codes: 1 to 20 capital letters, digits or hyphens (contract ORG_CODE). */
export const ORG_CODE = /^[A-Z0-9][A-Z0-9-]{0,19}$/

const masterStatus = z.enum(MASTER_STATUSES)
export const companySchema = z.object({
  id: z.string(),
  code: z.string(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  vatNumber: z.string().nullable(),
  fiscalCode: z.string().nullable(),
  regimeFiscale: z.string().nullable(),
  reaOffice: z.string().nullable(),
  reaNumber: z.string().nullable(),
  shareCapital: z.string().nullable(),
  soleShareholder: z.boolean(),
  inLiquidation: z.boolean(),
  address: address.nullable(),
  pec: z.string().nullable(),
  sdiReceiverCode: z.string().nullable(),
  country: z.string(),
  currency: z.string(),
  timezone: z.string(),
  locale: z.string(),
  fiscalYearStartMonth: z.number(),
  documentFooter: z.string().nullable(),
  status: masterStatus,
  invoicing: z.object({ ready: z.boolean(), issues: z.array(z.object({ path: z.string(), message: z.string() })) }),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Company = z.infer<typeof companySchema>

const counts = z.object({ lines: z.number(), stations: z.number(), workCentres: z.number(), devices: z.number(), printers: z.number() })
export const siteSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(SITE_KINDS),
  address: address.nullable(),
  timezone: z.string(),
  status: masterStatus,
  counts,
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Site = z.infer<typeof siteSchema>
export const lineSchema = z.object({ id: z.string(), siteId: z.string(), code: z.string(), name: z.string(), status: masterStatus, version: z.number() })
export const workCentreSchema = z.object({ id: z.string(), siteId: z.string(), code: z.string(), name: z.string(), kind: z.enum(WORK_CENTRE_KINDS), status: masterStatus, version: z.number() })
export const stationSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  lineId: z.string().nullable(),
  workCentreId: z.string(),
  code: z.string(),
  name: z.string(),
  status: masterStatus,
  devices: z.number(),
  version: z.number(),
})
export type Line = z.infer<typeof lineSchema>
export type WorkCentre = z.infer<typeof workCentreSchema>
export type Station = z.infer<typeof stationSchema>
export type CompanyWithSites = Company & { sites: Site[] }

const companiesAnswer = z.object({ companies: z.array(companySchema.extend({ sites: z.array(siteSchema) })) })
const companyAnswer = z.object({ company: companySchema, sites: z.array(siteSchema) })
const oneCompany = z.object({ company: companySchema })
const siteAnswer = z.object({
  site: siteSchema,
  company: z.object({ id: z.string(), code: z.string(), legalName: z.string() }),
  lines: z.array(lineSchema),
  workCentres: z.array(workCentreSchema),
  stations: z.array(stationSchema),
})
export type SiteStructure = z.infer<typeof siteAnswer>
const oneSite = z.object({ site: siteSchema })

export const listCompanies = (api: ApiClient, includeArchived = false) =>
  api.get('/org/companies', { query: { includeArchived: includeArchived || undefined }, schema: companiesAnswer }).then((answer) => answer.companies)
export const getCompany = (api: ApiClient, companyId: string) => api.get(`/org/companies/${encodeURIComponent(companyId)}`, { schema: companyAnswer })
export const createCompany = (api: ApiClient, body: { code: string; legalName: string; vatNumber?: string | null; country?: string }) =>
  api.post('/org/companies', { body, schema: oneCompany, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.company)
export const editCompany = (api: ApiClient, companyId: string, body: Record<string, unknown> & { version: number }) =>
  api.request('PATCH', `/org/companies/${encodeURIComponent(companyId)}`, { body, schema: oneCompany }).then((answer) => answer.company)
export const getSite = (api: ApiClient, siteId: string) => api.get(`/org/sites/${encodeURIComponent(siteId)}`, { schema: siteAnswer })
export const createSite = (api: ApiClient, body: { companyId: string; code: string; name: string; kind: SiteKind; timezone?: string; address?: Address | null }) =>
  api.post('/org/sites', { body, schema: oneSite, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.site)
export const editSite = (api: ApiClient, siteId: string, body: Record<string, unknown> & { version: number }) =>
  api.request('PATCH', `/org/sites/${encodeURIComponent(siteId)}`, { body, schema: oneSite }).then((answer) => answer.site)
export const createLine = (api: ApiClient, siteId: string, body: { code: string; name: string }) =>
  api.post(`/org/sites/${encodeURIComponent(siteId)}/lines`, { body, schema: z.object({ line: lineSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.line)
export const editLine = (api: ApiClient, lineId: string, body: { version: number; name?: string; status?: MasterStatus }) =>
  api.request('PATCH', `/org/lines/${encodeURIComponent(lineId)}`, { body, schema: z.object({ line: lineSchema }) }).then((answer) => answer.line)
export const createWorkCentre = (api: ApiClient, siteId: string, body: { code: string; name: string; kind: WorkCentreKind }) =>
  api
    .post(`/org/sites/${encodeURIComponent(siteId)}/work-centres`, { body, schema: z.object({ workCentre: workCentreSchema }), idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.workCentre)
export const editWorkCentre = (api: ApiClient, workCentreId: string, body: { version: number; name?: string; status?: MasterStatus }) =>
  api.request('PATCH', `/org/work-centres/${encodeURIComponent(workCentreId)}`, { body, schema: z.object({ workCentre: workCentreSchema }) }).then((answer) => answer.workCentre)
export const createStation = (api: ApiClient, siteId: string, body: { code: string; name: string; workCentreId: string; lineId?: string | null }) =>
  api.post(`/org/sites/${encodeURIComponent(siteId)}/stations`, { body, schema: z.object({ station: stationSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.station)
export const editStation = (api: ApiClient, stationId: string, body: { version: number; name?: string; lineId?: string | null; status?: MasterStatus }) =>
  api.request('PATCH', `/org/stations/${encodeURIComponent(stationId)}`, { body, schema: z.object({ station: stationSchema }) }).then((answer) => answer.station)

// ---- platform/auth/users, invitations, roles -------------------------------------------------------------------------

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const
export type UserStatus = (typeof USER_STATUSES)[number]
const userRole = z.object({
  assignmentId: z.string(),
  roleId: z.string(),
  roleKey: z.string(),
  roleName: z.string(),
  allCompanies: z.boolean(),
  companyIds: z.array(z.string()),
  siteIds: z.array(z.string()),
  partyIds: z.array(z.string()),
  validTo: z.string().nullable(),
})
export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  locale: z.string(),
  status: z.enum(USER_STATUSES),
  roles: z.array(userRole),
  mfaEnabled: z.boolean(),
  lastSignInAt: z.string().nullable(),
  invitationExpiresAt: z.string().nullable(),
  version: z.number(),
})
export type User = z.infer<typeof userSchema>
export type UserRole = z.infer<typeof userRole>

export const listUsers = (api: ApiClient) => api.get('/auth/users', { schema: z.object({ users: z.array(userSchema) }) }).then((answer) => answer.users)
const userChanged = z.object({ id: z.string(), status: z.enum(USER_STATUSES), version: z.number(), sessionsEnded: z.number() })
export type UserAction = 'suspend' | 'reactivate' | 'deactivate' | 'require-password-reset'
export const changeUser = (api: ApiClient, userId: string, action: UserAction, body: { version: number; reason?: string }) =>
  api.post(`/auth/users/${encodeURIComponent(userId)}/${action}`, { body, schema: userChanged })

export interface AssignmentInput {
  roleId: string
  allCompanies: boolean
  companyIds: string[]
  siteIds: string[]
  validFrom?: string
  validTo?: string
}
export const invite = (api: ApiClient, body: { email: string; displayName: string; locale?: string; roles: AssignmentInput[] }, idempotencyKey: string) =>
  api.post('/auth/invitations', {
    body,
    idempotencyKey,
    schema: z.object({ invitation: z.object({ id: z.string(), userId: z.string(), email: z.string(), expiresAt: z.string() }), delivery: z.enum(['sent', 'already_sent']) }),
  })
export const revokeInvitation = (api: ApiClient, invitationId: string) => api.post(`/auth/invitations/${encodeURIComponent(invitationId)}/revoke`, { body: {} })

export const ROLE_AUDIENCES = ['office', 'floor'] as const
export type RoleAudience = (typeof ROLE_AUDIENCES)[number]
export const PERMISSION_RISKS = ['read', 'write', 'stepUp'] as const
export type PermissionRisk = (typeof PERMISSION_RISKS)[number]
const grain = z.enum(GRAINS)
export const roleSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  requireMfa: z.boolean(),
  /** B-W2b-24: since when the role asks for two-factor (UTC); null while it does not, or when it asked before the date was kept. */
  requireMfaSince: z.string().nullable().default(null),
  permissions: z.array(z.string()),
  grains: z.array(grain),
  system: z.boolean(),
  basedOn: z.string().nullable(),
  audience: z.enum(ROLE_AUDIENCES),
  version: z.number(),
  holders: z.number(),
  outdated: z.boolean(),
  templateAdds: z.object({ permissionsAdded: z.array(z.string()), grainsAdded: z.array(grain) }),
})
export type Role = z.infer<typeof roleSchema>
const catalogueSchema = z.object({
  templates: z.array(z.object({ key: z.string(), name: z.string(), description: z.string().nullable(), audience: z.enum(ROLE_AUDIENCES), permissions: z.array(z.string()), grains: z.array(grain) })),
  permissions: z.array(z.object({ name: z.string(), area: z.string(), description: z.string(), risk: z.enum(PERMISSION_RISKS) })),
  grains: z.array(z.object({ grain, description: z.string() })),
})
export type PermissionCatalogue = z.infer<typeof catalogueSchema>
export const assignmentSchema = z.object({
  id: z.string(),
  userId: z.string(),
  roleId: z.string(),
  roleKey: z.string(),
  roleName: z.string(),
  allCompanies: z.boolean(),
  companyIds: z.array(z.string()),
  siteIds: z.array(z.string()),
  partyIds: z.array(z.string()),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  endedAt: z.string().nullable(),
  live: z.boolean(),
  version: z.number(),
})
export type Assignment = z.infer<typeof assignmentSchema>

export const listRoles = (api: ApiClient) => api.get('/auth/roles', { schema: z.object({ roles: z.array(roleSchema) }) }).then((answer) => answer.roles)
export const roleCatalogue = (api: ApiClient) => api.get('/auth/roles/templates', { schema: catalogueSchema })
export const listAssignments = (api: ApiClient, userId: string) =>
  api.get(`/auth/users/${encodeURIComponent(userId)}/roles`, { schema: z.object({ assignments: z.array(assignmentSchema) }) }).then((answer) => answer.assignments)
export const giveRole = (api: ApiClient, userId: string, body: AssignmentInput & { reason?: string }) =>
  api.post(`/auth/users/${encodeURIComponent(userId)}/roles`, { body, schema: assignmentSchema })
export const endAssignment = (api: ApiClient, assignmentId: string, body: { version: number; reason?: string }) =>
  api.post(`/auth/role-assignments/${encodeURIComponent(assignmentId)}/end`, { body, schema: assignmentSchema })

// ---- platform/auth/floor -------------------------------------------------------------------------------------------

export const DEVICE_KINDS = ['TABLET', 'HANDHELD', 'PC'] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]
export const DEVICE_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const
export type DeviceStatus = (typeof DEVICE_STATUSES)[number]
/** B-W2b-24: the network a tablet says it uses (navigator.connection), as the API keeps it (Device.network). */
export const DEVICE_NETWORKS = ['WIFI', 'ETHERNET', 'CELLULAR', 'OTHER'] as const
export type DeviceNetwork = (typeof DEVICE_NETWORKS)[number]
export const deviceSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  stationId: z.string().nullable(),
  name: z.string(),
  kind: z.enum(DEVICE_KINDS),
  status: z.enum(DEVICE_STATUSES),
  enrolledAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  appVersion: z.string().nullable(),
  // B-W2a-42: what the tablet last said of itself (battery, charging, actions waiting to sync, when).
  batteryPercent: z.number().nullable().optional(),
  batteryCharging: z.boolean().nullable().optional(),
  queuedActions: z.number().nullable().optional(),
  statusReportedAt: z.string().nullable().optional(),
  // B-W2b-24: the network it last said (null: the browser does not say) and since when someone is signed in on it (never who).
  network: z.enum(DEVICE_NETWORKS).nullable().optional(),
  inUseSince: z.string().nullable().optional(),
  revokedAt: z.string().nullable(),
  inUse: z.boolean(),
  version: z.number(),
})
export type Device = z.infer<typeof deviceSchema>
const enrolmentSchema = z.object({ code: z.string(), url: z.string(), qrSvg: z.string(), expiresAt: z.string() })
export type Enrolment = z.infer<typeof enrolmentSchema>
const deviceWithCode = z.object({ device: deviceSchema, enrolment: enrolmentSchema.nullable() })

export const listDevices = (api: ApiClient, siteId?: string) =>
  api.get('/auth/floor/devices', { query: { siteId }, schema: z.object({ devices: z.array(deviceSchema) }) }).then((answer) => answer.devices)
export const createDevice = (api: ApiClient, body: { siteId: string; stationId?: string; name: string; kind?: DeviceKind }, idempotencyKey: string) =>
  api.post('/auth/floor/devices', { body, schema: deviceWithCode, idempotencyKey })
export const renewEnrolment = (api: ApiClient, deviceId: string, idempotencyKey: string) =>
  api.post(`/auth/floor/devices/${encodeURIComponent(deviceId)}/enrolment`, { body: {}, schema: deviceWithCode, idempotencyKey })
export const editDevice = (api: ApiClient, deviceId: string, body: { version: number; name?: string; stationId?: string | null }) =>
  api.request('PATCH', `/auth/floor/devices/${encodeURIComponent(deviceId)}`, { body, schema: deviceSchema })
export const revokeDevice = (api: ApiClient, deviceId: string, body: { version?: number; reason?: string }) =>
  api.post(`/auth/floor/devices/${encodeURIComponent(deviceId)}/revoke`, { body, schema: deviceSchema })

/** platform/auth/floor settingsView; `badgeOnlySignIn` (#888, Owner answer F1): a badge alone starts work at the site. */
const floorSettings = z.object({ siteId: z.string(), idleMinutes: z.number(), shiftEnds: z.array(z.string()), badgeOnlySignIn: z.boolean(), timeZone: z.string(), version: z.number().nullable() })
export type FloorSettings = z.infer<typeof floorSettings>
export const getFloorSettings = (api: ApiClient, siteId: string) => api.get(`/auth/floor/sites/${encodeURIComponent(siteId)}/settings`, { schema: floorSettings })
export const putFloorSettings = (api: ApiClient, siteId: string, body: { idleMinutes: number; shiftEnds: string[]; badgeOnlySignIn?: boolean; version?: number }) =>
  api.request('PUT', `/auth/floor/sites/${encodeURIComponent(siteId)}/settings`, { body, schema: floorSettings })

export const WORKER_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type WorkerStatus = (typeof WORKER_STATUSES)[number]
export const workerSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  displayName: z.string(),
  locale: z.string(),
  employeeCode: z.string().nullable(),
  userId: z.string().nullable(),
  status: z.enum(WORKER_STATUSES),
  hasPin: z.boolean(),
  pinMustChange: z.boolean(),
  locked: z.boolean(),
  badge: z.object({ id: z.string(), hint: z.string(), issuedAt: z.string() }).nullable(),
  roles: z.array(z.object({ workerRoleId: z.string(), roleId: z.string(), key: z.string(), name: z.string() })),
  version: z.number(),
})
export type Worker = z.infer<typeof workerSchema>

export const listWorkers = (api: ApiClient, siteId?: string) =>
  api.get('/auth/floor/workers', { query: { siteId }, schema: z.object({ workers: z.array(workerSchema) }) }).then((answer) => answer.workers)
export const createWorker = (api: ApiClient, body: { siteId: string; displayName: string; locale?: string; employeeCode?: string; roleIds?: string[] }, idempotencyKey: string) =>
  api.post('/auth/floor/workers', { body, schema: workerSchema, idempotencyKey })
export const editWorker = (api: ApiClient, workerId: string, body: { version: number; displayName?: string; locale?: string; employeeCode?: string | null }) =>
  api.request('PATCH', `/auth/floor/workers/${encodeURIComponent(workerId)}`, { body, schema: workerSchema })
export const setWorkerStatus = (api: ApiClient, workerId: string, action: 'deactivate' | 'reactivate', body: { version?: number; reason?: string }) =>
  api.post(`/auth/floor/workers/${encodeURIComponent(workerId)}/${action}`, { body, schema: workerSchema })
export const setWorkerRoles = (api: ApiClient, workerId: string, roleIds: string[]) =>
  api.request('PUT', `/auth/floor/workers/${encodeURIComponent(workerId)}/roles`, { body: { roleIds }, schema: workerSchema })
export const issueBadge = (api: ApiClient, workerId: string, idempotencyKey: string) =>
  api.post(`/auth/floor/workers/${encodeURIComponent(workerId)}/badges`, {
    body: {},
    idempotencyKey,
    schema: z.object({ badge: z.object({ id: z.string(), hint: z.string(), issuedAt: z.string() }), code: z.string().nullable(), printed: z.string().nullable() }),
  })
export const revokeBadge = (api: ApiClient, badgeId: string, status: 'LOST' | 'REVOKED') =>
  api.post(`/auth/floor/badges/${encodeURIComponent(badgeId)}/revoke`, { body: { status }, schema: z.object({ id: z.string(), status: z.string() }) })
export const resetPin = (api: ApiClient, workerId: string, idempotencyKey: string) =>
  api.post(`/auth/floor/workers/${encodeURIComponent(workerId)}/pin-reset`, { body: {}, idempotencyKey, schema: z.object({ pin: z.string().nullable(), pinMustChange: z.literal(true) }) })

// ---- platform/print ----------------------------------------------------------------------------------------------

export const PRINTER_KINDS = ['LABEL_ZPL', 'A4_PDF'] as const
export type PrinterKind = (typeof PRINTER_KINDS)[number]
export const PRINTER_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const
export type PrinterStatus = (typeof PRINTER_STATUSES)[number]
/** adapters/print-relay/port.ts PRINT_RELAY_KINDS: only the fake relay until the Owner picks one. */
export const PRINT_RELAY_KINDS = ['FAKE'] as const
/** print/rules.ts PRINTER_CODE. */
export const PRINTER_CODE = /^[A-Z0-9][A-Z0-9-]{0,23}$/
export const printerSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(PRINTER_KINDS),
  relay: z.string(),
  relayTarget: z.string().optional(),
  dpi: z.number().nullable(),
  labelWidthMm: z.number().nullable(),
  labelHeightMm: z.number().nullable(),
  status: z.enum(PRINTER_STATUSES),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Printer = z.infer<typeof printerSchema>
const onePrinter = z.object({ printer: printerSchema })

export const listPrinters = (api: ApiClient, siteId?: string, includeArchived = false) =>
  api
    .get('/print/printers', { query: { siteId, includeArchived: includeArchived || undefined }, schema: z.object({ printers: z.array(printerSchema) }) })
    .then((answer) => answer.printers)
export interface PrinterInput {
  siteId: string
  code: string
  name: string
  kind: PrinterKind
  relay: string
  relayTarget: string
  dpi?: number | null
  labelWidthMm?: number | null
  labelHeightMm?: number | null
}
export const createPrinter = (api: ApiClient, body: PrinterInput) => api.post('/print/printers', { body, schema: onePrinter, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.printer)
export const updatePrinter = (api: ApiClient, printerId: string, body: Record<string, unknown> & { version: number }) =>
  api.request('PATCH', `/print/printers/${encodeURIComponent(printerId)}`, { body, schema: onePrinter }).then((answer) => answer.printer)
export const failedJobs = (api: ApiClient) =>
  api.get('/print/jobs', { query: { status: 'FAILED' }, schema: z.object({ jobs: z.array(z.object({ id: z.string(), printerId: z.string() })) }) }).then((answer) => answer.jobs)

// ---- the set-up checklist's other reads ------------------------------------------------------------------------------

/** platform/email-out identityView: only what the checklist reads. */
export const listIdentities = (api: ApiClient) =>
  api
    .get('/email/identities', { schema: z.object({ identities: z.array(z.object({ id: z.string(), companyId: z.string(), domain: z.string(), ready: z.boolean(), status: z.string() })) }) })
    .then((answer) => answer.identities)
/** platform/numbering seriesView: only what the checklist reads. */
export const listSeries = (api: ApiClient) =>
  api
    .get('/numbering/series', { schema: z.object({ series: z.array(z.object({ id: z.string(), companyId: z.string(), kind: z.string(), status: z.string() })) }) })
    .then((answer) => answer.series)
/** platform/privacy overviewContract: each company's duties in words. */
export const privacyOverview = (api: ApiClient) =>
  api
    .get('/privacy/overview', {
      schema: z.object({
        companies: z.array(z.object({ company: z.object({ id: z.string() }).passthrough(), duties: z.array(z.object({ key: z.string(), done: z.boolean(), words: z.string() })) })),
      }),
    })
    .then((answer) => answer.companies)
