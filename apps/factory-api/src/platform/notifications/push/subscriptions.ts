import { createHash } from 'node:crypto'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { cadenceIn, EVENT_KINDS } from '@nexus/factory-domain/notifications/preferences/preferences'
import { endpointProblem, keysProblem, labelProblem, PUSH_LIMITS, pushOutcomeOf, testPushOf, type PushMessage, type PushOutcome } from '@nexus/factory-domain/notifications/preferences/push'
import type { FactoryClient } from '@nexus/factory-db'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { processSecrets } from '../../secrets/service'
import { readSecret, storeSecret } from '../../secrets/store'
import { officeOf } from '../notifications'
import { matrixOf } from '../preferences/store'
import { processPush, type PushRuntime } from './service'
import { pushRequest, type DeviceKeys, type PushUrgency } from './web-push'

/**
 * Push on this device (B-W2b-385; PLT-140; design home.notifications ⋯ › Push on this device, popup push-enrol "Get urgent
 * items on this phone": what counts as urgent, how to add the app to the home screen on iPhone, a test push). The person's own
 * devices only (home.view):
 *
 *   GET    /notifications/push                       whether push works here (and why not), the VAPID public key the browser
 *                                                     subscribes with, my live devices, what reaches them (my push column)
 *   POST   /notifications/push/devices               turn push on for this device: the browser's endpoint and keys; the keys
 *                                                     are sealed FIRST (platform/secrets, purpose notifications.push), then the
 *                                                     subscription names them, in ONE command. The same endpoint again: the
 *                                                     same device (its name may change). Live for another person (a shared
 *                                                     browser): theirs is turned off in the same command.
 *   DELETE /notifications/push/devices/:id           turn it off: ONE update (turned off, keys cleared), then the sealed keys
 *                                                     are deleted. A push service that says the subscription is gone (404,
 *                                                     410) turns it off the same way.
 *   POST   /notifications/push/test                  a test push to my devices (or one) now, each one's outcome.
 */

export const PUSH_PURPOSE = 'notifications.push'

const DEVICE = { id: true, userId: true, deviceLabel: true, endpoint: true, keysSecretId: true, lastUsedAt: true, revokedAt: true, createdAt: true, version: true } as const

type Client = FactoryClient | CommandTx

const deviceView = (row: { id: string; deviceLabel: string; endpoint: string; lastUsedAt: Date | null; createdAt: Date }) => ({
  id: row.id,
  label: row.deviceLabel,
  /** The push service the device uses (its host), never the full address. */
  service: new URL(row.endpoint).hostname,
  lastUsedAt: row.lastUsedAt ? toUtcIso(row.lastUsedAt) : null,
  createdAt: toUtcIso(row.createdAt),
})

/** The company code the push links open under (/w/<code>/…): the record's company, else the tenant's first. */
export async function companyCodeOf(client: Client, companyId: string | null): Promise<string> {
  const company = companyId ? await client.company.findUnique({ where: { id: companyId }, select: { code: true } }) : null
  if (company) return company.code
  const first = await client.company.findFirst({ orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { code: true } })
  return first?.code ?? 'all'
}

/** GET /notifications/push. */
export async function readPush(caller: CommandCaller) {
  const context = officeOf(caller)
  const runtime = processPush()
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const devices = await client.pushSubscription.findMany({ where: { userId: context.actorId, revokedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: DEVICE })
    const matrix = await matrixOf(client, context.actorId, now)
    return {
      available: runtime.unavailable === null,
      /** Why push cannot be turned on here, in words; null when it can. */
      unavailable: runtime.unavailable,
      /** The server's VAPID public key (base64url): the browser's applicationServerKey. */
      publicKey: runtime.vapid?.publicKey ?? null,
      devices: devices.map(deviceView),
      maxDevices: PUSH_LIMITS.devicesPerPerson,
      /** The kinds of news a push brings me now (my push column: my choice, my roles' defaults, else the urgent ones). */
      urgent: EVENT_KINDS.filter((kind) => cadenceIn(matrix.cells, kind, 'PUSH') === 'INSTANT'),
    }
  })
}

export interface DeviceBody {
  readonly label: string
  readonly endpoint: string
  readonly keys: DeviceKeys
}

/** Turns one live subscription off inside a command: one update (turned off, keys cleared), then the sealed keys deleted. */
async function turnOffInCommand(tools: Pick<CommandTools, 'tx' | 'now' | 'audit'>, row: { id: string; userId: string; keysSecretId: string | null; version: number }, why: 'PERSON' | 'GONE' | 'TAKEN_OVER'): Promise<void> {
  await tools.tx.pushSubscription.update({ where: { id: row.id }, data: { revokedAt: tools.now, keysSecretId: null, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
  if (row.keysSecretId) await tools.tx.secretValue.delete({ where: { id: row.keysSecretId }, select: { id: true } })
  tools.audit({ action: 'notifications.pushOff', recordType: 'PushSubscription', recordId: row.id, before: { live: true }, after: { live: false, why } })
}

/** POST /notifications/push/devices: turn push on for this device. */
export async function addDevice(caller: CommandCaller, body: DeviceBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const runtime = processPush()
  if (runtime.unavailable) throw new DomainError('conflict', runtime.unavailable, [{ path: 'push/UNAVAILABLE', message: runtime.unavailable }])
  const problems = [
    ...[labelProblem(body.label)].filter((message): message is string => message !== null).map((message) => ({ path: 'body/label', message })),
    ...[endpointProblem(body.endpoint)].filter((message): message is string => message !== null).map((message) => ({ path: 'body/endpoint', message })),
    ...[keysProblem(body.keys)].filter((message): message is string => message !== null).map((message) => ({ path: 'body/keys', message })),
  ]
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const label = body.label.trim()
  const { result } = await command(caller, { name: 'notifications.pushOn', idempotencyKey, input: { label, endpoint: body.endpoint } }, async (tools) => {
    const { tx, now } = tools
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`push|${body.endpoint}`}::text))`
    const live = await tx.pushSubscription.findFirst({ where: { endpoint: body.endpoint, revokedAt: null }, select: DEVICE })
    if (live && live.userId === context.actorId) {
      if (live.deviceLabel !== label) {
        await tx.pushSubscription.update({ where: { id: live.id }, data: { deviceLabel: label, version: live.version + 1, updatedAt: now }, select: { id: true } })
        tools.audit({ action: 'notifications.pushRename', recordType: 'PushSubscription', recordId: live.id, before: { label: live.deviceLabel }, after: { label } })
      } else {
        tools.audit({ action: 'notifications.pushOn', recordType: 'PushSubscription', recordId: live.id, after: { label, again: true } })
      }
      return live.id
    }
    // A shared browser that another person turned push on in: the device is this person's now.
    if (live) await turnOffInCommand(tools, live, 'TAKEN_OVER')
    const mine = await tx.pushSubscription.count({ where: { userId: context.actorId, revokedAt: null } })
    if (mine >= PUSH_LIMITS.devicesPerPerson) {
      const message = `You have push on ${PUSH_LIMITS.devicesPerPerson} devices already: turn one off first.`
      throw new DomainError('conflict', message, [{ path: 'push/TOO_MANY', message }])
    }
    // The keys sealed first: a live subscription without its keys is refused by the database.
    const sealed = await storeSecret(tools, processSecrets(), { purpose: PUSH_PURPOSE, plaintext: JSON.stringify({ p256dh: body.keys.p256dh, auth: body.keys.auth }) })
    const id = newId()
    await tx.pushSubscription.create({ data: { id, userId: context.actorId, deviceLabel: label, endpoint: body.endpoint, keysSecretId: sealed.id, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'notifications.pushOn', recordType: 'PushSubscription', recordId: id, after: { label, service: new URL(body.endpoint).hostname } })
    return id
  })
  return { deviceId: result, ...(await readPush(caller)) }
}

/** DELETE /notifications/push/devices/:id: turn push off for one of my devices (already off: nothing changes). */
export async function removeDevice(caller: CommandCaller, deviceId: string, idempotencyKey?: string) {
  const context = officeOf(caller)
  await command(caller, { name: 'notifications.pushOff', idempotencyKey, input: { deviceId } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT id FROM "PushSubscription" WHERE id = ${deviceId}::uuid FOR UPDATE`
    const row = await tools.tx.pushSubscription.findFirst({ where: { id: deviceId, userId: context.actorId }, select: DEVICE })
    if (!row) throw new NotFoundError('Device not found.')
    if (row.revokedAt) {
      tools.audit({ action: 'notifications.pushOff', recordType: 'PushSubscription', recordId: row.id, after: { live: false, already: true } })
      return null
    }
    await turnOffInCommand(tools, row, 'PERSON')
    return null
  })
  return readPush(caller)
}

// ---- sending ------------------------------------------------------------------------------------------------------------

export interface DeviceOutcome {
  readonly deviceId: string
  readonly outcome: PushOutcome
  /** The push service's HTTP status (0: not reached). */
  readonly status: number
}

/** A topic the push service keeps one of per device (≤ 32 base64url characters): pushes of one record replace each other. */
const topicOf = (tag: string): string => createHash('sha256').update(tag).digest('base64url').slice(0, 32)

/**
 * Sends one message to each live device of a person (≤ 10), after any command, never inside one. Then ONE command records what
 * happened: lastUsedAt for every device the service took it for; a device the service called gone is turned off (keys deleted).
 * A failure of one device never stops the others; nothing throws for a device.
 */
export async function pushToPerson(caller: CommandCaller, input: { readonly tenantId: string; readonly userId: string; readonly message: PushMessage; readonly urgency: PushUrgency; readonly deviceId?: string }, runtime: PushRuntime = processPush()): Promise<DeviceOutcome[]> {
  if (runtime.unavailable || !runtime.vapid || !runtime.transport) return []
  const vapid = runtime.vapid
  const transport = runtime.transport
  const devices = await caller.withClient((client) => client.pushSubscription.findMany({ where: { userId: input.userId, revokedAt: null, ...(input.deviceId ? { id: input.deviceId } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: PUSH_LIMITS.devicesPerPerson, select: DEVICE }))
  const outcomes: DeviceOutcome[] = []
  for (const device of devices) {
    if (!device.keysSecretId) continue
    let status = 0
    try {
      const keys = JSON.parse(await caller.withClient((client) => readSecret(client, processSecrets(), { id: device.keysSecretId!, tenantId: input.tenantId, purpose: PUSH_PURPOSE }))) as DeviceKeys
      const request = pushRequest({ vapid, endpoint: device.endpoint, device: keys, payload: input.message, ttlSeconds: PUSH_LIMITS.ttlSeconds, urgency: input.urgency, topic: topicOf(input.message.tag), now: serverClock.now() })
      status = await transport.send(request)
    } catch {
      status = 0
    }
    outcomes.push({ deviceId: device.id, outcome: status === 0 ? 'FAILED' : pushOutcomeOf(status), status })
  }
  const used = outcomes.filter((entry) => entry.outcome === 'SENT').map((entry) => entry.deviceId)
  const gone = outcomes.filter((entry) => entry.outcome === 'GONE').map((entry) => entry.deviceId)
  if (used.length + gone.length > 0) {
    await command(caller, { name: 'notifications.pushUsed', input: { userId: input.userId, used, gone } }, async (tools) => {
      for (const id of used) {
        // Never back (the database refuses it): only a later time than the one kept.
        await tools.tx.pushSubscription.updateMany({ where: { id, revokedAt: null, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: tools.now } }] }, data: { lastUsedAt: tools.now, updatedAt: tools.now } })
      }
      for (const id of gone) {
        const row = await tools.tx.pushSubscription.findFirst({ where: { id, revokedAt: null }, select: DEVICE })
        if (row) await turnOffInCommand(tools, row, 'GONE')
      }
      tools.audit({ recordType: 'User', recordId: input.userId, after: { pushed: used.length, gone: gone.length } })
      return null
    })
  }
  return outcomes
}

/** POST /notifications/push/test: the test push of "Get urgent items on this phone", to my devices (or one) now. */
export async function testPush(caller: CommandCaller, body: { readonly deviceId?: string }) {
  const context = officeOf(caller)
  const runtime = processPush()
  if (runtime.unavailable) throw new DomainError('conflict', runtime.unavailable, [{ path: 'push/UNAVAILABLE', message: runtime.unavailable }])
  const facts = await caller.withClient(async (client) => {
    const user = await client.user.findUnique({ where: { id: context.actorId }, select: { locale: true } })
    const live = await client.pushSubscription.count({ where: { userId: context.actorId, revokedAt: null, ...(body.deviceId ? { id: body.deviceId } : {}) } })
    return { locale: user?.locale === 'en' ? ('en' as const) : ('it' as const), live, code: await companyCodeOf(client, context.companyId ?? null) }
  })
  if (facts.live === 0) throw body.deviceId ? new NotFoundError('Device not found.') : new ConflictError('Push is not on for any of your devices yet: turn it on on the device first.')
  const outcomes = await pushToPerson(caller, { tenantId: context.tenantId, userId: context.actorId, message: testPushOf(facts.locale, `/w/${encodeURIComponent(facts.code)}/home/notifications`), urgency: 'normal', ...(body.deviceId ? { deviceId: body.deviceId } : {}) }, runtime)
  return { results: outcomes.map((entry) => ({ deviceId: entry.deviceId, outcome: entry.outcome })), ...(await readPush(caller)) }
}
