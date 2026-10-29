import { z } from 'zod'
import type { ApiClient } from '../lib/api/client'
import { newIdempotencyKey } from '../lib/api/client'
import { isApiError, issuePath, type ApiError } from '../lib/api/errors'
import { WORK_CENTRE_KINDS } from './model'
import type { HideCard, LocationCard, WorkOrderCard } from './scan/scan-model'

/**
 * The floor app's calls (apps/factory-api platform/auth/floor, platform/privacy floor notice, and the lookups of Scan
 * anything), each answer checked against its shape and each refusal turned into what the screen does next. Every
 * unsafe call first makes sure the CSRF double-submit cookie exists (`GET /auth/csrf`). Secrets (the enrolment code,
 * a badge code, a PIN) go only in request bodies and never into an outcome.
 */

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const station = z.object({ id: z.string(), code: z.string(), name: z.string(), workCentreKind: z.enum(WORK_CENTRE_KINDS) })
const workerRef = z.object({ id: z.string(), displayName: z.string(), locale: z.string() })
const session = z.object({
  startedAt: z.string(),
  idleExpiresAt: z.string(),
  endsAt: z.string(),
  idleMinutes: z.number(),
  stepUpUntil: z.string().nullable(),
})
const noticeGate = z.object({ noticeId: z.string().nullable(), label: z.string().nullable(), acknowledged: z.boolean(), due: z.boolean(), blocksScans: z.boolean() })

export const deviceInfoSchema = z.object({
  device: z.object({ id: z.string(), name: z.string(), kind: z.string(), station: station.nullable() }),
  site: named,
  defaultLocale: z.string(),
  signIn: z.object({ badgeOnly: z.boolean() }),
  operatorSignedIn: z.boolean(),
  roster: z.array(workerRef),
})
export type DeviceInfo = z.infer<typeof deviceInfoSchema>

export const floorMeSchema = z.object({
  worker: workerRef,
  device: z.object({ id: z.string(), name: z.string(), station: station.nullable() }),
  site: named,
  scanTag: z.string(),
  session,
  pinMustChange: z.boolean(),
  notice: noticeGate,
  permissions: z.array(z.string()),
})
export type FloorMe = z.infer<typeof floorMeSchema>
export type NoticeGate = z.infer<typeof noticeGate>

const signedIn = z.object({ status: z.literal('signed_in'), worker: workerRef, session, pinMustChange: z.boolean(), notice: noticeGate })

const csrf = (api: ApiClient) => api.get('/auth/csrf')

/** A refusal in the screen's words. */
export type FloorProblem =
  /** The badge or PIN does not open this tablet (one answer for every reason: the API names none). */
  | 'wrong'
  /** A badge without a PIN where the site wants one, or a name without a PIN. */
  | 'pinNeeded'
  /** Another person is signed in on this tablet. */
  | 'operatorActive'
  /** The set-up code is not valid, was used or has expired (one answer). */
  | 'codeInvalid'
  /** This tablet is not set up, or the office revoked it. */
  | 'notEnrolled'
  | 'rateLimited'
  /** The new PIN breaks a rule. */
  | 'pinRefused'
  /** Too many wrong PINs: wait (a step-up while locked). */
  | 'locked'
  /** A newer notice version is in force. */
  | 'newerNotice'
  | 'unavailable'

export type Outcome<T> = { ok: true; value: T } | { ok: false; problem: FloorProblem; error?: ApiError }

/** What a call's 401, 409 and 400 mean for it (the rest is the same for every call). */
interface Meanings {
  readonly signedOut?: FloorProblem
  readonly conflict?: FloorProblem
  readonly invalid?: FloorProblem
}

/** The screen's problem for a failed call. Exported for the tests. */
export function problemOf(error: unknown, meanings: Meanings = {}): Outcome<never> {
  if (!isApiError(error)) return { ok: false, problem: 'unavailable' }
  const pinNeeded = error.kind === 'invalid' && error.issues.some((issue) => issuePath(issue) === 'pin')
  const problem: FloorProblem = (() => {
    switch (error.kind) {
      case 'signed_out':
        return meanings.signedOut ?? 'wrong'
      case 'rate_limited':
        return 'rateLimited'
      case 'conflict':
        return meanings.conflict ?? 'operatorActive'
      case 'invalid':
        return pinNeeded ? 'pinNeeded' : (meanings.invalid ?? 'unavailable')
      case 'forbidden':
      case 'step_up':
        return 'locked'
      default:
        return 'unavailable'
    }
  })()
  return { ok: false, problem, error }
}

async function attempt<T>(run: () => Promise<T>, meanings?: Meanings): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return problemOf(error, meanings)
  }
}

// ---- the device ----

/** The enrolled device, or null when this browser holds no live device token. */
export async function fetchDevice(api: ApiClient): Promise<Outcome<DeviceInfo | null>> {
  try {
    return { ok: true, value: await api.get('/floor/device', { schema: deviceInfoSchema }) }
  } catch (error) {
    if (isApiError(error) && error.kind === 'signed_out') return { ok: true, value: null }
    return problemOf(error)
  }
}

/** The signed-in operator of this browser, or null when nobody is. */
export async function fetchMe(api: ApiClient): Promise<Outcome<FloorMe | null>> {
  try {
    return { ok: true, value: await api.get('/floor/me', { schema: floorMeSchema }) }
  } catch (error) {
    if (isApiError(error) && (error.kind === 'signed_out' || error.kind === 'forbidden')) return { ok: true, value: null }
    return problemOf(error)
  }
}

export function enrolDevice(api: ApiClient, code: string, appVersion: string): Promise<Outcome<DeviceInfo>> {
  return attempt(async () => {
    await csrf(api)
    return api.post('/floor/device/enrol', { body: { code, appVersion }, schema: deviceInfoSchema })
  }, { signedOut: 'codeInvalid', invalid: 'codeInvalid' })
}

// ---- signing in and out ----

export interface Credentials {
  readonly badgeCode?: string
  readonly workerId?: string
  readonly pin?: string
}

/** Sign in (or, with someone signed in, switch person) and read who is on. */
export function signIn(api: ApiClient, credentials: Credentials, mode: 'sign-in' | 'switch' = 'sign-in'): Promise<Outcome<FloorMe>> {
  return attempt(async () => {
    await csrf(api)
    await api.post(mode === 'switch' ? '/floor/switch' : '/floor/sign-in', { body: credentials, schema: signedIn })
    return api.get('/floor/me', { schema: floorMeSchema })
  })
}

export async function signOut(api: ApiClient): Promise<void> {
  try {
    await csrf(api)
    await api.post('/floor/sign-out')
  } catch {
    // Signed out anyway: the session ends at its idle end; the screen goes back to sign-in.
  }
}

/** The worker's own new PIN (after an administrator's reset): the current one (the office's), then the new one. */
export function changePin(api: ApiClient, currentPin: string, newPin: string): Promise<Outcome<FloorMe>> {
  return attempt(
    async () => {
      await csrf(api)
      // A wrong current PIN answers 401 (the worker stays signed in); the PIN rules answer 400 at `newPin`.
      await api.post('/floor/pin', { body: { currentPin, newPin } })
      return api.get('/floor/me', { schema: floorMeSchema })
    },
    { signedOut: 'wrong', invalid: 'pinRefused' },
  )
}

// ---- the worker notice (SCR-025; platform/privacy) ----

const shownNotice = z.object({
  id: z.string(),
  label: z.string(),
  versionNo: z.number(),
  locale: z.string(),
  body: z.string(),
  sha256: z.string(),
  languages: z.array(z.string()),
  languageReady: z.boolean(),
})
const noticeAnswer = z.object({ notice: shownNotice.nullable(), gate: noticeGate, means: z.string() })
export type ShownNotice = z.infer<typeof shownNotice>

export function fetchNotice(api: ApiClient, locale?: string): Promise<Outcome<z.infer<typeof noticeAnswer>>> {
  return attempt(() => api.get('/privacy/floor/notice', { query: { locale }, schema: noticeAnswer }), { signedOut: 'notEnrolled' })
}

export function acknowledgeNotice(api: ApiClient, notice: Pick<ShownNotice, 'id' | 'locale' | 'sha256'>): Promise<Outcome<NoticeGate>> {
  return attempt(async () => {
    await csrf(api)
    const answer = await api.post('/privacy/floor/notice/acknowledge', {
      body: { noticeId: notice.id, locale: notice.locale, sha256: notice.sha256, deviceTime: new Date().toISOString() },
      idempotencyKey: newIdempotencyKey(),
      schema: z.object({ acknowledged: z.literal(true), changed: z.boolean(), gate: noticeGate }),
    })
    return answer.gate
  }, { conflict: 'newerNotice', signedOut: 'notEnrolled' })
}

// ---- Scan anything's lookups (each needs its own permission: the screen asks only what the person holds) ----

const decimal = z.union([z.string(), z.number()]).transform(String)

const hideAnswer = z.object({
  hide: z.object({
    code: z.string(),
    itemName: z.string(),
    colourCode: z.string().nullable(),
    area: decimal,
    areaUom: z.string(),
    grade: z.string().nullable(),
    shade: z.string().nullable(),
    thicknessMm: z.string().nullable(),
    state: z.string(),
    lot: z.object({ code: z.string(), qualityStatus: z.string(), crViStatus: z.string(), usable: z.boolean(), words: z.string().nullable() }),
  }),
  onHand: z.array(z.object({ locationCode: z.string(), onHand: decimal })),
  workOrders: z.array(z.object({ number: z.string(), cuttable: z.boolean() })),
})

/** The hide with this tag, or null. */
export async function lookupHide(api: ApiClient, code: string): Promise<HideCard | null> {
  try {
    const { hide, onHand, workOrders } = await api.get('/production/cutting/hides', { query: { code }, schema: hideAnswer })
    return {
      kind: 'hide',
      code: hide.code,
      item: hide.itemName,
      colour: hide.colourCode,
      area: hide.area,
      areaUom: hide.areaUom,
      grade: hide.grade,
      thicknessMm: hide.thicknessMm,
      shade: hide.shade,
      state: hide.state,
      lot: hide.lot,
      onHand: onHand.map((row) => ({ location: row.locationCode, quantity: row.onHand })),
      workOrders: workOrders.filter((order) => order.cuttable).map((order) => order.number),
    }
  } catch (error) {
    if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'invalid')) return null
    throw error
  }
}

const workOrdersAnswer = z.object({
  workOrders: z.array(
    z.object({
      number: z.string(),
      batchNumber: z.string().nullable(),
      status: z.string(),
      dueDate: z.string().nullable(),
      style: z.object({ code: z.string(), name: z.string() }),
      colourways: z.array(z.string()),
      pieces: z.number(),
      toCut: z.number(),
      sizesLeft: z.array(z.string()),
    }),
  ),
})

/** The work order with this number (cutting's list: released and in progress), or null. */
export async function lookupWorkOrder(api: ApiClient, number: string): Promise<WorkOrderCard | null> {
  try {
    const { workOrders } = await api.get('/production/cutting/work-orders', { query: { number, limit: 1 }, schema: workOrdersAnswer })
    const order = workOrders[0]
    if (!order) return null
    return {
      kind: 'workOrder',
      number: order.number,
      batchNumber: order.batchNumber,
      status: order.status,
      style: `${order.style.code} · ${order.style.name}`,
      dueDate: order.dueDate,
      pieces: order.pieces,
      toCut: order.toCut,
      sizesLeft: order.sizesLeft,
      colourways: order.colourways,
    }
  } catch (error) {
    if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'invalid')) return null
    throw error
  }
}

const locationsAnswer = z.object({
  sites: z.array(z.object({ id: z.string(), locations: z.array(z.object({ code: z.string(), name: z.string(), kind: z.string(), status: z.string(), path: z.array(z.string()) })) })),
})

/** The site's location with this code (any case), or null. */
export async function lookupLocation(api: ApiClient, siteId: string, code: string): Promise<LocationCard | null> {
  const { sites } = await api.get('/inventory/locations', { query: { siteId }, schema: locationsAnswer })
  const wanted = code.trim().toUpperCase()
  const found = sites.flatMap((site) => site.locations).find((location) => location.code.toUpperCase() === wanted)
  return found ? { kind: 'location', code: found.code, name: found.name, locationKind: found.kind, path: found.path } : null
}
