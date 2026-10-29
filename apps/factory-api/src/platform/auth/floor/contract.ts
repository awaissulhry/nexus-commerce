import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { workerNoticeGateView } from '../../privacy/contract'

/**
 * Floor sign-in (plan A1 §3.10 "Floor"; features PLT-018, PLT-019, PLT-056, PLT-057, PLT-058, PLT-060, PLT-062,
 * PLT-226). A secret (an enrolment code, a badge code, a PIN) appears in an answer only once, to the administrator who
 * made it; nothing about a worker beyond what the work needs (GDPR art. 5(1)(c)), and no productivity figure.
 */

export const DEVICE_KINDS = ['TABLET', 'HANDHELD', 'PC'] as const
const DEVICE_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const
const WORKER_STATUSES = ['ACTIVE', 'INACTIVE'] as const
const BADGE_STATUSES = ['ACTIVE', 'LOST', 'REVOKED'] as const

const version = z.number().int().min(1)
const reason = z.string().trim().min(1).max(500)
const pin = z.string().max(12)
const locale = z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, 'Expected a language code such as it, en or ro.')
const named = output({ id: id(), code: z.string(), name: z.string() })
/** The work centre kinds of factory-db (WorkCentreKind): what the station does, so the tablet knows its mode. */
export const WORK_CENTRE_KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING', 'SUBCONTRACT'] as const
/** The device's station, with the kind of its work centre. */
const stationRef = output({ id: id(), code: z.string(), name: z.string(), workCentreKind: z.enum(WORK_CENTRE_KINDS) })
const workerRef = output({ id: id(), displayName: z.string(), locale: z.string() })
const sessionTimes = output({
  startedAt: instant(),
  idleExpiresAt: instant(),
  endsAt: instant(),
  /** The site's idle minutes: the tablet's idle overlay counts them (the server ends the session anyway). */
  idleMinutes: z.number().int(),
  /**
   * Until when signing acts and My day are open without asking the PIN again (POST /floor/step-up). Null: a session
   * started by a badge alone, or a PIN proved too long ago.
   */
  stepUpUntil: instant().nullable(),
})

// ---- the floor (an enrolled device) ----

export const deviceInfo = output({
  device: output({ id: id(), name: z.string(), kind: z.enum(DEVICE_KINDS), station: stationRef.nullable() }),
  site: named,
  /** The tenant's language: the screen's language while nobody is signed in (PLT-062). */
  defaultLocale: z.string(),
  /** The site's sign-in rule (Owner answer F1): a badge alone signs in, or the PIN pad follows the badge. */
  signIn: output({ badgeOnly: z.boolean() }),
  /** Someone is signed in on this device now. */
  operatorSignedIn: z.boolean(),
  /** The site's active workers who have a PIN: the names for a sign-in by name and PIN (PLT-058). */
  roster: z.array(workerRef),
})

export const enrolDeviceContract = defineContract({
  body: input({ code: z.string().max(200), appVersion: z.string().trim().min(1).max(40).optional() }),
  response: { 200: deviceInfo },
})

export const deviceContract = defineContract({ response: { 200: deviceInfo } })

/**
 * A badge code (scanned) or a worker id (picked by name), and the PIN. The PIN may be left out only with a badge, at
 * a site whose floor settings say a badge alone signs in (`badgeOnlySignIn`); a sign-in by name always needs it.
 */
const credentials = input({ badgeCode: z.string().max(64).optional(), workerId: id().optional(), pin: pin.optional() })
export type FloorCredentials = z.infer<typeof credentials>

export const signedIn = output({
  status: z.literal('signed_in'),
  worker: workerRef,
  session: sessionTimes,
  /** An administrator reset the PIN: the worker chooses their own (POST /floor/pin) before anything else works. */
  pinMustChange: z.boolean(),
  /** The worker notice (B-W1-36): open it after sign-in when due; hold the scan tiles while it blocks scans. */
  notice: workerNoticeGateView,
})

export const signInContract = defineContract({ body: credentials, response: { 200: signedIn } })
export const switchContract = defineContract({ body: credentials, response: { 200: signedIn } })
export const signOutContract = defineContract({ response: { 200: output({ status: z.literal('signed_out') }) } })

export const floorMeContract = defineContract({
  response: {
    200: output({
      worker: workerRef,
      device: output({ id: id(), name: z.string(), station: stationRef.nullable() }),
      site: named,
      /** The tenant tag of this factory's label codes (factory-domain numbering/scan-id): a label of another is refused. */
      scanTag: z.string(),
      session: sessionTimes,
      pinMustChange: z.boolean(),
      notice: workerNoticeGateView,
      permissions: z.array(z.string()),
    }),
  },
})

export const changePinContract = defineContract({
  body: input({ currentPin: pin, newPin: pin }),
  response: { 200: output({ status: z.literal('changed') }) },
})

/** The signed-in worker proves their PIN again: signing acts and My day open until `stepUpUntil`. */
export const floorStepUpContract = defineContract({
  body: input({ pin }),
  response: { 200: output({ stepUpUntil: instant() }) },
})

// ---- the Office: devices ----

export const deviceView = output({
  id: id(),
  siteId: id(),
  stationId: id().nullable(),
  name: z.string(),
  kind: z.enum(DEVICE_KINDS),
  status: z.enum(DEVICE_STATUSES),
  enrolledAt: instant().nullable(),
  lastSeenAt: instant().nullable(),
  appVersion: z.string().nullable(),
  revokedAt: instant().nullable(),
  /** Someone is signed in on it now (never who: the registry is not a presence board). */
  inUse: z.boolean(),
  version: z.number().int(),
})
export type DeviceView = z.infer<typeof deviceView>

/**
 * The one-time enrolment code, shown once as a QR code; the tablet trades it within `expiresAt`. Null when the answer
 * comes from an Idempotency-Key receipt (a repeat): the code was never stored, ask for a new one.
 */
const enrolmentView = output({ code: z.string(), url: z.string(), qrSvg: z.string(), expiresAt: instant() })

export const listDevicesContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ devices: z.array(deviceView) }) },
})

export const createDeviceContract = defineContract({
  body: input({ siteId: id(), stationId: id().optional(), name: z.string().trim().min(1).max(100), kind: z.enum(DEVICE_KINDS).optional() }),
  response: { 200: output({ device: deviceView, enrolment: enrolmentView.nullable() }) },
})

export const renewEnrolmentContract = defineContract({
  params: input({ deviceId: id() }),
  response: { 200: output({ device: deviceView, enrolment: enrolmentView.nullable() }) },
})

export const editDeviceContract = defineContract({
  params: input({ deviceId: id() }),
  body: input({ version, name: z.string().trim().min(1).max(100).optional(), stationId: id().nullable().optional() }),
  response: { 200: deviceView },
})

export const revokeDeviceContract = defineContract({
  params: input({ deviceId: id() }),
  body: input({ version: version.optional(), reason: reason.optional() }),
  response: { 200: deviceView },
})

const settingsView = output({
  siteId: id(),
  idleMinutes: z.number().int(),
  shiftEnds: z.array(z.string()),
  /** A badge alone signs a worker in (Owner answer F1 a); false (the default): badge and PIN. */
  badgeOnlySignIn: z.boolean(),
  timeZone: z.string(),
  /** Null while the site uses the defaults. */
  version: z.number().int().nullable(),
})

export const getSettingsContract = defineContract({ params: input({ siteId: id() }), response: { 200: settingsView } })

export const putSettingsContract = defineContract({
  params: input({ siteId: id() }),
  body: input({
    idleMinutes: z.number().int(),
    shiftEnds: z.array(z.string().max(5)).max(24),
    /** Left out: unchanged (false on a site's first row). */
    badgeOnlySignIn: z.boolean().optional(),
    version: version.optional(),
  }),
  response: { 200: settingsView },
})

// ---- the Office: workers, badges, PINs ----

const badgeRef = output({ id: id(), hint: z.string(), issuedAt: instant() })

export const workerView = output({
  id: id(),
  siteId: id(),
  displayName: z.string(),
  locale: z.string(),
  employeeCode: z.string().nullable(),
  userId: id().nullable(),
  status: z.enum(WORKER_STATUSES),
  hasPin: z.boolean(),
  pinMustChange: z.boolean(),
  /** Locked for a few minutes after wrong PINs. */
  locked: z.boolean(),
  badge: badgeRef.nullable(),
  roles: z.array(output({ workerRoleId: id(), roleId: id(), key: z.string(), name: z.string() })),
  version: z.number().int(),
})
export type WorkerView = z.infer<typeof workerView>

export const listWorkersContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ workers: z.array(workerView) }) },
})

export const createWorkerContract = defineContract({
  body: input({
    siteId: id(),
    displayName: z.string().trim().min(1).max(100),
    locale: locale.optional(),
    employeeCode: z.string().trim().min(1).max(32).optional(),
    userId: id().optional(),
    roleIds: z.array(id()).max(10).optional(),
  }),
  response: { 200: workerView },
})

export const editWorkerContract = defineContract({
  params: input({ workerId: id() }),
  body: input({
    version,
    displayName: z.string().trim().min(1).max(100).optional(),
    locale: locale.optional(),
    employeeCode: z.string().trim().min(1).max(32).nullable().optional(),
    userId: id().nullable().optional(),
  }),
  response: { 200: workerView },
})

export const workerStatusContract = defineContract({
  params: input({ workerId: id() }),
  body: input({ version: version.optional(), reason: reason.optional() }),
  response: { 200: workerView },
})

export const setWorkerRolesContract = defineContract({
  params: input({ workerId: id() }),
  body: input({ roleIds: z.array(id()).max(10) }),
  response: { 200: workerView },
})

export const issueBadgeContract = defineContract({
  params: input({ workerId: id() }),
  response: {
    200: output({
      badge: badgeRef,
      /** The badge code, once: printed as a QR code or barcode (never stored, never shown again; null on a repeat). */
      code: z.string().nullable(),
      /** The code grouped for printing under the barcode. */
      printed: z.string().nullable(),
    }),
  },
})

export const revokeBadgeContract = defineContract({
  params: input({ badgeId: id() }),
  body: input({ status: z.enum(['LOST', 'REVOKED']).optional() }),
  response: { 200: output({ id: id(), workerId: id(), status: z.enum(BADGE_STATUSES), revokedAt: instant().nullable() }) },
})

export const resetPinContract = defineContract({
  params: input({ workerId: id() }),
  response: {
    200: output({
      /** The new PIN, once, for the worker; they choose their own at their next sign-in (null on a repeat). */
      pin: z.string().nullable(),
      pinMustChange: z.literal(true),
    }),
  },
})

export type CreateDeviceBody = z.infer<typeof createDeviceContract.body>
export type EditDeviceBody = z.infer<typeof editDeviceContract.body>
export type RevokeDeviceBody = z.infer<typeof revokeDeviceContract.body>
export type PutSettingsBody = z.infer<typeof putSettingsContract.body>
export type CreateWorkerBody = z.infer<typeof createWorkerContract.body>
export type EditWorkerBody = z.infer<typeof editWorkerContract.body>
export type WorkerStatusBody = z.infer<typeof workerStatusContract.body>
export type RevokeBadgeBody = z.infer<typeof revokeBadgeContract.body>
