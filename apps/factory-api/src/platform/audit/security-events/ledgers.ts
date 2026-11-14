import type { Prisma, ReadAction, SecurityEventKind, SecuritySurface } from '@nexus/factory-db'
import { PORTAL_CODE } from '@nexus/factory-domain/auth/portal/codes'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { readLogOn } from '../reads/switch'
import { originOf } from './origin'
import type { Detail } from './details'
import { databaseNow, securityEventRow } from './record'

/**
 * Security events and reads that ARE audit rows (B-W2b-399; PLT-074, PLT-075): command() hands each command's audit rows
 * here, in the command's own transaction, right after it writes them (core/command.ts). A row whose action is a sign-in, a
 * refused sign-in, a lockout, a two-factor change, a role change or an export adds its SecurityEvent; an export by an office
 * person adds its ReadLog EXPORT row too. So these are logged on every path that writes them, commit with the change or not at
 * all, and a later step's command (a custom role archived, a new export) is caught by its action without touching this file.
 * A command with none of these rows writes nothing more (no query).
 *
 *   auth.signIn                      SIGN_IN (office), details: the second factor
 *   auth.signInFailed                SIGN_IN_FAILED (wrong password or code) and LOCKOUT ACCOUNT when the row set the lock
 *   auth.passwordCheckFailed         LOCKOUT ACCOUNT when the row set the lock
 *   auth.stepUpFailed                STEP_UP_LOCKED when the wrong or reused code reached the step-up lock (B-W2b-404)
 *   auth.totpConfirm | auth.totpDisable           MFA_CHANGED SET_UP | SWITCHED_OFF
 *   floor.signIn | floor.switchOperator           SIGN_IN (floor; the worker)
 *   floor.signInFailed               SIGN_IN_FAILED WRONG_PIN (the worker) and LOCKOUT PIN when the row set the lock
 *   portal.signIn                    SIGN_IN (portal; the person's party)
 *   portal.signInFailed              SIGN_IN_FAILED WRONG_CODE and LOCKOUT CODE at the last try
 *   portal.signInCodeChecked         SIGN_IN_FAILED with the access problem, when the right code was refused
 *   roles.* (not roles.twoFactorSince, a bookkeeping fill), workers.setRoles, security.setRoleTwoFactor, and any row of a
 *   RoleAssignment or WorkerRole     ROLE_CHANGED (the record: the role, the assignment, the worker)
 *   exports.request, accounting.export, people.exportPayroll (EXPORTED)   EXPORT + ReadLog EXPORT (office)
 *
 * Who: the writer's actor, the floor worker the row names, or the portal person. Where: the writer's audience (an office
 * command of the portal's sign-in is the PORTAL), the floor's site, the party when known; the request's address hash
 * (origin.ts). Details are codes only (details.ts): never an address, a name or free text.
 */

type AuditRow = Prisma.AuditLogCreateManyInput

/** What command() knows of who writes (core/command.ts Writer). */
export interface LedgerWriter {
  readonly audience: 'OFFICE' | 'FLOOR' | 'PARTNER' | 'LINK' | 'SYSTEM'
  readonly actorId: string
  readonly siteId: string | null
  readonly partyId: string | null
  readonly requestId: string
}

interface Made {
  readonly kind: SecurityEventKind
  readonly surface?: SecuritySurface
  readonly actorId?: string | null
  readonly partyId?: string | null
  readonly details: Readonly<Record<string, Detail | undefined>>
  /** The record the event is about; default the row's. */
  readonly record?: { readonly type: string; readonly id: string } | null
}

const objectOf = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const numberOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const uuidOf = (value: unknown): string | undefined => (typeof value === 'string' && isUuid(value) ? value : undefined)

/** A LOCKOUT when the row set a lock (`after.lockedUntil`). */
function lockout(after: Record<string, unknown>, what: 'ACCOUNT' | 'PIN' | 'CODE', extra: Partial<Made> = {}): Made[] {
  return typeof after.lockedUntil === 'string' ? [{ kind: 'LOCKOUT', details: { what, lockedUntil: after.lockedUntil }, ...extra }] : []
}

/** The ROLE_CHANGED rows: the actions that change who may do what. */
const ROLE_ACTIONS = new Set(['workers.setRoles', 'security.setRoleTwoFactor'])
const ROLE_RECORDS = new Set(['RoleAssignment', 'WorkerRole'])
const isRoleChange = (row: AuditRow): boolean =>
  (row.action.startsWith('roles.') && row.action !== 'roles.twoFactorSince') || ROLE_ACTIONS.has(row.action) || ROLE_RECORDS.has(row.recordType)

/** The exports: the action and the record type of the row that says the data left as a file. */
const EXPORTS: Readonly<Record<string, { readonly recordType: string; readonly done?: string }>> = {
  'exports.request': { recordType: 'ExportJob' },
  'accounting.export': { recordType: 'AccountingExport', done: 'EXPORTED' },
  'people.exportPayroll': { recordType: 'PayrollExport', done: 'EXPORTED' },
}

function exportOf(row: AuditRow): boolean {
  const rule = EXPORTS[row.action]
  if (!rule || rule.recordType !== row.recordType) return false
  return rule.done === undefined || objectOf(row.after).status === rule.done
}

/** The security events of one audit row (none for most). */
export function eventsOfRow(row: AuditRow): Made[] {
  const after = objectOf(row.after)
  switch (row.action) {
    case 'auth.signIn':
      return [{ kind: 'SIGN_IN', details: { secondFactor: typeof after.secondFactor === 'string' ? after.secondFactor.toUpperCase() : 'NONE' } }]
    case 'auth.signInFailed':
      return [{ kind: 'SIGN_IN_FAILED', details: { reason: after.wrong === 'code' ? 'WRONG_CODE' : 'WRONG_PASSWORD', failedAttempts: numberOf(after.failedAttempts) } }, ...lockout(after, 'ACCOUNT')]
    case 'auth.passwordCheckFailed':
      return lockout(after, 'ACCOUNT', { details: { what: 'ACCOUNT', lockedUntil: after.lockedUntil as string, after: row.action } })
    case 'auth.stepUpFailed':
      // B-W2b-404: the try that reached the step-up lock (office/step-up-policy.ts); a wrong step-up code no longer locks the account.
      return typeof after.stepUpLockedUntil === 'string'
        ? [{ kind: 'STEP_UP_LOCKED', details: { result: typeof after.result === 'string' ? after.result : undefined, lockedUntil: after.stepUpLockedUntil } }]
        : []
    case 'auth.totpConfirm':
      return [{ kind: 'MFA_CHANGED', details: { change: 'SET_UP' } }]
    case 'auth.totpDisable':
      return [{ kind: 'MFA_CHANGED', details: { change: 'SWITCHED_OFF' } }]
    case 'floor.signIn':
    case 'floor.switchOperator':
      return [{ kind: 'SIGN_IN', actorId: uuidOf(after.workerId) ?? row.actorId, details: { method: typeof after.method === 'string' ? after.method.toUpperCase() : undefined, pin: typeof after.pin === 'boolean' ? after.pin : undefined, switch: row.action === 'floor.switchOperator' || undefined } }]
    case 'floor.signInFailed': {
      // The row names the worker the wrong PIN was typed for; the device wrote it.
      const worker = row.recordType === 'Worker' ? row.recordId : row.actorId
      return [{ kind: 'SIGN_IN_FAILED', actorId: worker, details: { reason: 'WRONG_PIN', failedAttempts: numberOf(after.failedPinAttempts) } }, ...lockout(after, 'PIN', { actorId: worker })]
    }
    case 'portal.signIn':
      return [{ kind: 'SIGN_IN', surface: 'PORTAL', partyId: uuidOf(after.partyId) ?? null, details: { method: typeof after.method === 'string' ? after.method : undefined } }]
    case 'portal.signInFailed': {
      const tries = numberOf(after.tries)
      return [
        { kind: 'SIGN_IN_FAILED', surface: 'PORTAL', details: { reason: 'WRONG_CODE', tries, method: typeof after.method === 'string' ? after.method : undefined } },
        ...(tries !== undefined && tries >= PORTAL_CODE.maxTries ? [{ kind: 'LOCKOUT' as const, surface: 'PORTAL' as const, details: { what: 'CODE', tries } }] : []),
      ]
    }
    case 'portal.signInCodeChecked':
      return typeof after.refused === 'string' ? [{ kind: 'SIGN_IN_FAILED', surface: 'PORTAL', details: { reason: after.refused } }] : []
    default:
      if (exportOf(row)) return [{ kind: 'EXPORT', details: { action: row.action, listKey: typeof after.listKey === 'string' ? after.listKey : undefined, format: typeof after.format === 'string' ? after.format : undefined } }]
      if (isRoleChange(row)) return [{ kind: 'ROLE_CHANGED', details: { change: row.action } }]
      return []
  }
}

const SURFACE: Readonly<Record<LedgerWriter['audience'], SecuritySurface>> = { OFFICE: 'OFFICE', FLOOR: 'FLOOR', PARTNER: 'PORTAL', LINK: 'LINK', SYSTEM: 'SYSTEM' }

/** The SecurityEvent rows of a command's audit rows (none for most commands). */
export function securityEventRows(rows: readonly AuditRow[], writer: LedgerWriter): Omit<Prisma.SecurityEventCreateManyInput, 'at'>[] {
  const ipHash = originOf(writer.requestId)
  return rows.flatMap((row) =>
    eventsOfRow(row).map((made) =>
      securityEventRow({
        kind: made.kind,
        surface: made.surface ?? SURFACE[writer.audience],
        actorId: made.actorId === undefined ? row.actorId : made.actorId,
        siteId: writer.siteId,
        partyId: made.partyId ?? writer.partyId,
        ipHash,
        record: made.record === undefined ? { type: row.recordType, id: row.recordId } : made.record,
        details: made.details,
      }),
    ),
  )
}

/** The ReadLog rows of a command's audit rows: an export by an office person (with the read log switched on). */
export function readLogRows(rows: readonly AuditRow[], writer: LedgerWriter): Omit<Prisma.ReadLogCreateManyInput, 'at'>[] {
  if (writer.audience !== 'OFFICE' || !readLogOn()) return []
  return rows.filter(exportOf).map((row) => ({ id: newId(), userId: writer.actorId, recordType: row.recordType, recordId: row.recordId, action: 'EXPORT' as ReadAction, surface: 'OFFICE' as SecuritySurface }))
}

/** command()'s seam: writes both, in the command's transaction (createMany: the floor and partner roles may only insert). */
export async function writeAuditLedgers(tx: Prisma.TransactionClient, rows: readonly AuditRow[], writer: LedgerWriter): Promise<void> {
  const events = securityEventRows(rows, writer)
  const reads = readLogRows(rows, writer)
  if (events.length === 0 && reads.length === 0) return
  const at = await databaseNow(tx)
  if (events.length > 0) await tx.securityEvent.createMany({ data: events.map((event) => ({ ...event, at })) })
  if (reads.length > 0) await tx.readLog.createMany({ data: reads.map((read) => ({ ...read, at })) })
}
