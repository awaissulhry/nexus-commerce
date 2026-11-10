import type { Prisma } from '@nexus/factory-db'
import { approveRefusal, claimProblems, useRecordTypeOf, useRefusal, wordingOf, type ClaimInput, type ClaimKind, type ClaimScope, type Refusal, type UseKind } from '@nexus/factory-domain/compliance/claims/rules'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { problemsError, refuse } from '../../people/employees/access'
import { readClaimRow } from './reads'
import {
  assertManage,
  CLAIM_SELECT,
  claimsClock,
  claimViews,
  dateOf,
  dayOf,
  evidenceFiles,
  factOf,
  guarded,
  mayApprove,
  officeOf,
  stateOf,
  todayOf,
  useViews,
  USE_SELECT,
  wordingOfRow,
  type ClaimRow,
  type Reader,
} from './store'

/**
 * The claims register's writes (B-W2b-264; PRD-380; Dir. (EU) 2024/825; design compliance.sourcing pop:sc-new, pop:sc-claim),
 * office only, each one command with an Idempotency-Key:
 *
 *   POST  /compliance/claims                        draft a claim (DRAFT; its words checked: no generic claim, no
 *                                                   neutrality through offsetting); with `supersedesId`, a replacement of
 *                                                   an approved or withdrawn claim                          claims.manage
 *   PATCH /compliance/claims/:id                    change a draft (its version read)                       claims.manage
 *   POST  /compliance/claims/:id/approve            approve a draft with its evidence available and still holding; a
 *                                                   replacement withdraws the claim it replaces and takes over its live uses
 *                                                                                         claims.approve + a fresh code
 *   POST  /compliance/claims/:id/withdraw           withdraw a draft or an approved claim with the reason; its live uses end
 *                                                   in the same command                                     claims.manage
 *   POST  /compliance/claims/:id/uses               record where an approved claim that holds is used (a label template, or a
 *                                                   style for its texts, catalogue or web shop page)        claims.manage
 *   POST  /compliance/claims/:id/uses/:useId/end    end a use                                               claims.manage
 *
 * factory-db's guards (B-W2b-222, `recall: …`) hold the same rules for every login; these answer first, in words, and a
 * refusal of the database is a 409 in words too (`guarded`), never a 500.
 */

const settings = (): CommandSettings => ({ ...COMMAND_SETTINGS, clock: claimsClock() })
const refuseWith = (refusal: Refusal | null): void => {
  if (refusal) refuse(refusal.code, refusal.message, refusal.field)
}
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

export interface ClaimBody {
  readonly kind: ClaimKind
  readonly wording: Readonly<Record<string, string>>
  readonly phraseKey?: string | null | undefined
  readonly scope: ClaimScope
  readonly styleId?: string | null | undefined
  readonly itemId?: string | null | undefined
  readonly scopeNote?: string | null | undefined
  readonly evidenceFileIds: readonly string[]
  readonly validUntil?: string | null | undefined
  readonly note?: string | null | undefined
}

/** The body as stored: the languages typed, trimmed; blanks as null; a style or material only for its scope. */
function checked(code: string, body: ClaimBody): ClaimInput {
  const input: ClaimInput = {
    code: code.trim(),
    kind: body.kind,
    wording: wordingOf(body.wording),
    phraseKey: blankToNull(body.phraseKey),
    scope: body.scope,
    styleId: body.styleId ?? null,
    itemId: body.itemId ?? null,
    scopeNote: blankToNull(body.scopeNote),
    evidenceFileIds: [...body.evidenceFileIds],
    validUntil: body.validUntil ?? null,
    note: blankToNull(body.note),
  }
  const problems = claimProblems(input)
  if (problems.length > 0) throw problemsError(problems, 'The claim is not complete: see each field.')
  return input
}

const columns = (input: ClaimInput) => ({
  kind: input.kind,
  wording: input.wording as Prisma.InputJsonValue,
  phraseKey: input.phraseKey,
  scope: input.scope,
  styleId: input.scope === 'STYLE' ? input.styleId : null,
  itemId: input.scope === 'MATERIAL' ? input.itemId : null,
  scopeNote: input.scopeNote,
  evidenceFileIds: [...input.evidenceFileIds],
  validUntil: input.validUntil === null ? null : dateOf(input.validUntil),
  note: input.note,
})

/** What an audit row keeps of a claim: its facts, no person. */
const audited = (input: ClaimInput) => ({ kind: input.kind, wording: input.wording, phraseKey: input.phraseKey, scope: input.scope, styleId: input.styleId, itemId: input.itemId, scopeNote: input.scopeNote, evidenceFileIds: input.evidenceFileIds, validUntil: input.validUntil, note: input.note })
const auditedRow = (row: ClaimRow) => ({ kind: row.kind, wording: wordingOfRow(row.wording), phraseKey: row.phraseKey, scope: row.scope, styleId: row.styleId, itemId: row.itemId, scopeNote: row.scopeNote, evidenceFileIds: row.evidenceFileIds, validUntil: dayOf(row.validUntil), note: row.note })

/** What the claim names, of its own company (or tenant-wide): the database's rules, answered first in words. */
async function assertNamed(tx: CommandTx, companyId: string, input: ClaimInput, before: ClaimRow | null): Promise<void> {
  if (input.scope === 'STYLE' && input.styleId && input.styleId !== before?.styleId) {
    const style = await tx.style.findUnique({ where: { id: input.styleId }, select: { companyId: true } })
    if (!style || (style.companyId !== null && style.companyId !== companyId)) refuse('STYLE_OTHER_COMPANY', "The style is one of the company's styles or a tenant-wide one.", 'styleId')
  }
  if (input.scope === 'MATERIAL' && input.itemId && input.itemId !== before?.itemId) {
    const item = await tx.item.findUnique({ where: { id: input.itemId }, select: { companyId: true, kind: true } })
    if (!item || (item.companyId !== null && item.companyId !== companyId) || item.kind === 'FINISHED') refuse('MATERIAL_NOT_ALLOWED', "The material is one of the company's materials or a tenant-wide one, never a finished garment.", 'itemId')
  }
  if (input.phraseKey && input.phraseKey !== before?.phraseKey) {
    const phrase = await tx.phrase.findFirst({ where: { key: input.phraseKey }, select: { id: true } })
    if (!phrase) refuse('PHRASE_UNKNOWN', 'The phrase is not in the phrase library.', 'phraseKey')
  }
  const fresh = input.evidenceFileIds.filter((id) => !before?.evidenceFileIds.includes(id))
  if (fresh.length > 0) {
    const files = await tx.storedFile.findMany({ where: { id: { in: fresh } }, select: { id: true, companyId: true, status: true } })
    const usable = files.filter((file) => (file.companyId === null || file.companyId === companyId) && file.status !== 'DELETED')
    if (usable.length !== fresh.length) refuse('EVIDENCE_OTHER_COMPANY', "The evidence files are files of the company (or tenant-wide) that are not deleted.", 'evidenceFileIds')
  }
}

async function viewIn(db: Reader, context: OfficeContext, id: string) {
  const row = (await db.sustainabilityClaim.findUniqueOrThrow({ where: { id }, select: CLAIM_SELECT })) as ClaimRow
  return (await claimViews(db, context, [row], todayOf(claimsClock().now())))[0]!
}

const changed = (tools: CommandTools, row: Pick<ClaimRow, 'id' | 'companyId' | 'code'>, status: ClaimRow['status'], change: 'DRAFTED' | 'EDITED' | 'APPROVED' | 'WITHDRAWN' | 'REPLACED') =>
  tools.emit({ type: 'claim.changed', subject: row.id, companyId: row.companyId, payload: { claimId: row.id, code: row.code, status, change } })

const useChanged = (tools: CommandTools, claim: Pick<ClaimRow, 'id' | 'companyId'>, use: { id: string; kind: UseKind; recordType: string; recordId: string }, change: 'ADDED' | 'ENDED') =>
  tools.emit({ type: 'claim.use_changed', subject: claim.id, companyId: claim.companyId, payload: { claimId: claim.id, useId: use.id, kind: use.kind, recordType: use.recordType, recordId: use.recordId, change } })

// ---- draft and change ------------------------------------------------------------------------------------------------------

export interface CreateBody extends ClaimBody {
  readonly companyId: string
  readonly code: string
  readonly supersedesId?: string | null | undefined
}

/** POST /compliance/claims. */
export async function createClaim(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (context.companyId && context.companyId !== body.companyId) throw new ForbiddenError('A claim is drafted in the company the screen works in.')
  assertManage(context, body.companyId)
  const input = checked(body.code, body)
  const id = newId()
  const supersedesId = body.supersedesId ?? null
  const { result, replayed } = await guarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.claims.draft', idempotencyKey, input: body },
        async (tools) => {
          const { tx, now } = tools
          if (await tx.sustainabilityClaim.findFirst({ where: { companyId: body.companyId, code: input.code }, select: { id: true } })) refuse('CODE_TAKEN', `The code ${input.code} is taken in this company: choose another.`, 'code')
          let replaces: { id: string; code: string } | null = null
          if (supersedesId) {
            const old = await tx.sustainabilityClaim.findUnique({ where: { id: supersedesId }, select: { id: true, code: true, companyId: true, status: true } })
            if (!old || old.companyId !== body.companyId || old.status === 'DRAFT') refuse('REPLACES_OTHER', 'A replacement replaces an approved or withdrawn claim of the same company.', 'supersedesId')
            if (await tx.sustainabilityClaim.findFirst({ where: { supersedesId, status: { not: 'WITHDRAWN' } }, select: { id: true } })) refuse('ALREADY_REPLACED', 'This claim has a replacement already: change or withdraw that one.', 'supersedesId')
            replaces = { id: old!.id, code: old!.code }
          }
          await assertNamed(tx, body.companyId, input, null)
          await tx.sustainabilityClaim.create({ data: { id, companyId: body.companyId, code: input.code, supersedesId, ...columns(input), createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
          tools.audit({ action: 'compliance.claims.draft', recordType: 'SustainabilityClaim', recordId: id, companyId: body.companyId, after: { code: input.code, status: 'DRAFT', ...audited(input), ...(replaces ? { replaces: replaces.code } : {}) } })
          changed(tools, { id, companyId: body.companyId, code: input.code }, 'DRAFT', 'DRAFTED')
          return { claim: await viewIn(tx, context, id) }
        },
        settings(),
      ),
    { taken: `The code ${input.code} is taken in this company: choose another.` },
  )
  return { ...result, replayed }
}

/** PATCH /compliance/claims/:id: a draft only. */
export async function editClaim(caller: CommandCaller, claimId: string, body: ClaimBody & { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await caller.withClient((client) => readClaimRow(client, context, claimId))
  assertManage(context, before.companyId)
  if (before.status !== 'DRAFT') refuse('NOT_DRAFT', 'Only a draft claim changes; an approved claim is replaced by a new one (Draft a replacement).')
  const input = checked(before.code, body)
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.claims.edit', idempotencyKey, input: body, record: { type: 'SustainabilityClaim', id: before.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now } = tools
        const current = (await tx.sustainabilityClaim.findUniqueOrThrow({ where: { id: before.id }, select: CLAIM_SELECT })) as ClaimRow
        if (current.status !== 'DRAFT') refuse('NOT_DRAFT', 'Only a draft claim changes; an approved claim is replaced by a new one (Draft a replacement).')
        await assertNamed(tx, current.companyId, input, current)
        await tx.sustainabilityClaim.update({ where: { id: current.id }, data: { ...columns(input), updatedAt: now }, select: { id: true } })
        tools.audit({ action: 'compliance.claims.edit', recordType: 'SustainabilityClaim', recordId: current.id, companyId: current.companyId, before: auditedRow(current), after: { status: 'DRAFT', ...audited(input) } })
        changed(tools, current, 'DRAFT', 'EDITED')
        return { claim: await viewIn(tx, context, current.id) }
      },
      settings(),
    ),
  )
  return result
}

// ---- approve and withdraw ----------------------------------------------------------------------------------------------------

/** Why this draft cannot be approved now, from its evidence files as the reader sees them. */
async function approvalRefusal(db: Reader, row: ClaimRow, today: string): Promise<Refusal | null> {
  const files = await evidenceFiles(db, row.evidenceFileIds)
  return approveRefusal({ status: row.status, validUntil: dayOf(row.validUntil), evidenceFileIds: row.evidenceFileIds }, row.evidenceFileIds.map((id) => factOf(id, files.get(id))), today)
}

/** Ends a claim's live uses (the same command): the rows ended, for their events. */
async function endLiveUses(tx: CommandTx, claimId: string, at: Date, by: string | null) {
  const live = await tx.claimUse.findMany({ where: { claimId, endedAt: null }, select: USE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  for (const use of live) await tx.claimUse.update({ where: { id: use.id }, data: { endedAt: at, endedById: by, version: { increment: 1 }, updatedAt: at }, select: { id: true } })
  return live
}

export interface StepUp {
  readonly stepUp: () => void
  readonly idempotencyKey?: string | undefined
}

/** POST /compliance/claims/:id/approve: a fresh code, asked after every other check (a refused approval never asks). */
export async function approveClaim(caller: CommandCaller, claimId: string, body: { readonly version: number }, options: StepUp) {
  const context = officeOf(caller)
  const today = todayOf(claimsClock().now())
  const before = await caller.withClient((client) => readClaimRow(client, context, claimId))
  if (!mayApprove(context, before.companyId)) throw new ForbiddenError('A claim is approved by a role that approves claims (compliance.claims.approve).')
  refuseWith(await caller.withClient((client) => approvalRefusal(client, before, today)))
  options.stepUp()
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.claims.approve', idempotencyKey: options.idempotencyKey, input: body, record: { type: 'SustainabilityClaim', id: before.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now } = tools
        const current = (await tx.sustainabilityClaim.findUniqueOrThrow({ where: { id: before.id }, select: CLAIM_SELECT })) as ClaimRow
        refuseWith(await approvalRefusal(tx, current, todayOf(now)))
        await tx.sustainabilityClaim.update({ where: { id: current.id }, data: { status: 'APPROVED', approvedAt: now, approvedById: context.actorId, updatedAt: now }, select: { id: true } })
        let replaced: { id: string; code: string; usesMoved: number } | null = null
        if (current.supersedesId) {
          const old = (await tx.sustainabilityClaim.findUnique({ where: { id: current.supersedesId }, select: CLAIM_SELECT })) as ClaimRow | null
          if (old && old.status === 'APPROVED') {
            // The replacement takes over: the old claim is withdrawn and every place it is still used moves to the new one.
            const reason = `Replaced by ${current.code}.`
            await tx.sustainabilityClaim.update({ where: { id: old.id }, data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnById: context.actorId, withdrawReason: reason, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
            const moved = await endLiveUses(tx, old.id, now, context.actorId)
            for (const use of moved) {
              const useId = newId()
              await tx.claimUse.create({ data: { id: useId, claimId: current.id, kind: use.kind, recordType: use.recordType, recordId: use.recordId, label: use.label, note: use.note, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
              useChanged(tools, old, { ...use, kind: use.kind as UseKind }, 'ENDED')
              useChanged(tools, current, { id: useId, kind: use.kind as UseKind, recordType: use.recordType, recordId: use.recordId }, 'ADDED')
            }
            tools.audit({ action: 'compliance.claims.replaced', recordType: 'SustainabilityClaim', recordId: old.id, companyId: old.companyId, before: { status: 'APPROVED' }, after: { status: 'WITHDRAWN', replacedBy: current.code, usesMoved: moved.length }, reason })
            changed(tools, old, 'WITHDRAWN', 'REPLACED')
            replaced = { id: old.id, code: old.code, usesMoved: moved.length }
          }
        }
        tools.audit({ action: 'compliance.claims.approve', recordType: 'SustainabilityClaim', recordId: current.id, companyId: current.companyId, before: { status: 'DRAFT' }, after: { status: 'APPROVED', validUntil: dayOf(current.validUntil), evidenceFileIds: current.evidenceFileIds, ...(replaced ? { replaces: replaced.code, usesMoved: replaced.usesMoved } : {}) } })
        changed(tools, current, 'APPROVED', 'APPROVED')
        return { claim: await viewIn(tx, context, current.id), replaced }
      },
      settings(),
    ),
  )
  return result
}

/** POST /compliance/claims/:id/withdraw: a draft or an approved claim; its live uses end with it. */
export async function withdrawClaim(caller: CommandCaller, claimId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await caller.withClient((client) => readClaimRow(client, context, claimId))
  assertManage(context, before.companyId)
  if (before.status === 'WITHDRAWN') refuse('ALREADY_WITHDRAWN', 'This claim is withdrawn already.')
  const reason = body.reason.trim()
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.claims.withdraw', idempotencyKey, input: body, record: { type: 'SustainabilityClaim', id: before.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now } = tools
        const current = (await tx.sustainabilityClaim.findUniqueOrThrow({ where: { id: before.id }, select: CLAIM_SELECT })) as ClaimRow
        if (current.status === 'WITHDRAWN') refuse('ALREADY_WITHDRAWN', 'This claim is withdrawn already.')
        await tx.sustainabilityClaim.update({ where: { id: current.id }, data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnById: context.actorId, withdrawReason: reason, updatedAt: now }, select: { id: true } })
        const ended = await endLiveUses(tx, current.id, now, context.actorId)
        for (const use of ended) useChanged(tools, current, { ...use, kind: use.kind as UseKind }, 'ENDED')
        tools.audit({ action: 'compliance.claims.withdraw', recordType: 'SustainabilityClaim', recordId: current.id, companyId: current.companyId, before: { status: current.status }, after: { status: 'WITHDRAWN', usesEnded: ended.length }, reason })
        changed(tools, current, 'WITHDRAWN', 'WITHDRAWN')
        return { claim: await viewIn(tx, context, current.id), usesEnded: ended.length }
      },
      settings(),
    ),
  )
  return result
}

// ---- where it is used ------------------------------------------------------------------------------------------------------

export interface UseBody {
  readonly kind: UseKind
  readonly recordId: string
  readonly label?: string | null | undefined
  readonly note?: string | null | undefined
}

const USE_NOT_FOUND = 'Use of this claim not found.'

/** POST /compliance/claims/:id/uses: only while the claim is approved and its evidence holds. */
export async function addUse(caller: CommandCaller, claimId: string, body: UseBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const claim = await caller.withClient((client) => readClaimRow(client, context, claimId))
  assertManage(context, claim.companyId)
  const label = blankToNull(body.label)
  if ((body.kind === 'CATALOGUE' || body.kind === 'OTHER') && !label) throw problemsError([{ path: 'label', message: 'Name where it appears ("Autumn catalogue 2026").' }], 'Name where it appears.')
  const recordType = useRecordTypeOf(body.kind)
  const id = newId()
  const { result, replayed } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.claims.addUse', idempotencyKey, input: body },
      async (tools) => {
        const { tx, now } = tools
        const current = (await tx.sustainabilityClaim.findUniqueOrThrow({ where: { id: claim.id }, select: CLAIM_SELECT })) as ClaimRow
        const files = await evidenceFiles(tx, current.evidenceFileIds)
        refuseWith(useRefusal(stateOf(current, files, todayOf(now)).state))
        const record =
          recordType === 'Style'
            ? await tx.style.findUnique({ where: { id: body.recordId }, select: { companyId: true } })
            : await tx.labelTemplate.findUnique({ where: { id: body.recordId }, select: { companyId: true } })
        if (!record || (record.companyId !== null && record.companyId !== current.companyId)) refuse('USE_RECORD', recordType === 'Style' ? "The style is one of the claim's company's styles or a tenant-wide one." : "The label is one of the claim's company's label templates or a tenant-wide one.", 'recordId')
        if (await tx.claimUse.findFirst({ where: { claimId: current.id, kind: body.kind, recordType, recordId: body.recordId, endedAt: null }, select: { id: true } })) refuse('USE_TAKEN', 'This claim is recorded there already.', 'recordId')
        await tx.claimUse.create({ data: { id, claimId: current.id, kind: body.kind, recordType, recordId: body.recordId, label, note: blankToNull(body.note), createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
        tools.audit({ action: 'compliance.claims.addUse', recordType: 'SustainabilityClaim', recordId: current.id, companyId: current.companyId, after: { useId: id, kind: body.kind, recordType, label } })
        useChanged(tools, current, { id, kind: body.kind, recordType, recordId: body.recordId }, 'ADDED')
        const row = await tx.claimUse.findUniqueOrThrow({ where: { id }, select: USE_SELECT })
        return { use: (await useViews(tx, [row]))[0]! }
      },
      settings(),
    ),
  )
  return { ...result, replayed }
}

/** POST /compliance/claims/:id/uses/:useId/end. */
export async function endUse(caller: CommandCaller, claimId: string, useId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const claim = await caller.withClient((client) => readClaimRow(client, context, claimId))
  assertManage(context, claim.companyId)
  if (!isUuid(useId)) throw new NotFoundError(USE_NOT_FOUND)
  const use = await caller.withClient((client) => client.claimUse.findUnique({ where: { id: useId }, select: USE_SELECT }))
  if (!use || use.claimId !== claim.id) throw new NotFoundError(USE_NOT_FOUND)
  if (use.endedAt !== null) refuse('USE_ENDED', 'This use ended already.')
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.claims.endUse', idempotencyKey, input: body, record: { type: 'ClaimUse', id: use.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now } = tools
        const current = await tx.claimUse.findUniqueOrThrow({ where: { id: use.id }, select: USE_SELECT })
        if (current.endedAt !== null) refuse('USE_ENDED', 'This use ended already.')
        await tx.claimUse.update({ where: { id: use.id }, data: { endedAt: now, endedById: context.actorId, updatedAt: now }, select: { id: true } })
        tools.audit({ action: 'compliance.claims.endUse', recordType: 'SustainabilityClaim', recordId: claim.id, companyId: claim.companyId, after: { useId: use.id, kind: use.kind, recordType: use.recordType, label: use.label } })
        useChanged(tools, claim, { ...use, kind: use.kind as UseKind }, 'ENDED')
        const row = await tx.claimUse.findUniqueOrThrow({ where: { id: use.id }, select: USE_SELECT })
        return { use: (await useViews(tx, [row]))[0]! }
      },
      settings(),
    ),
  )
  return result
}
