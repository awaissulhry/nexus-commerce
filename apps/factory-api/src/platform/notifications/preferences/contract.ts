import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CADENCES, EVENT_KINDS, PREFERENCE_CHANNELS, PREFERENCE_SOURCES } from '@nexus/factory-domain/notifications/preferences/preferences'
import { PUSH_LIMITS } from '@nexus/factory-domain/notifications/preferences/push'

/**
 * The contracts of notifications in depth (B-W2b-385; PLT-140, PLT-141, PLT-151; design home.notifications popups preferences
 * and push-enrol, home.today "My saved views"). Codes only: the screens say them in the person's language.
 */

const event = z.enum(EVENT_KINDS)
const channel = z.enum(PREFERENCE_CHANNELS)
const cadence = z.enum(CADENCES)

// ---- my matrix ----------------------------------------------------------------------------------------------------------

const matrix = output({
  asOf: instant(),
  /** The matrix's rows and columns, in the design's order. */
  events: z.array(event),
  channels: z.array(channel),
  cells: z.array(
    output({
      event,
      channel,
      cadence,
      /** PERSON: my choice; ROLE: my role's default ("Default for Planner"); QUIET: nobody chose (the quiet default). */
      source: z.enum(PREFERENCE_SOURCES),
      role: output({ id: id(), name: z.string() }).nullable(),
      /** What the cell is when neither I nor a role chose. */
      quiet: cadence,
      /** The cadences this channel offers (the daily digest is e-mail only). */
      choices: z.array(cadence),
    }),
  ),
  /** My live office roles (their defaults apply where I did not choose), in the order I was given them. */
  roles: z.array(output({ id: id(), name: z.string() })),
  /** The daily digest goes out only while it is on (GET/PUT /notifications/digest). */
  digestOn: z.boolean(),
  /** Devices with push on (GET /notifications/push): a push reaches only those. */
  pushDevices: z.number().int(),
  /** I may set the defaults of the office roles (home.notifications.manage). */
  mayManageDefaults: z.boolean(),
})

export const preferencesContract = defineContract({ response: { 200: matrix } })
export const savePreferenceContract = defineContract({ body: input({ event, channel, cadence }), response: { 200: matrix } })
export const resetPreferencesContract = defineContract({ response: { 200: matrix } })

// ---- role defaults --------------------------------------------------------------------------------------------------------

const roleDefaults = output({
  roles: z.array(output({ id: id(), name: z.string(), key: z.string(), system: z.boolean() })),
  /** The role shown (the asked one, else the first); null: there is no office role. */
  roleId: id().nullable(),
  cells: z.array(
    output({
      event,
      channel,
      /** The role's default; null: none (its holders get the quiet default). */
      cadence: cadence.nullable(),
      quiet: cadence,
      choices: z.array(cadence),
      changedAt: instant().nullable(),
    }),
  ),
})

export const roleDefaultsContract = defineContract({ querystring: input({ roleId: id().optional() }), response: { 200: roleDefaults } })
export const saveRoleDefaultContract = defineContract({ body: input({ roleId: id(), event, channel, /** null: remove the default. */ cadence: cadence.nullable() }), response: { 200: roleDefaults } })

// ---- push on this device --------------------------------------------------------------------------------------------------

const push = output({
  available: z.boolean(),
  /** Why push cannot be turned on here, in words; null when it can. */
  unavailable: z.string().nullable(),
  /** The server's VAPID public key (base64url): the browser's applicationServerKey. */
  publicKey: z.string().nullable(),
  devices: z.array(output({ id: id(), label: z.string(), /** The push service's host. */ service: z.string(), lastUsedAt: instant().nullable(), createdAt: instant() })),
  maxDevices: z.number().int(),
  /** The kinds of news a push brings me now. */
  urgent: z.array(event),
})

export const pushContract = defineContract({ response: { 200: push } })
export const addDeviceContract = defineContract({
  body: input({
    label: z.string().max(PUSH_LIMITS.label + 20),
    /** The browser's PushSubscription.endpoint. */
    endpoint: z.string().max(PUSH_LIMITS.endpoint),
    /** The browser's PushSubscription keys (base64url). */
    keys: input({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  }),
  response: { 200: push.extend({ deviceId: id() }) },
})
export const removeDeviceContract = defineContract({ params: input({ deviceId: id() }), response: { 200: push } })
export const testPushContract = defineContract({
  body: input({ /** One device; none: every device with push on. */ deviceId: id().optional() }),
  response: { 200: push.extend({ results: z.array(output({ deviceId: id(), outcome: z.enum(['SENT', 'GONE', 'FAILED']) })) }) },
})

// ---- followed saved views -------------------------------------------------------------------------------------------------

const followed = output({
  views: z.array(
    output({
      followId: id(),
      viewId: id(),
      name: z.string(),
      listKey: z.string(),
      companyId: id().nullable(),
      /** Rows when last counted for me (null: not counted yet). */
      count: z.number().int().nullable(),
      /** True: the view holds more rows than are counted. */
      capped: z.boolean(),
      countedAt: instant().nullable(),
      since: instant(),
    }),
  ),
  max: z.number().int(),
})

export const followedViewsContract = defineContract({ response: { 200: followed } })
export const followViewContract = defineContract({ params: input({ viewId: id() }), response: { 200: followed } })
