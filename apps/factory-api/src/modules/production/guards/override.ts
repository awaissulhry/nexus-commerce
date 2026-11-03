import type { FastifyRequest } from 'fastify'
import { badgeCodeHash, normalizeBadgeCode } from '@nexus/factory-domain/auth/floor/badge'
import { isPinLocked, pinLockUntil, verifyPin } from '@nexus/factory-domain/auth/floor/pin'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { overridePinWrong, overrideRefusal, type OverrideReasonCode } from '@nexus/factory-domain/production/guards/rules'
import { PRODUCTION_SCAN_OVERRIDE } from '@nexus/factory-domain/production/guards/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { floorGrantsOf } from '../../../platform/auth/floor/store'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { floorOf, refuse } from '../scans/access'
import { PIN_WRONG_ACTION } from './store'

/**
 * The team leader's override on the tablet (B-W2b-46; design floor.operation pop-up "Team leader override": "what is
 * being overridden, a reason tile, then the team leader's PinPad"). The team leader is named by their badge (scanned) or
 * picked by name, and proves it with their own 6-digit PIN, on the operator's signed-in tablet; the operator's session
 * stays. As at sign-in (platform/auth/floor): an unknown badge or worker, an inactive or locked team leader, a missing or
 * wrong PIN all answer the same refusal after the same scrypt work (no oracle), and a wrong PIN counts on the team
 * leader (5, then locked for minutes). The right is the team leader's own floor roles' (production.scan.override), never
 * the operator's; never on one's own scan. The PIN never reaches a command's input, result, audit row or log: the report
 * carries only who signed, the reason tile and the words.
 */

export interface LeadInput {
  /** The team leader's badge, scanned; or their worker id, picked by name: exactly one. */
  readonly badgeCode?: string | undefined
  readonly workerId?: string | undefined
  readonly pin: string
}

/** What a report carries of a verified override (no PIN). */
export interface VerifiedOverride {
  readonly leadWorkerId: string
  readonly reasonCode: OverrideReasonCode
  readonly note: string | null
}

const WORKER = { id: true, status: true, siteId: true, companyId: true, pinHash: true, pinMustChange: true, pinLockedUntil: true } as const

/** Counts a wrong PIN on the team leader's row (its own command: the report is not run), and sets the lock at the fifth. */
async function countWrongPin(caller: CommandCaller, workerId: string): Promise<void> {
  await command(caller, { name: PIN_WRONG_ACTION, idempotencyKey: `override-pin.${newId()}`, input: { workerId } }, async ({ tx, now, audit }) => {
    const { failedPinAttempts } = await tx.worker.update({ where: { id: workerId }, data: { failedPinAttempts: { increment: 1 } }, select: { failedPinAttempts: true } })
    const until = pinLockUntil(failedPinAttempts, now)
    if (until) await tx.worker.updateMany({ where: { id: workerId }, data: { pinLockedUntil: until } })
    audit({ recordType: 'Worker', recordId: workerId, after: { wrong: 'pin', failedPinAttempts, lockedUntil: until ? toUtcIso(until) : null } })
    return { failedPinAttempts }
  })
}

/** A lead proved by their own PIN: who, and whether their floor roles hold the permission asked. */
export interface ProvedLead {
  readonly workerId: string
  /** The lead's own floor roles hold the permission asked, at their site. */
  readonly may: boolean
}

/**
 * Proves a lead on the operator's tablet (B-W2b-46; B-W2b-103 reuses it for "Cut anyway"): the worker the badge or the id
 * names, active at the device's site, unlocked, with a PIN that matches; and whether their own floor roles hold `permission`.
 * Null for an unknown badge or worker, an inactive or locked one, a missing or wrong PIN: the same scrypt work either way (no
 * oracle), and a wrong PIN counts on the lead (5, then locked for minutes). The caller checked that exactly one of badge and
 * id is sent, and words its own refusal. The PIN never leaves this function.
 */
export async function proveLead(request: FastifyRequest, context: { readonly tenantId: string; readonly siteId: string }, lead: LeadInput, permission: Permission): Promise<ProvedLead | null> {
  const auth = officeAuthOf(request.server)
  const now = auth.clock.now()
  const worker = await request.withClient(async (client) => {
    if (lead.badgeCode !== undefined) {
      const code = normalizeBadgeCode(lead.badgeCode)
      if (code === null) return null
      const badge = await client.badge.findUnique({ where: { codeHash: badgeCodeHash(code) }, select: { status: true, workerId: true } })
      if (!badge || badge.status !== 'ACTIVE') return null
      return client.worker.findUnique({ where: { id: badge.workerId }, select: WORKER })
    }
    return client.worker.findUnique({ where: { id: lead.workerId! }, select: WORKER })
  })
  if (!worker || worker.siteId !== context.siteId || worker.status !== 'ACTIVE' || worker.pinHash === null || isPinLocked(worker, now)) {
    await verifyPin(lead.pin, null, auth.pins)
    return null
  }
  const check = await verifyPin(lead.pin, worker.pinHash, auth.pins)
  if (!check.ok) {
    await countWrongPin(request, worker.id)
    return null
  }
  const grants = await request.withClient((client) => floorGrantsOf(client, worker, { companyId: worker.companyId, siteId: worker.siteId }))
  const may = can({ audience: 'floor', tenantId: context.tenantId, siteId: context.siteId, grants }, permission, { companyId: worker.companyId, siteId: worker.siteId })
  return { workerId: worker.id, may }
}

/** Proves the team leader and their right; the override a report may carry, or a 409 refusal in words. */
export async function verifyOverride(request: FastifyRequest, input: { readonly lead: LeadInput; readonly reasonCode: OverrideReasonCode; readonly note?: string | undefined }): Promise<VerifiedOverride> {
  const context = floorOf(request)
  if ((input.lead.badgeCode === undefined) === (input.lead.workerId === undefined)) {
    throw new ValidationError('The team leader scans their badge or picks their name, then enters their PIN.', [{ path: 'body/lead', message: 'Send a badge code or a worker id, not both.' }])
  }
  const lead = await proveLead(request, context, input.lead, PRODUCTION_SCAN_OVERRIDE)
  if (!lead) return refuse(overridePinWrong())
  const note = input.note?.trim() || null
  const refusal = overrideRefusal({ leadId: lead.workerId, operatorId: context.actorId, mayOverride: lead.may, reasonCode: input.reasonCode, note })
  if (refusal) refuse(refusal)
  return { leadWorkerId: lead.workerId, reasonCode: input.reasonCode, note }
}
