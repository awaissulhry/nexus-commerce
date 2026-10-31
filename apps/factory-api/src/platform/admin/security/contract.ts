import { z } from 'zod'
import { DRILL_KEYS } from '@nexus/factory-domain/ops/drills'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Security & health (B-W2a-36; PLT-045, PLT-214; SCR-166). Every answer is facts and states in codes: the web says them
 * in words. Never a secret, a token, a money figure or a worker's name.
 */

export const STATUS_PARTS = ['api', 'database', 'jobs', 'scheduled', 'files', 'backups', 'drill'] as const
export const STATUS_STATES = ['ok', 'warning', 'failing', 'needs', 'unknown'] as const
export const PROTECTION_FACTS = ['inTransit', 'atRest', 'secrets', 'bank', 'headers', 'virusScan'] as const
export const PROTECTION_STATES = ['on', 'off', 'provider', 'partly'] as const
export const DRILL_STATES = ['none', 'failed', 'overdue', 'due_soon', 'ok'] as const
const drillResult = z.enum(['PASSED', 'FAILED'])

export const statusLine = output({
  part: z.enum(STATUS_PARTS),
  state: z.enum(STATUS_STATES),
  /** How many (events waiting, files quarantined …), when the line counts something. */
  count: z.number().int().nullable(),
  /** Minutes (the oldest event waiting). */
  minutes: z.number().int().nullable(),
  /** A day or a time the line names (the last drill, the next one due). */
  at: z.string().nullable(),
  /** Days (since the last drill; left until the next, negative when overdue). */
  days: z.number().int().nullable(),
  /** A mode the line names (the file store's: FAKE, SANDBOX, LIVE). */
  mode: z.string().nullable(),
})
export type StatusLine = z.infer<typeof statusLine>

export const drillStatusView = output({
  state: z.enum(DRILL_STATES),
  lastOn: z.string().nullable(),
  lastResult: drillResult.nullable(),
  daysAgo: z.number().int().nullable(),
  dueOn: z.string().nullable(),
  daysLeft: z.number().int().nullable(),
})

export const drillView = output({
  id: id(),
  drilledOn: z.string(),
  environment: z.string(),
  backupAt: instant().nullable(),
  result: drillResult,
  durationMinutes: z.number().int().nullable(),
  notes: z.string().nullable(),
  /** Checksums only: a key the drill compared, both sides, and whether they matched (older drills may name other keys). */
  checks: z.array(output({ key: z.string(), source: z.string().nullable(), restored: z.string().nullable(), match: z.boolean() })),
  evidenceFileId: id().nullable(),
  performedBy: output({ id: id(), name: z.string() }).nullable(),
  createdAt: instant(),
})
export type DrillView = z.infer<typeof drillView>

export const pageContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      status: z.array(statusLine),
      signIn: output({
        password: output({ minLength: z.number().int(), maxLength: z.number().int() }),
        lockout: output({ afterFailures: z.number().int(), firstLockMinutes: z.number().int(), maxLockMinutes: z.number().int() }),
        sessions: output({ idleHours: z.number().int(), absoluteDays: z.number().int(), stepUpMinutes: z.number().int() }),
        /** The office roles and how many ask for two-factor; null without roles.view. */
        twoFactor: output({ officeRoles: z.number().int(), asking: z.number().int(), holdersWithout: z.number().int() }).nullable(),
      }),
      backups: output({ drill: drillStatusView, drills: z.array(drillView), canRecord: z.boolean() }),
      protection: z.array(output({ fact: z.enum(PROTECTION_FACTS), state: z.enum(PROTECTION_STATES), count: z.number().int().nullable() })),
    }),
  },
})

// ---- two-factor per role ---------------------------------------------------------------------------------------------

export const twoFactorHolder = output({ userId: id(), name: z.string().nullable(), twoFactor: z.boolean() })

export const twoFactorRoleView = output({
  id: id(),
  key: z.string(),
  name: z.string(),
  system: z.boolean(),
  requireMfa: z.boolean(),
  /** B-W2b-24: since when it asks (UTC); null when it does not ask, or asked from before the time was kept. */
  requireMfaSince: instant().nullable(),
  /** Why it cannot be turned off: floor, money (sees costs or margins), template (the ready-made role asks it); null: it can. */
  lock: z.enum(['floor', 'money', 'template']).nullable(),
  /** The ready-made template asks it (a ready-made role never asks less). */
  templateAsks: z.boolean(),
  version: z.number().int(),
  /** Its holders now; names only for a reader with users.view. */
  holders: z.array(twoFactorHolder),
  /** The reader holds this role (nobody changes a role they hold). */
  heldByMe: z.boolean(),
})
export type TwoFactorRoleView = z.infer<typeof twoFactorRoleView>

export const twoFactorListContract = defineContract({ response: { 200: output({ roles: z.array(twoFactorRoleView), canChange: z.boolean() }) } })

const changes = z
  .array(input({ roleId: id(), version: z.number().int().min(1), requireMfa: z.boolean() }))
  .min(1)
  .max(100)

export const twoFactorPreviewContract = defineContract({
  body: input({ changes }),
  response: {
    200: output({
      /** The people asked for two-factor at their next sign-in (asking), or no longer asked (lowering). */
      affected: z.array(twoFactorHolder),
      /** Open sessions without two-factor that keep the role until they end. */
      openSessions: z.number().int(),
      /** What the change would refuse, in words, with the change it is about; empty: it can be made. */
      refusals: z.array(output({ path: z.string(), code: z.enum(['floor', 'money', 'template', 'already', 'notAsked', 'held', 'stale', 'lockOut']), message: z.string() })),
    }),
  },
})

export const twoFactorChangeContract = defineContract({
  body: input({ changes, reason: z.string().trim().min(1).max(500).optional() }),
  response: { 200: output({ roles: z.array(twoFactorRoleView) }) },
})

// ---- restore drills --------------------------------------------------------------------------------------------------

const fingerprint = output(Object.fromEntries(DRILL_KEYS.map((key) => [key, z.string()])) as Record<(typeof DRILL_KEYS)[number], z.ZodString>)

export const fingerprintContract = defineContract({
  querystring: input({ asOf: instant().optional() }),
  response: { 200: output({ asOf: instant(), fingerprint, line: z.string() }) },
})

export const drillsContract = defineContract({ response: { 200: output({ drills: z.array(drillView) }) } })

export const evidenceContract = defineContract({
  body: input({
    /** The drill's id when a file was announced for it before (another try); none: a new id is made. */
    drillId: id().optional(),
    originalName: z.string().trim().min(1).max(200),
    contentType: z.string().max(120),
    sizeBytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  response: {
    201: output({
      drillId: id(),
      file: output({ id: id(), originalName: z.string(), status: z.string() }),
      upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})

export const evidenceCompleteContract = defineContract({
  params: input({ fileId: id() }),
  response: { 200: output({ file: output({ id: id(), originalName: z.string(), status: z.string() }) }) },
})

export const recordDrillContract = defineContract({
  body: input({
    /** The id the evidence was announced for; none (no evidence): a new id. */
    id: id().optional(),
    drilledOn: businessDate(),
    environment: z.string().trim().min(1).max(120),
    backupAt: instant(),
    /** The restored copy's fingerprint line (`NXF1 orders=… …`), as its Security & health page shows it. */
    restored: z.string().trim().min(1).max(500),
    durationMinutes: z.number().int().min(0).max(10_080).optional(),
    notes: z.string().trim().max(2000).optional(),
    evidenceFileId: id().optional(),
  }),
  response: { 200: output({ drill: drillView, drillStatus: drillStatusView }) },
})

// ---- All settings › Needs attention --------------------------------------------------------------------------------

export const ATTENTION_KINDS = ['integrationFailing', 'mailDomain', 'tabletUnseen', 'drill', 'jobsFailed', 'twoFactorMissing'] as const

export const attentionContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      items: z.array(
        output({
          kind: z.enum(ATTENTION_KINDS),
          /** The fact's subject in its own words (a connection's label, a domain, a tablet's name); null when none. */
          subject: z.string().nullable(),
          /** The state behind it: the drill's (none, failed, overdue, due_soon), the mail domain's (PENDING, FAILED …). */
          state: z.string().nullable(),
          /** Since when: an instant (UTC), or a day `YYYY-MM-DD` (the last restore drill's). */
          since: z.string().nullable(),
          count: z.number().int().nullable(),
          days: z.number().int().nullable(),
          /** The Office page that fixes it (`/admin/connections/<id>`, `/admin/security#backups` …). */
          href: z.string(),
          severity: z.enum(['warning', 'critical']),
        }),
      ),
      /** The reads this person may not make (their rows are left out, said so). */
      unread: z.array(z.enum(ATTENTION_KINDS)),
    }),
  },
})

export type RecordDrillBody = z.infer<typeof recordDrillContract.body>
export type EvidenceBody = z.infer<typeof evidenceContract.body>
export type TwoFactorChangeBody = z.infer<typeof twoFactorChangeContract.body>
