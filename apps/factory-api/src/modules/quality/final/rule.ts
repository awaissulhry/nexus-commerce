import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_SETTINGS_MANAGE } from '@nexus/factory-domain/quality/lab/permissions'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { reasonProblem } from '@nexus/factory-domain/quality/final/rules'
import { FOUR_EYES_WORDS, fourEyesInForce, isFourEyesLoosening, type FourEyesRow, type FourEyesRule } from '@nexus/factory-domain/quality/release/rules'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { ruleFor } from '../lab/read'
import { officeOf } from './access'
import { fourEyesRows, type Reader } from './store'

/**
 * Four eyes on the final release as a setting (Owner answer Q1 (a); design quality.settings): who releases finished
 * garments — WHEN_REQUIRED (the default: an inspector who made none of them releases alone; a second person for overrides
 * and the listed customers) or ALWAYS — and the customers whose garments always need a second person, for a company or
 * tenant-wide (the company's rule wins; both lists apply). Kept on QualitySettings beside B-W1-34's Cr VI evidence rule
 * (the row's id: the company's, or the tenant's own for the tenant-wide row); creating the row for this keeps the Cr VI
 * rule in force as it was.
 *
 *   GET /quality/release-rule?companyId   quality.inspections.view over the company (tenant-wide: any grant)
 *   PUT /quality/release-rule             quality.settings.manage over the company (tenant-wide: a grant over every
 *                                         company), `version` = the row's version read (0: never saved). Loosening (ALWAYS →
 *                                         WHEN_REQUIRED, or a customer taken off a list) asks for a reason and a fresh code;
 *                                         tightening never does. The database checks the customers again
 *                                         (…_quality_final_release_guards).
 */

type Row = Awaited<ReturnType<typeof fourEyesRows>>['company']
const fourEyesOf = (row: Row): FourEyesRow | null => (row ? { releaseFourEyes: (row.releaseFourEyes ?? null) as FourEyesRule | null, secondPersonPartyIds: row.secondPersonPartyIds ?? [] } : null)

async function assertCompany(caller: CommandCaller, companyId: string): Promise<void> {
  const context = officeOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !(can(actorOf(context), QUALITY_INSPECTIONS_VIEW, { companyId }) || can(actorOf(context), QUALITY_SETTINGS_MANAGE, { companyId }))) throw new NotFoundError('Company not found.')
}

async function ruleView(db: Reader, tenantId: string, companyId: string | null) {
  const rows = await fourEyesRows(db, tenantId, companyId)
  const company = fourEyesOf(rows.company)
  const tenant = fourEyesOf(rows.tenant)
  const inForce = companyId === null ? fourEyesInForce(null, tenant) : fourEyesInForce(company, tenant)
  const ownRow = companyId === null ? rows.tenant : rows.company
  const own = companyId === null ? tenant : company
  const listed = [...(companyId === null ? [] : (company?.secondPersonPartyIds ?? []).map((id) => ({ id, listedOn: 'COMPANY' as const }))), ...(tenant?.secondPersonPartyIds ?? []).map((id) => ({ id, listedOn: 'TENANT' as const }))]
  const parties = listed.length ? new Map((await db.party.findMany({ where: { id: { in: listed.map((entry) => entry.id) } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, row])) : new Map()
  return {
    companyId,
    inForce: { rule: inForce.rule, source: inForce.source, words: FOUR_EYES_WORDS[inForce.rule] },
    own: own && ownRow ? { releaseFourEyes: own.releaseFourEyes, secondPersonPartyIds: [...own.secondPersonPartyIds], updatedAt: toUtcIso(ownRow.updatedAt) } : null,
    version: ownRow?.version ?? 0,
    customers: listed.map((entry) => {
      const party = parties.get(entry.id)
      return { id: entry.id, code: party?.code ?? '', name: party?.tradeName ?? party?.legalName ?? '', listedOn: entry.listedOn }
    }),
  }
}

export async function getReleaseRule(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null) await assertCompany(caller, companyId)
  return caller.withClient((db) => ruleView(db, context.tenantId, companyId))
}

export interface SaveRuleBody {
  readonly companyId?: string | null | undefined
  readonly releaseFourEyes: FourEyesRule | null
  readonly secondPersonPartyIds: readonly string[]
  readonly version: number
  readonly reason?: string | null | undefined
}

export async function saveReleaseRule(caller: CommandCaller, body: SaveRuleBody, options: { readonly stepUp: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), QUALITY_SETTINGS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The tenant-wide four-eyes rule is changed only by a role over every company.' : undefined)
  }
  if (companyId !== null) await assertCompany(caller, companyId)
  const partyIds = [...body.secondPersonPartyIds]
  if (new Set(partyIds).size !== partyIds.length) throw new ValidationError('List each customer once.', [{ path: 'body/secondPersonPartyIds', message: 'Each customer once.' }])
  const found = partyIds.length ? await caller.withClient((db) => db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, roles: true } })) : []
  const unknown = partyIds.filter((id) => !found.some((party) => party.id === id && (party.roles.includes('CUSTOMER') || party.roles.includes('BRAND'))))
  if (unknown.length > 0) throw new ValidationError('Only customers are listed.', unknown.map((id) => ({ path: 'body/secondPersonPartyIds', message: `${id} is not a customer.` })))
  const after: FourEyesRow = { releaseFourEyes: body.releaseFourEyes, secondPersonPartyIds: partyIds }
  const before = await caller.withClient(async (db) => {
    const rows = await fourEyesRows(db, context.tenantId, companyId)
    return fourEyesOf(companyId === null ? rows.tenant : rows.company) ?? { releaseFourEyes: null, secondPersonPartyIds: [] }
  })
  const loosens = isFourEyesLoosening(before, after)
  if (loosens) {
    const problem = reasonProblem(body.reason)
    if (problem) throw new ValidationError('Loosening who releases garments needs the reason.', [{ ...problem, path: 'body/reason' }])
    await options.stepUp()
  }
  const id = companyId ?? context.tenantId
  await command(caller, { name: 'quality.releaseRule.save', idempotencyKey: options.idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "QualitySettings" WHERE "id" = ${id}::uuid FOR UPDATE`
    const version = locked?.version ?? 0
    if (version !== body.version) throw new StaleVersionError('QualitySettings', id, version, body.version)
    const rows = await fourEyesRows(tx, context.tenantId, companyId)
    const current = fourEyesOf(companyId === null ? rows.tenant : rows.company) ?? { releaseFourEyes: null, secondPersonPartyIds: [] }
    if (isFourEyesLoosening(current, after) && !loosens) {
      throw new ValidationError('The rule in force changed: reload it, then loosen it with the reason and a fresh code.', [{ path: 'body/version', message: 'Reload the rule.' }])
    }
    if (locked) {
      await tx.qualitySettings.update({ where: { id }, data: { releaseFourEyes: body.releaseFourEyes, secondPersonPartyIds: partyIds, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    } else {
      // A new row keeps the Cr VI evidence rule in force as it is (the company's row would otherwise reset it to the default).
      const crVi = await ruleFor(tx, context.tenantId, companyId)
      await tx.qualitySettings
        .create({ data: { id, companyId, crViEvidenceRule: crVi.rule, releaseFourEyes: body.releaseFourEyes, secondPersonPartyIds: partyIds, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('These quality settings were just saved by someone else: reload them.')
          throw error
        })
    }
    const added = partyIds.filter((partyId) => !current.secondPersonPartyIds.includes(partyId))
    const removed = current.secondPersonPartyIds.filter((partyId) => !partyIds.includes(partyId))
    tools.audit({
      recordType: 'QualitySettings',
      recordId: id,
      companyId,
      before: { releaseFourEyes: current.releaseFourEyes, secondPersonPartyIds: current.secondPersonPartyIds },
      after: { releaseFourEyes: body.releaseFourEyes, secondPersonPartyIds: partyIds },
      ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}),
    })
    tools.emit({
      type: 'quality.release_rule_changed',
      subject: id,
      companyId,
      payload: { companyId, releaseFourEyes: body.releaseFourEyes, previousRule: current.releaseFourEyes, customersAdded: added, customersRemoved: removed, loosened: loosens },
    })
    return { id }
  })
  return { rule: await caller.withClient((db) => ruleView(db, context.tenantId, companyId)), loosened: loosens }
}
