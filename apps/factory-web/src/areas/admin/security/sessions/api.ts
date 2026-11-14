import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * The company's security settings (B-W2b-413 on B-W2b-404's API; PLT-068, PLT-063): session lengths per audience and the
 * actions that ask for a fresh code. Mirrors apps/factory-api platform/auth/sessions/contract.ts `securitySettingsView`
 * (the web never imports the API's source). Read with security.view; changed with security.settings.manage, at the
 * version read; a wider change asks for a fresh code (403 `stepUp`), a refused one names its fields (`body/<field>/<code>`).
 */

/** Why an action always asks (STEP_UP_FIXED of the API): never switched off. */
export const STEP_UP_FIXED = ['ACCESS', 'SIGNATURE', 'LEGAL', 'RULE', 'SECURITY'] as const

const bound = z.object({ min: z.number(), max: z.number(), default: z.number() })

export const securitySettingsSchema = z.object({
  version: z.number(),
  sessions: z.object({
    office: z.object({ idleMinutes: z.number(), longestHours: z.number() }),
    portal: z.object({ idleMinutes: z.number(), longestHours: z.number() }),
    floor: z.array(z.object({ siteId: z.string(), companyId: z.string(), code: z.string(), name: z.string(), idleMinutes: z.number(), shiftEnds: z.array(z.string()) })),
  }),
  stepUp: z.object({
    actions: z.array(z.object({ key: z.string(), permissions: z.array(z.string()), on: z.boolean(), canSwitchOff: z.boolean(), fixed: z.enum(STEP_UP_FIXED).nullable() })),
    maxFailures: z.number(),
    lockMinutes: z.number(),
    validMinutes: z.number(),
  }),
  bounds: z.object({
    officeIdleMinutes: bound,
    officeLongestHours: bound,
    portalIdleMinutes: bound,
    portalLongestHours: bound,
    stepUpMaxFailures: bound,
    stepUpLockMinutes: bound,
  }),
  canChange: z.boolean(),
})
export type SecuritySettings = z.infer<typeof securitySettingsSchema>
export type StepUpActionRow = SecuritySettings['stepUp']['actions'][number]

export const readSecuritySettings = (api: ApiClient) => api.get('/auth/security-settings', { schema: securitySettingsSchema })

export interface LengthsBody {
  version: number
  officeIdleMinutes: number
  officeLongestHours: number
  portalIdleMinutes: number
  portalLongestHours: number
  reason?: string
}
export const saveSessionLengths = (api: ApiClient, body: LengthsBody) =>
  api.request('PUT', '/auth/security-settings/sessions', { body, schema: securitySettingsSchema, idempotencyKey: newIdempotencyKey() })

export interface StepUpBody {
  version: number
  /** The action keys switched off. */
  off: string[]
  maxFailures: number
  lockMinutes: number
  reason?: string
}
export const saveStepUpRules = (api: ApiClient, body: StepUpBody) =>
  api.request('PUT', '/auth/security-settings/step-up', { body, schema: securitySettingsSchema, idempotencyKey: newIdempotencyKey() })
