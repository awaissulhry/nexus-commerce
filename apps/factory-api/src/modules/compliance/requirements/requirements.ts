import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { REQUIREMENTS_MANAGE } from '@nexus/factory-domain/compliance/requirements/permissions'
import {
  COMPLIANCE_GATES,
  isCertificateCoverage,
  lockedProblems,
  looseningOf,
  requirementProblems,
  switchRefusal,
  type ComplianceGate,
  type Editable,
  type LooseningEntry,
  type ProductType,
  type RequirementKind,
} from '@nexus/factory-domain/compliance/requirements/rules'
import type { PpeCategory } from '@nexus/factory-domain/compliance/cert-gate/gate'
import type { OperatorRole } from '@nexus/factory-domain/compliance/operators/rules'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { assertMayKeep, companyReach, mayReadCompany, officeOf, rulesClock, rulesGuarded, type Reader } from '../register-of-rules/common'
import { builtInView, ensureW1Requirement, REQUIREMENT_SELECT, requirementViews, rowOf, type RequirementRecord } from './store'

/**
 * Requirements (B-W2b-254; PRD-271, PRD-272; design compliance.settings › rm-gates "Which requirement blocks what", the
 * padlocks, "who may override soft gates and for how long", rm-loosen "Confirm a looser rule"): per product type, PPE
 * category and market, what is needed, the law, the check, which gates it blocks, who may override it and for how many
 * days, ON or OFF with the reason. One row per code in the tenant; archived, never deleted.
 *
 * Reading needs compliance.certificates.view (the requirements of the companies a person's grants reach and every
 * company's); keeping one needs compliance.requirements.manage over its company (every company for a requirement of every
 * company). Tightening is a plain write; LOOSENING (a gate no longer blocked, a role that may now override, a longer
 * override, switched off, archived, a narrower scope, a shorter period, another check) asks the person's step-up first.
 * The law's padlocks never open (said in words here; the database refuses them for every login too). Each write is ONE
 * command on the requirement's version, with its audit row (the loosenings named) and `compliance_gates.requirement_changed`.
 */

const WHAT = 'A requirement'
const settings = () => ({ ...COMMAND_SETTINGS, clock: rulesClock() })
const ORDER = [{ seq: 'asc' }, { code: 'asc' }] as const satisfies Prisma.ComplianceRequirementOrderByWithRelationInput[]

const editableOf = (record: RequirementRecord): Editable => {
  const row = rowOf(record)
  return {
    kind: row.kind,
    checkKey: row.checkKey,
    operatorRole: row.operatorRole,
    productTypes: row.productTypes,
    productTypeProfileId: row.productTypeProfileId,
    ppeCategories: row.ppeCategories,
    marketCode: row.marketCode,
    blocks: row.blocks,
    lockedBlocks: row.lockedBlocks,
    overrideRoleKeys: row.overrideRoleKeys,
    overrideMaxDays: row.overrideMaxDays,
    appliesFrom: row.appliesFrom,
    appliesUntil: row.appliesUntil,
    switchedOn: row.switchedOn,
    status: row.status,
  }
}

const auditOf = (record: RequirementRecord) => {
  const row = rowOf(record)
  return {
    code: row.code,
    name: row.name,
    companyId: row.companyId,
    kind: row.kind,
    checkKey: row.checkKey,
    operatorRole: row.operatorRole,
    productTypes: row.productTypes,
    productTypeProfileId: row.productTypeProfileId,
    ppeCategories: row.ppeCategories,
    marketCode: row.marketCode,
    blocks: row.blocks,
    lockedBlocks: row.lockedBlocks,
    overrideRoleKeys: row.overrideRoleKeys,
    overrideMaxDays: row.overrideMaxDays,
    legalReference: row.legalReference,
    appliesFrom: row.appliesFrom,
    appliesUntil: row.appliesUntil,
    seq: row.seq,
    switchedOn: row.switchedOn,
    status: row.status,
  }
}

function changed(tools: CommandTools, record: RequirementRecord, change: 'CREATED' | 'EDITED' | 'SWITCHED' | 'ARCHIVED' | 'RESTORED', loosened: boolean): void {
  tools.emit({
    type: 'compliance_gates.requirement_changed',
    subject: record.id,
    companyId: record.companyId,
    payload: { requirementId: record.id, code: record.code, change, switchedOn: record.switchedOn, loosened },
  })
}

const dateOf = (day: string | null | undefined): Date | null | undefined => (day === undefined ? undefined : day === null ? null : new Date(`${day}T00:00:00.000Z`))

/** The readable rows (the companies the person's grants reach and every company's). */
async function readable(db: Reader, context: OfficeContext, where: Prisma.ComplianceRequirementWhereInput = {}): Promise<RequirementRecord[]> {
  return db.complianceRequirement.findMany({ where: { AND: [companyReach(actorOf(context)) as Prisma.ComplianceRequirementWhereInput, where] }, select: REQUIREMENT_SELECT, orderBy: [...ORDER] })
}

/** GET /compliance/requirements */
export async function listRequirements(request: FastifyRequest, query: { readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined; readonly market?: string | undefined; readonly gate?: ComplianceGate | undefined }) {
  const context = officeOf(request)
  const status = query.status ?? 'ACTIVE'
  return request.withClient(async (db) => {
    const all = await db.complianceRequirement.findMany({ select: { kind: true, checkKey: true } })
    const records = await readable(db, context, {
      ...(status === 'ALL' ? {} : { status }),
      ...(query.market ? { OR: [{ marketCode: null }, { marketCode: query.market }] } : {}),
      ...(query.gate ? { blocks: { has: query.gate } } : {}),
    })
    const views = await requirementViews(db, records)
    const builtIn = !all.some((row) => isCertificateCoverage({ kind: row.kind as RequirementKind, checkKey: row.checkKey })) && status !== 'ARCHIVED' && (!query.gate || builtInView().blocks.includes(query.gate))
    return { requirements: builtIn ? [builtInView(), ...views] : views, asOf: toUtcIso(rulesClock().now()), mayManage: mayWrite(actorOf(context), REQUIREMENTS_MANAGE, null) }
  })
}

/** GET /compliance/requirements/gates — the gate matrix (rm-gates): requirement × place, padlocks, who may override. */
export async function gateMatrix(request: FastifyRequest) {
  const context = officeOf(request)
  const actor = actorOf(context)
  return request.withClient(async (db) => {
    const all = await db.complianceRequirement.findMany({ select: { kind: true, checkKey: true } })
    const views = await requirementViews(db, await readable(db, context, { status: 'ACTIVE' }))
    const rows = [...(all.some((row) => isCertificateCoverage({ kind: row.kind as RequirementKind, checkKey: row.checkKey })) ? [] : [builtInView()]), ...views]
    return {
      gates: [...COMPLIANCE_GATES],
      rows: rows.map((requirement) => ({
        requirement,
        cells: COMPLIANCE_GATES.map((gate) => ({ gate, blocks: requirement.blocks.includes(gate), locked: requirement.lockedBlocks.includes(gate) })),
        overrideRoleKeys: [...requirement.overrideRoleKeys],
        overrideMaxDays: requirement.overrideMaxDays,
        mayLoosen: requirement.id !== null && mayWrite(actor, REQUIREMENTS_MANAGE, requirement.companyId),
      })),
      asOf: toUtcIso(rulesClock().now()),
      mayManage: mayWrite(actor, REQUIREMENTS_MANAGE, null),
    }
  })
}

async function readRequirement(db: Reader, context: OfficeContext, code: string): Promise<RequirementRecord> {
  const record = await db.complianceRequirement.findFirst({ where: { code }, select: REQUIREMENT_SELECT })
  if (!record || !mayReadCompany(actorOf(context), record.companyId)) throw new NotFoundError(`There is no requirement ${code}.`)
  return record
}

/** GET /compliance/requirements/:code */
export async function getRequirement(request: FastifyRequest, code: string) {
  const context = officeOf(request)
  return request.withClient(async (db) => ({ requirement: (await requirementViews(db, [await readRequirement(db, context, code)]))[0]! }))
}

function check(problems: ReturnType<typeof requirementProblems>): void {
  if (problems.length > 0) throw new ValidationError('The requirement is not valid.', problems)
}

/** The market, product type and register entry a requirement names exist (the database checks them too). */
async function assertNamed(db: Reader, input: { readonly marketCode?: string | null | undefined; readonly productTypeProfileId?: string | null | undefined; readonly regulationId?: string | null | undefined; readonly companyId?: string | null | undefined }): Promise<void> {
  const problems: { path: string; message: string }[] = []
  if (input.marketCode && !(await db.marketProfile.findFirst({ where: { code: input.marketCode }, select: { id: true } }))) problems.push({ path: 'body/marketCode', message: `There is no market ${input.marketCode}: add it in Rules & markets first.` })
  if (input.productTypeProfileId && !(await db.productTypeProfile.findUnique({ where: { id: input.productTypeProfileId }, select: { id: true } }))) problems.push({ path: 'body/productTypeProfileId', message: 'There is no such product type.' })
  if (input.regulationId && !(await db.regulationOrStandard.findUnique({ where: { id: input.regulationId }, select: { id: true } }))) problems.push({ path: 'body/regulationId', message: 'There is no such entry in the register.' })
  if (input.companyId && !(await db.company.findUnique({ where: { id: input.companyId }, select: { id: true } }))) problems.push({ path: 'body/companyId', message: 'Company not found.' })
  if (problems.length > 0) throw new ValidationError('The requirement is not valid.', problems)
}

export interface CreateBody {
  readonly code: string
  readonly companyId?: string | null | undefined
  readonly kind: RequirementKind
  readonly name: string
  readonly legalReference: string
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly checkKey?: string | null | undefined
  readonly operatorRole?: OperatorRole | null | undefined
  readonly productTypes?: ProductType[] | undefined
  readonly productTypeProfileId?: string | null | undefined
  readonly ppeCategories?: PpeCategory[] | undefined
  readonly marketCode?: string | null | undefined
  readonly blocks?: ComplianceGate[] | undefined
  readonly lockedBlocks?: ComplianceGate[] | undefined
  readonly overrideRoleKeys?: string[] | undefined
  readonly overrideMaxDays?: number | undefined
  readonly regulationId?: string | null | undefined
  readonly explanationI18n?: Record<string, string> | null | undefined
  readonly appliesFrom?: string | null | undefined
  readonly appliesUntil?: string | null | undefined
  readonly seq?: number | undefined
  readonly note?: string | null | undefined
  readonly switchedOn?: boolean | undefined
  readonly offReason?: string | undefined
}

const takenWords = (code: string) => `There is a requirement ${code} already (perhaps archived): edit or restore it.`

/** POST /compliance/requirements — a new requirement (tightening: no step-up). */
export async function createRequirement(caller: CommandCaller, body: CreateBody, key: string | null | undefined): Promise<{ requirement: Awaited<ReturnType<typeof requirementViews>>[number] }> {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  assertMayKeep(context, REQUIREMENTS_MANAGE, companyId, WHAT)
  check(requirementProblems({ ...body, operatorRole: body.operatorRole ?? null }))
  const on = body.switchedOn ?? true
  if (on && body.offReason) throw new ValidationError('The requirement is not valid.', [{ path: 'body/offReason', message: 'A requirement switched on names no reason to be off.' }])
  if (!on && !body.offReason) throw new ValidationError('The requirement is not valid.', [{ path: 'body/offReason', message: 'Say why the requirement is off (the Owner question it waits for).' }])
  if (!on && (body.lockedBlocks ?? []).length > 0) throw new ValidationError('The requirement is not valid.', [{ path: 'body/switchedOn', message: 'A requirement the law locks at a gate is never switched off.' }])
  await caller.withClient((db) => assertNamed(db, { ...body, companyId }))
  const { result } = await rulesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.requirements.create', idempotencyKey: key, input: body },
        async (tools) => {
          const { tx, now, audit } = tools
          if (await tx.complianceRequirement.findFirst({ where: { code: body.code }, select: { id: true } })) throw new ConflictError(takenWords(body.code))
          const id = newId()
          const record = await tx.complianceRequirement.create({
            data: {
              id,
              code: body.code,
              companyId,
              name: body.name,
              ...(body.nameI18n ? { nameI18n: body.nameI18n } : {}),
              kind: body.kind,
              checkKey: body.checkKey ?? null,
              operatorRole: body.operatorRole ?? null,
              productTypes: body.productTypes ?? [],
              productTypeProfileId: body.productTypeProfileId ?? null,
              ppeCategories: body.ppeCategories ?? [],
              marketCode: body.marketCode ?? null,
              blocks: body.blocks ?? [],
              lockedBlocks: body.lockedBlocks ?? [],
              overrideRoleKeys: body.overrideRoleKeys ?? [],
              overrideMaxDays: body.overrideMaxDays ?? 7,
              legalReference: body.legalReference,
              regulationId: body.regulationId ?? null,
              ...(body.explanationI18n ? { explanationI18n: body.explanationI18n } : {}),
              appliesFrom: dateOf(body.appliesFrom) ?? null,
              appliesUntil: dateOf(body.appliesUntil) ?? null,
              seq: body.seq ?? 0,
              note: body.note ?? null,
              switchedOn: on,
              offReason: on ? null : body.offReason!,
              switchedAt: now,
              switchedById: context.actorId,
              createdAt: now,
              updatedAt: now,
              createdById: context.actorId,
            },
            select: REQUIREMENT_SELECT,
          })
          audit({ recordType: 'ComplianceRequirement', recordId: id, companyId, after: auditOf(record), ...(on ? {} : { reason: body.offReason! }) })
          changed(tools, record, 'CREATED', false)
          return { requirement: (await requirementViews(tx, [record]))[0]! }
        },
        settings(),
      ),
    { taken: takenWords(body.code) },
  )
  return result
}

export interface EditBody {
  readonly version: number
  readonly kind?: RequirementKind | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined
  readonly name?: string | undefined
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly checkKey?: string | null | undefined
  readonly operatorRole?: OperatorRole | null | undefined
  readonly productTypes?: ProductType[] | undefined
  readonly productTypeProfileId?: string | null | undefined
  readonly ppeCategories?: PpeCategory[] | undefined
  readonly marketCode?: string | null | undefined
  readonly blocks?: ComplianceGate[] | undefined
  readonly lockedBlocks?: ComplianceGate[] | undefined
  readonly overrideRoleKeys?: string[] | undefined
  readonly overrideMaxDays?: number | undefined
  readonly legalReference?: string | undefined
  readonly regulationId?: string | null | undefined
  readonly explanationI18n?: Record<string, string> | null | undefined
  readonly appliesFrom?: string | null | undefined
  readonly appliesUntil?: string | null | undefined
  readonly seq?: number | undefined
  readonly note?: string | null | undefined
}

/** The requirement at the version the person read (the version bump is command()'s). */
async function guardedRequirement(caller: CommandCaller, context: OfficeContext, code: string): Promise<RequirementRecord> {
  const record = await caller.withClient((db) => readRequirement(db, context, code))
  assertMayKeep(context, REQUIREMENTS_MANAGE, record.companyId, WHAT)
  return record
}

function refuseLocked(before: Editable, after: Editable): void {
  const problems = lockedProblems(before, after)
  if (problems.length > 0) throw new DomainError('conflict', problems[0]!.message, problems)
}

/**
 * PATCH /compliance/requirements/:code — new words, scope, gates, override rules, dates or ARCHIVED / ACTIVE. A change
 * that loosens asks `stepUp()` first (403 `stepUp` without a fresh one); the law's padlocks are refused in words (409).
 */
export async function editRequirement(caller: CommandCaller, code: string, body: EditBody, key: string | null | undefined, stepUp: () => void): Promise<{ requirement: Awaited<ReturnType<typeof requirementViews>>[number]; loosened: LooseningEntry[] }> {
  const context = officeOf(caller)
  const known = await guardedRequirement(caller, context, code)
  const before = editableOf(known)
  const after: Editable = {
    kind: body.kind ?? before.kind,
    checkKey: body.checkKey !== undefined ? body.checkKey : before.checkKey,
    operatorRole: body.operatorRole !== undefined ? body.operatorRole : before.operatorRole,
    productTypes: body.productTypes ?? before.productTypes,
    productTypeProfileId: body.productTypeProfileId !== undefined ? body.productTypeProfileId : before.productTypeProfileId,
    ppeCategories: body.ppeCategories ?? before.ppeCategories,
    marketCode: body.marketCode !== undefined ? body.marketCode : before.marketCode,
    blocks: body.blocks ?? before.blocks,
    lockedBlocks: body.lockedBlocks ?? before.lockedBlocks,
    overrideRoleKeys: body.overrideRoleKeys ?? before.overrideRoleKeys,
    overrideMaxDays: body.overrideMaxDays ?? before.overrideMaxDays,
    appliesFrom: body.appliesFrom !== undefined ? body.appliesFrom : before.appliesFrom,
    appliesUntil: body.appliesUntil !== undefined ? body.appliesUntil : before.appliesUntil,
    switchedOn: before.switchedOn,
    status: body.status ?? before.status,
  }
  check(requirementProblems({ ...body, ...after, name: body.name, legalReference: body.legalReference }))
  refuseLocked(before, after)
  await caller.withClient((db) => assertNamed(db, body))
  const loosened = looseningOf(before, after)
  if (loosened.length > 0) stepUp()
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.requirements.edit', idempotencyKey: key, input: { code, ...body }, record: { type: 'ComplianceRequirement', id: known.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const stored = await tx.complianceRequirement.findUniqueOrThrow({ where: { id: known.id }, select: REQUIREMENT_SELECT })
        // Checked again on the row as it is now (the version guard already refused a stale read).
        refuseLocked(editableOf(stored), after)
        const record = await tx.complianceRequirement.update({
          where: { id: known.id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.nameI18n !== undefined ? { nameI18n: body.nameI18n === null ? (null as unknown as Prisma.InputJsonValue) : body.nameI18n } : {}),
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            ...(body.checkKey !== undefined ? { checkKey: body.checkKey } : {}),
            ...(body.operatorRole !== undefined ? { operatorRole: body.operatorRole } : {}),
            ...(body.productTypes !== undefined ? { productTypes: body.productTypes } : {}),
            ...(body.productTypeProfileId !== undefined ? { productTypeProfileId: body.productTypeProfileId } : {}),
            ...(body.ppeCategories !== undefined ? { ppeCategories: body.ppeCategories } : {}),
            ...(body.marketCode !== undefined ? { marketCode: body.marketCode } : {}),
            ...(body.blocks !== undefined ? { blocks: body.blocks } : {}),
            ...(body.lockedBlocks !== undefined ? { lockedBlocks: body.lockedBlocks } : {}),
            ...(body.overrideRoleKeys !== undefined ? { overrideRoleKeys: body.overrideRoleKeys } : {}),
            ...(body.overrideMaxDays !== undefined ? { overrideMaxDays: body.overrideMaxDays } : {}),
            ...(body.legalReference !== undefined ? { legalReference: body.legalReference } : {}),
            ...(body.regulationId !== undefined ? { regulationId: body.regulationId } : {}),
            ...(body.explanationI18n !== undefined ? { explanationI18n: body.explanationI18n === null ? (null as unknown as Prisma.InputJsonValue) : body.explanationI18n } : {}),
            ...(body.appliesFrom !== undefined ? { appliesFrom: dateOf(body.appliesFrom) } : {}),
            ...(body.appliesUntil !== undefined ? { appliesUntil: dateOf(body.appliesUntil) } : {}),
            ...(body.seq !== undefined ? { seq: body.seq } : {}),
            ...(body.note !== undefined ? { note: body.note } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            updatedAt: now,
          },
          select: REQUIREMENT_SELECT,
        })
        audit({ recordType: 'ComplianceRequirement', recordId: record.id, companyId: record.companyId, before: auditOf(stored), after: { ...auditOf(record), ...(loosened.length > 0 ? { loosened: loosened.map((entry) => entry.code) } : {}) } })
        changed(tools, record, stored.status !== record.status ? (record.status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED') : 'EDITED', loosened.length > 0)
        return { requirement: (await requirementViews(tx, [record]))[0]!, loosened }
      },
      settings(),
    ),
  )
  return result
}

/** PUT /compliance/requirements/:code/switch — ON, or OFF with the reason (OFF loosens: step-up). */
export async function switchRequirement(caller: CommandCaller, code: string, body: { readonly version: number; readonly on: boolean; readonly reason?: string | undefined }, key: string | null | undefined, stepUp: () => void) {
  const context = officeOf(caller)
  const known = await guardedRequirement(caller, context, code)
  const refusal = switchRefusal({ code, on: body.on, switchedOn: known.switchedOn, locked: known.lockedBlocks.length > 0, reason: body.reason })
  if (refusal) throw new DomainError(refusal.code === 'REASON_NEEDED' ? 'validation_failed' : 'conflict', refusal.message, [{ path: refusal.code === 'REASON_NEEDED' ? 'body/reason' : `refusal/${refusal.code}`, message: refusal.message }])
  if (!body.on) stepUp()
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.requirements.switch', idempotencyKey: key, input: { code, ...body }, record: { type: 'ComplianceRequirement', id: known.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const before = await tx.complianceRequirement.findUniqueOrThrow({ where: { id: known.id }, select: REQUIREMENT_SELECT })
        const again = switchRefusal({ code, on: body.on, switchedOn: before.switchedOn, locked: before.lockedBlocks.length > 0, reason: body.reason })
        if (again) throw new DomainError('conflict', again.message, [{ path: `refusal/${again.code}`, message: again.message }])
        // The database wants a new time with every switch: two switches within one millisecond take the next one.
        const at = before.switchedAt && before.switchedAt.getTime() >= now.getTime() ? new Date(before.switchedAt.getTime() + 1) : now
        const record = await tx.complianceRequirement.update({
          where: { id: known.id },
          data: { switchedOn: body.on, offReason: body.on ? null : body.reason!.trim(), switchedAt: at, switchedById: context.actorId, updatedAt: now },
          select: REQUIREMENT_SELECT,
        })
        audit({
          recordType: 'ComplianceRequirement',
          recordId: record.id,
          companyId: record.companyId,
          before: { switchedOn: before.switchedOn, offReason: before.offReason },
          after: { switchedOn: record.switchedOn, offReason: record.offReason, ...(body.on ? {} : { loosened: ['SWITCHED_OFF'] }) },
          ...(body.reason ? { reason: body.reason.trim() } : {}),
        })
        changed(tools, record, 'SWITCHED', !body.on)
        return { requirement: (await requirementViews(tx, [record]))[0]! }
      },
      settings(),
    ),
  )
  return result
}

/**
 * POST /compliance/requirements/w1 — W1's two gates written as their requirement row now (the gate also writes it on its
 * first refusal). Needs compliance.requirements.manage over every company; answers the row (created false: it existed).
 */
export async function writeW1Requirement(caller: CommandCaller, key: string | null | undefined) {
  const context = officeOf(caller)
  assertMayKeep(context, REQUIREMENTS_MANAGE, null, WHAT)
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.requirements.writeW1', idempotencyKey: key, input: {} },
      async (tools) => {
        const { tx, now, audit } = tools
        const written = await ensureW1Requirement(tx, context.tenantId, now)
        const record = await tx.complianceRequirement.findUniqueOrThrow({ where: { id: written.id }, select: REQUIREMENT_SELECT })
        audit({ recordType: 'ComplianceRequirement', recordId: record.id, companyId: record.companyId, after: { ...auditOf(record), ...(written.created ? {} : { unchanged: true }) } })
        if (written.created) changed(tools, record, 'CREATED', false)
        return { requirement: (await requirementViews(tx, [record]))[0]!, created: written.created }
      },
      settings(),
    ),
  )
  return result
}
