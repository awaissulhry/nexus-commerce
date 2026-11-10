import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { SUBSTANCES_MANAGE } from '@nexus/factory-domain/compliance/substances/permissions'
import {
  ruleProblems,
  switchRefusal,
  type EvidenceKind,
  type LimitBound,
  type RuleCode,
  type RuleSource,
  type SubstanceStatus,
  type SubstanceUnit,
} from '@nexus/factory-domain/compliance/substances/rules'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { assertMayKeep, mayReadCompany, officeOf } from '../register-of-rules/common'
import { substanceReach, substancesClock, substancesGuarded, substancesSettings } from './common'
import { RULE_SELECT, ruleViews, type Reader, type RuleRow, type RuleView } from './store'

/**
 * The rules over the substance list (B-W2b-250; PRD-320 … PRD-325, PRD-329): azo dyes (entry 43), nickel release (27),
 * PAHs (50), DMFu (61), NPE (46a), CMR in clothing with the PPE and natural-leather exemptions (72), PFAS screening, Cr VI
 * (47), an industry list's and a brand's own. Each restricts one substance or a group, where (material kinds, product
 * types, markets), with its limit, unit and bound, the method, the evidence that proves it, its source and legal
 * reference. Reading needs compliance.certificates.view; keeping them compliance.substances.manage over the rule's company
 * (a tenant-wide rule: every company). A rule is switched off with the reason (CMR and PFAS stay off until a style or a
 * market needs them: Owner 11-09, question 5 A) and archived, never deleted; its key and company never change. Each write
 * is ONE command with its audit row and `compliance_substances.rule_changed`.
 */

const WHAT = 'A substance rule'

export interface ListQuery {
  readonly code?: RuleCode | undefined
  readonly source?: RuleSource | undefined
  readonly switchedOn?: boolean | undefined
  readonly status?: SubstanceStatus | 'ALL' | undefined
  readonly customerPartyId?: string | undefined
  readonly q?: string | undefined
}

/** GET /compliance/substances/rules */
export async function listRules(request: FastifyRequest, query: ListQuery) {
  const actor = actorOf(officeOf(request))
  const filters: Prisma.SubstanceRuleWhereInput[] = [substanceReach(actor) as Prisma.SubstanceRuleWhereInput]
  const status = query.status ?? 'ACTIVE'
  if (status !== 'ALL') filters.push({ status })
  if (query.code) filters.push({ code: query.code })
  if (query.source) filters.push({ source: query.source })
  if (query.switchedOn !== undefined) filters.push({ switchedOn: query.switchedOn })
  if (query.customerPartyId) filters.push({ customerPartyId: query.customerPartyId })
  if (query.q) filters.push({ OR: [{ key: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }, { legalReference: { contains: query.q, mode: 'insensitive' } }] })
  return request.withClient(async (db) => {
    const rows = await db.substanceRule.findMany({ where: { AND: filters }, select: RULE_SELECT, orderBy: [{ switchedOn: 'desc' }, { key: 'asc' }] })
    return { rules: await ruleViews(db, rows), asOf: toUtcIso(substancesClock().now()), mayManage: mayWrite(actor, SUBSTANCES_MANAGE, null) }
  })
}

async function readRule(db: Reader, caller: CommandCaller, ruleId: string): Promise<RuleRow> {
  const row = isUuid(ruleId) ? await db.substanceRule.findUnique({ where: { id: ruleId }, select: RULE_SELECT }) : null
  if (!row || !mayReadCompany(actorOf(officeOf(caller)), row.companyId)) throw new NotFoundError('There is no such substance rule.')
  return row
}

/** GET /compliance/substances/rules/:ruleId — the rule, the substances it restricts and the test plans that prove it. */
export async function getRule(request: FastifyRequest, ruleId: string) {
  return request.withClient(async (db) => {
    const row = await readRule(db, request, ruleId)
    const [rule] = await ruleViews(db, [row])
    const substances = await db.restrictedSubstance.findMany({
      where: row.substanceId ? { id: row.substanceId } : { groupCode: row.substanceGroup, status: 'ACTIVE' },
      select: { id: true, casNumber: true, ecNumber: true, name: true, status: true },
      orderBy: [{ name: 'asc' }],
    })
    const plans = await db.testPlanRule.findMany({ where: { substanceRuleId: ruleId }, select: { id: true, test: true, frequency: true, itemKind: true, itemId: true, marketCode: true, switchedOn: true, status: true }, orderBy: [{ test: 'asc' }, { id: 'asc' }] })
    return {
      rule: rule!,
      substances: substances.map((substance) => ({ ...substance, status: substance.status as SubstanceStatus })),
      testPlans: plans.map((plan) => ({ ...plan, status: plan.status as SubstanceStatus })),
      asOf: toUtcIso(substancesClock().now()),
    }
  })
}

const auditOf = (row: RuleRow) => ({
  key: row.key,
  code: row.code,
  name: row.name,
  substanceId: row.substanceId,
  substanceGroup: row.substanceGroup,
  materialKinds: [...row.materialKinds],
  productTypes: [...row.productTypes],
  marketCodes: [...row.marketCodes],
  limitValue: row.limitValue === null ? null : row.limitValue.toFixed(),
  limitUnit: row.limitUnit,
  limitBound: row.limitBound,
  testMethod: row.testMethod,
  evidence: row.evidence,
  exemptPpe: row.exemptPpe,
  exemptNaturalLeather: row.exemptNaturalLeather,
  source: row.source,
  customerPartyId: row.customerPartyId,
  legalReference: row.legalReference,
  legalUrl: row.legalUrl,
  switchedOn: row.switchedOn,
  offReason: row.offReason,
  status: row.status,
})

function check(issues: ReturnType<typeof ruleProblems>): void {
  if (issues.length > 0) throw new ValidationError('The substance rule is not valid.', issues)
}

/** The substance a rule names: on the list, ACTIVE, of the rule's company or tenant-wide; the brand: a party. */
async function assertReferences(tx: CommandTx, fields: { readonly companyId: string | null; readonly substanceId: string | null; readonly customerPartyId: string | null }, changed: { readonly substance: boolean; readonly customer: boolean }): Promise<void> {
  const issues = []
  if (changed.substance && fields.substanceId) {
    const substance = await tx.restrictedSubstance.findUnique({ where: { id: fields.substanceId }, select: { companyId: true, status: true } })
    if (!substance || substance.status !== 'ACTIVE') issues.push({ path: 'body/substanceId', message: 'Name an ACTIVE substance of the list.' })
    else if (substance.companyId !== null && substance.companyId !== fields.companyId) issues.push({ path: 'body/substanceId', message: "A rule restricts a substance of its own company or one for every company, never another company's." })
  }
  if (changed.customer && fields.customerPartyId && !(await tx.party.findUnique({ where: { id: fields.customerPartyId }, select: { id: true } }))) {
    issues.push({ path: 'body/customerPartyId', message: 'Name the brand by a party of the address book.' })
  }
  if (issues.length > 0) throw new ValidationError('The substance rule is not valid.', issues)
}

export interface RuleFields {
  readonly code?: RuleCode | undefined
  readonly name?: string | undefined
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly substanceId?: string | null | undefined
  readonly substanceGroup?: string | null | undefined
  readonly materialKinds?: readonly string[] | undefined
  readonly productTypes?: readonly string[] | undefined
  readonly marketCodes?: readonly string[] | undefined
  readonly scopeNote?: string | null | undefined
  readonly limitValue?: string | null | undefined
  readonly limitUnit?: SubstanceUnit | null | undefined
  readonly limitBound?: LimitBound | null | undefined
  readonly testMethod?: string | null | undefined
  readonly evidence?: EvidenceKind | undefined
  readonly exemptPpe?: boolean | undefined
  readonly exemptNaturalLeather?: boolean | undefined
  readonly source?: RuleSource | undefined
  readonly customerPartyId?: string | null | undefined
  readonly legalReference?: string | undefined
  readonly legalUrl?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface CreateBody extends RuleFields {
  readonly companyId?: string | null | undefined
  readonly key: string
  readonly code: RuleCode
  readonly name: string
  readonly evidence: EvidenceKind
  readonly legalReference: string
  readonly switchedOn?: boolean | undefined
  readonly offReason?: string | null | undefined
}

const takenWords = (key: string) => `A substance rule with key ${key} exists already: edit it, or give this one another key.`

/** POST /compliance/substances/rules — ON by default; OFF needs the reason. */
export async function createRule(caller: CommandCaller, body: CreateBody, key: string | null | undefined): Promise<{ rule: RuleView }> {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  assertMayKeep(context, SUBSTANCES_MANAGE, companyId, WHAT)
  const fields = {
    key: body.key,
    code: body.code,
    name: body.name,
    nameI18n: body.nameI18n ?? null,
    substanceId: body.substanceId ?? null,
    substanceGroup: body.substanceGroup ?? null,
    materialKinds: [...(body.materialKinds ?? [])],
    productTypes: [...(body.productTypes ?? [])],
    marketCodes: [...(body.marketCodes ?? [])],
    scopeNote: body.scopeNote ?? null,
    limitValue: body.limitValue ?? null,
    limitUnit: body.limitUnit ?? null,
    limitBound: body.limitBound ?? null,
    testMethod: body.testMethod ?? null,
    evidence: body.evidence,
    exemptPpe: body.exemptPpe ?? false,
    exemptNaturalLeather: body.exemptNaturalLeather ?? false,
    source: body.source ?? 'LAW',
    customerPartyId: body.customerPartyId ?? null,
    legalReference: body.legalReference,
    legalUrl: body.legalUrl ?? null,
    note: body.note ?? null,
  }
  check(ruleProblems(fields))
  const on = body.switchedOn ?? true
  if (!on && (body.offReason ?? '').trim().length < 3) {
    throw new ValidationError('The substance rule is not valid.', [{ path: 'body/offReason', message: 'A rule made switched off says why, in 3 to 500 characters (the question it waits for).' }])
  }
  const { result } = await substancesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.substances.createRule', idempotencyKey: key, input: body },
        async ({ tx, now, audit, emit }) => {
          if (await tx.substanceRule.findFirst({ where: { key: body.key }, select: { id: true } })) throw new ConflictError(takenWords(body.key))
          await assertReferences(tx, { companyId, substanceId: fields.substanceId, customerPartyId: fields.customerPartyId }, { substance: true, customer: true })
          const id = newId()
          const row = await tx.substanceRule.create({
            data: {
              id,
              companyId,
              ...fields,
              nameI18n: fields.nameI18n ?? undefined,
              materialKinds: fields.materialKinds as Prisma.SubstanceRuleCreateInput['materialKinds'],
              productTypes: fields.productTypes as Prisma.SubstanceRuleCreateInput['productTypes'],
              switchedOn: on,
              offReason: on ? null : body.offReason!.trim(),
              ...(on ? {} : { switchedAt: now, switchedById: context.actorId }),
              createdAt: now,
              updatedAt: now,
              createdById: context.actorId,
            },
            select: RULE_SELECT,
          })
          audit({ recordType: 'SubstanceRule', recordId: id, companyId, after: auditOf(row) })
          emit({ type: 'compliance_substances.rule_changed', subject: id, companyId, payload: { ruleId: id, key: row.key, code: row.code as RuleCode, switchedOn: row.switchedOn, change: 'CREATED', by: 'PERSON' } })
          return { rule: (await ruleViews(tx, [row]))[0]! }
        },
        substancesSettings(),
      ),
    { taken: takenWords(body.key) },
  )
  return result
}

export interface EditBody extends RuleFields {
  readonly version: number
  readonly status?: SubstanceStatus | undefined
}

/** PATCH /compliance/substances/rules/:ruleId — edit, archive (status ARCHIVED) or restore (ACTIVE); key and company fixed. */
export async function editRule(caller: CommandCaller, ruleId: string, body: EditBody, key: string | null | undefined): Promise<{ rule: RuleView }> {
  const context = officeOf(caller)
  const current = await caller.withClient((db) => readRule(db, caller, ruleId))
  assertMayKeep(context, SUBSTANCES_MANAGE, current.companyId, WHAT)
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.substances.editRule', idempotencyKey: key, input: { ruleId, ...body }, record: { type: 'SubstanceRule', id: ruleId, expectedVersion: body.version } },
      async ({ tx, now, audit, emit }) => {
        const before = await tx.substanceRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_SELECT })
        const pick = <K extends keyof RuleFields>(name: K, now: RuleFields[K]): RuleFields[K] => (body[name] !== undefined ? body[name] : now)
        // A substance replaces the group and the reverse; a source other than CUSTOMER drops the brand.
        const substanceGiven = body.substanceId !== undefined && body.substanceId !== null
        const groupGiven = body.substanceGroup !== undefined && body.substanceGroup !== null
        const source = pick('source', before.source as RuleSource)!
        const next = {
          key: before.key,
          code: pick('code', before.code as RuleCode)!,
          name: pick('name', before.name)!,
          nameI18n: pick('nameI18n', before.nameI18n as Record<string, string> | null) ?? null,
          substanceId: substanceGiven ? body.substanceId! : groupGiven ? null : before.substanceId,
          substanceGroup: groupGiven ? body.substanceGroup! : substanceGiven ? null : before.substanceGroup,
          materialKinds: [...(pick('materialKinds', before.materialKinds) ?? [])],
          productTypes: [...(pick('productTypes', before.productTypes) ?? [])],
          marketCodes: [...(pick('marketCodes', before.marketCodes) ?? [])],
          scopeNote: pick('scopeNote', before.scopeNote) ?? null,
          limitValue: pick('limitValue', before.limitValue === null ? null : before.limitValue.toFixed()) ?? null,
          limitUnit: pick('limitUnit', before.limitUnit as SubstanceUnit | null) ?? null,
          limitBound: pick('limitBound', before.limitBound as LimitBound | null) ?? null,
          testMethod: pick('testMethod', before.testMethod) ?? null,
          evidence: pick('evidence', before.evidence as EvidenceKind)!,
          exemptPpe: pick('exemptPpe', before.exemptPpe)!,
          exemptNaturalLeather: pick('exemptNaturalLeather', before.exemptNaturalLeather)!,
          source,
          customerPartyId: source === 'CUSTOMER' ? (pick('customerPartyId', before.customerPartyId) ?? null) : null,
          legalReference: pick('legalReference', before.legalReference)!,
          legalUrl: pick('legalUrl', before.legalUrl) ?? null,
          note: pick('note', before.note) ?? null,
        }
        check(ruleProblems(next))
        await assertReferences(tx, { companyId: before.companyId, substanceId: next.substanceId, customerPartyId: next.customerPartyId }, { substance: next.substanceId !== before.substanceId, customer: next.customerPartyId !== before.customerPartyId })
        const status = body.status ?? (before.status as SubstanceStatus)
        const { key: _key, nameI18n, ...data } = next
        // A JSON column is cleared to the database's NULL by its own statement (Prisma would write a JSON null).
        if (nameI18n === null && before.nameI18n !== null) await tx.$executeRaw`UPDATE "SubstanceRule" SET "nameI18n" = NULL WHERE "id" = ${ruleId}::uuid`
        const row = await tx.substanceRule.update({
          where: { id: ruleId },
          data: {
            ...data,
            ...(nameI18n !== null ? { nameI18n } : {}),
            materialKinds: data.materialKinds as Prisma.SubstanceRuleUpdateInput['materialKinds'],
            productTypes: data.productTypes as Prisma.SubstanceRuleUpdateInput['productTypes'],
            status,
            updatedAt: now,
          },
          select: RULE_SELECT,
        })
        const change = status !== before.status ? (status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED') : 'EDITED'
        audit({ recordType: 'SubstanceRule', recordId: ruleId, companyId: row.companyId, before: auditOf(before), after: auditOf(row) })
        emit({ type: 'compliance_substances.rule_changed', subject: ruleId, companyId: row.companyId, payload: { ruleId, key: row.key, code: row.code as RuleCode, switchedOn: row.switchedOn, change, by: 'PERSON' } })
        return { rule: (await ruleViews(tx, [row]))[0]! }
      },
      substancesSettings(),
    ),
  )
  return result
}

/** PUT /compliance/substances/rules/:ruleId/switch {version, on, reason?} — OFF with the reason; every switch with its time and who. */
export async function switchRule(caller: CommandCaller, ruleId: string, body: { readonly version: number; readonly on: boolean; readonly reason?: string | null | undefined }, key: string | null | undefined): Promise<{ rule: RuleView }> {
  const context = officeOf(caller)
  const current = await caller.withClient((db) => readRule(db, caller, ruleId))
  assertMayKeep(context, SUBSTANCES_MANAGE, current.companyId, WHAT)
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.substances.switchRule', idempotencyKey: key, input: { ruleId, ...body }, record: { type: 'SubstanceRule', id: ruleId, expectedVersion: body.version } },
      async ({ tx, now, audit, emit }) => {
        const before = await tx.substanceRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_SELECT })
        const refusal = switchRefusal({ key: before.key, switchedOn: before.switchedOn, status: before.status as SubstanceStatus }, body.on, body.reason)
        if (refusal) {
          if (before.switchedOn === body.on || before.status !== 'ACTIVE') throw new ConflictError(refusal)
          throw new ValidationError(refusal, [{ path: 'body/reason', message: refusal }])
        }
        // The database wants a new time with every switch: within the same millisecond, the next one.
        const at = before.switchedAt && before.switchedAt.getTime() >= now.getTime() ? new Date(before.switchedAt.getTime() + 1) : now
        const row = await tx.substanceRule.update({
          where: { id: ruleId },
          data: { switchedOn: body.on, offReason: body.on ? null : body.reason!.trim(), switchedAt: at, switchedById: context.actorId, updatedAt: now },
          select: RULE_SELECT,
        })
        audit({ recordType: 'SubstanceRule', recordId: ruleId, companyId: row.companyId, before: { switchedOn: before.switchedOn, offReason: before.offReason }, after: { switchedOn: row.switchedOn, offReason: row.offReason }, ...(body.on ? {} : { reason: row.offReason! }) })
        emit({ type: 'compliance_substances.rule_changed', subject: ruleId, companyId: row.companyId, payload: { ruleId, key: row.key, code: row.code as RuleCode, switchedOn: row.switchedOn, change: 'SWITCHED', by: 'PERSON' } })
        return { rule: (await ruleViews(tx, [row]))[0]! }
      },
      substancesSettings(),
    ),
  )
  return result
}
