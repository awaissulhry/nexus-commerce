import { z } from 'zod'
import { DEVICE_KINDS } from '@nexus/factory-domain/auth/sessions/device'
import { STEP_UP_OFF_MAX } from '@nexus/factory-domain/auth/sessions/lengths'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { STEP_UP_FIXED } from '../office/step-up-actions'

/**
 * Active sessions and the company's security settings (B-W2b-404; PLT-064, PLT-068, PLT-063). Codes and numbers only:
 * the web says them in the person's language (a device kind, a surface, an action key, why an action is fixed). Never an
 * address: a place is a country and a city, when an edge proxy gave them.
 */

export const sessionView = output({
  id: id(),
  /** The browser this request came from ("This browser"). */
  current: z.boolean(),
  /** OFFICE, a partner's PORTAL, or an office person's PREVIEW of a portal. */
  surface: z.enum(['OFFICE', 'PORTAL', 'PREVIEW']),
  /** The device's kind (a code), or null for one not known. */
  deviceKind: z.enum(DEVICE_KINDS).nullable(),
  /** The device as kept on the session (the label of its kind, or older text). */
  deviceLabel: z.string().nullable(),
  /** The browser's name and major version. */
  browser: z.string().nullable(),
  place: output({ country: z.string().nullable(), city: z.string().nullable() }),
  startedAt: instant(),
  lastUsedAt: instant(),
  idleExpiresAt: instant(),
  absoluteExpiresAt: instant(),
})

const sessionsAnswer = output({ sessions: z.array(sessionView) })
const ended = output({ ended: z.number().int() })

export const mySessionsContract = defineContract({ response: { 200: sessionsAnswer } })
export const endMySessionContract = defineContract({ params: input({ sessionId: id() }), response: { 200: ended } })
export const endOtherSessionsContract = defineContract({ response: { 200: ended } })
export const userSessionsContract = defineContract({ params: input({ userId: id() }), response: { 200: sessionsAnswer } })
export const endUserSessionsContract = defineContract({
  params: input({ userId: id() }),
  body: input({ reason: z.string().trim().min(1).max(500).optional() }),
  response: { 200: ended },
})

const bound = output({ min: z.number().int(), max: z.number().int(), default: z.number().int() })

export const securitySettingsView = output({
  /** The settings row's version (0: none yet, the defaults); a save sends it back. */
  version: z.number().int(),
  sessions: output({
    office: output({ idleMinutes: z.number().int(), longestHours: z.number().int() }),
    portal: output({ idleMinutes: z.number().int(), longestHours: z.number().int() }),
    /** Each active site's floor times (its FloorSettings, changed in Admin › Devices): shown here, not changed. */
    floor: z.array(output({ siteId: id(), companyId: id(), code: z.string(), name: z.string(), idleMinutes: z.number().int(), shiftEnds: z.array(z.string()) })),
  }),
  stepUp: output({
    actions: z.array(
      output({
        key: z.string(),
        /** The permissions of the routes it covers. */
        permissions: z.array(z.string()),
        /** It asks for a fresh code now. */
        on: z.boolean(),
        canSwitchOff: z.boolean(),
        /** Why it always asks (null: the company may switch it off). */
        fixed: z.enum(STEP_UP_FIXED).nullable(),
      }),
    ),
    maxFailures: z.number().int(),
    lockMinutes: z.number().int(),
    /** How long a fresh code opens the risky actions. */
    validMinutes: z.number().int(),
  }),
  bounds: output({
    officeIdleMinutes: bound,
    officeLongestHours: bound,
    portalIdleMinutes: bound,
    portalLongestHours: bound,
    stepUpMaxFailures: bound,
    stepUpLockMinutes: bound,
  }),
  /** The caller may change them (security.settings.manage). */
  canChange: z.boolean(),
})

export const securitySettingsContract = defineContract({ response: { 200: securitySettingsView } })

const minutes = z.number().int()
export const sessionLengthsContract = defineContract({
  body: input({
    version: z.number().int().min(0),
    officeIdleMinutes: minutes,
    officeLongestHours: minutes,
    portalIdleMinutes: minutes,
    portalLongestHours: minutes,
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  response: { 200: securitySettingsView },
})

export const stepUpRulesContract = defineContract({
  body: input({
    version: z.number().int().min(0),
    /** The action keys switched off (every other action asks for a fresh code). */
    off: z.array(z.string().max(80)).max(STEP_UP_OFF_MAX),
    maxFailures: z.number().int(),
    lockMinutes: z.number().int(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  response: { 200: securitySettingsView },
})

export type SessionLengthsBody = z.infer<typeof sessionLengthsContract.body>
export type StepUpRulesBody = z.infer<typeof stepUpRulesContract.body>
