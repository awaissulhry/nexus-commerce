import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_OFFSTANDARD_CODES, PRODUCTION_OFFSTANDARD_VIEW } from '@nexus/factory-domain/production/offstandard/permissions'
import { callsBookRefusal, codeDraftProblems, KIND_FIXED, type CodeDraft } from '@nexus/factory-domain/production/offstandard/rules'
import { mergedWords, nextSortOrder } from '@nexus/factory-domain/reasons/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeOf, refuse } from './access'
import type { CodeView, CreateCodeBody, EditCodeBody } from './contract'
import { callTypesOf, CODE, codeUsage, readCode, readCodes, wordsOf, type CodeRow, type Reader } from './store'
import { codeViewOf } from './views'

/**
 * The off-standard and indirect codes (B-W2b-29; MES-155, MES-158; design production.settings "Off-standard codes": code ·
 * words per language · pay rule · needs lead approval, autosave per cell). Per company (pay is the employer's): read with
 * production.offstandard.view, kept with production.offstandard.codes, each checked with can() on the code's company.
 * Each write is ONE command() with its audit row (before → after: a changed pay rule is on record) and one
 * `production.off_standard_code_changed` event. A code and its kind never change; a code is set inactive, never deleted,
 * and not while an active help-call type books its waiting to it (MES-148).
 */

const prefixed = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))

function checkDraft(draft: CodeDraft): void {
  const problems = codeDraftProblems(draft)
  if (problems.length > 0) throw new ValidationError('The code is not valid.', prefixed(problems))
}

/** What an audit row keeps of a code (its words too: they are not personal). */
const audited = (row: CodeRow) => ({
  code: row.code,
  kind: row.kind,
  payRule: row.payRule,
  needsApproval: row.needsApproval,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  colour: row.colour,
  sortOrder: row.sortOrder,
  active: row.active,
})

async function viewOf(db: Reader, row: CodeRow): Promise<CodeView> {
  return codeViewOf(row, (await codeUsage(db, [row.id])).get(row.id) ?? 0, (await callTypesOf(db, [row.id])).get(row.id) ?? [])
}

export async function listCodes(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly active?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const where: Prisma.OffStandardCodeWhereInput = {
      AND: [
        scopeWhere(actor, PRODUCTION_OFFSTANDARD_VIEW, { company: 'companyId' }) as Prisma.OffStandardCodeWhereInput,
        query.companyId ? { companyId: query.companyId } : {},
        query.active === undefined ? {} : { active: query.active === 'true' },
      ],
    }
    const rows = await readCodes(db, where)
    const ids = rows.map((row) => row.id)
    const [usage, calls] = [await codeUsage(db, ids), await callTypesOf(db, ids)]
    const companies = query.companyId ? [query.companyId] : [...new Set(rows.map((row) => row.companyId))]
    const sites = await db.site.findMany({ where: { AND: [scopeWhere(actor, PRODUCTION_OFFSTANDARD_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, companies.length > 0 ? { companyId: { in: companies } } : {}] }, select: { floorLocales: true } })
    const languages = [...new Set(sites.flatMap((site) => site.floorLocales))].filter((language) => language !== 'it' && language !== 'en').sort()
    const reachable = query.companyId ? [query.companyId] : (await db.company.findMany({ where: scopeWhere(actor, PRODUCTION_OFFSTANDARD_CODES, { company: 'id' }) as Prisma.CompanyWhereInput, select: { id: true } })).map((row) => row.id)
    return {
      codes: rows.map((row) => codeViewOf(row, usage.get(row.id) ?? 0, calls.get(row.id) ?? [])),
      languages,
      canManage: reachable.some((companyId) => can(actor, PRODUCTION_OFFSTANDARD_CODES, { companyId })),
    }
  })
}

export async function createCode(caller: CommandCaller, body: CreateCodeBody, idempotencyKey?: string): Promise<CodeView> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const company = await caller.withClient((db) => db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))
  if (!company || !can(actor, PRODUCTION_OFFSTANDARD_VIEW, { companyId: body.companyId })) throw new NotFoundError('Company not found.')
  if (!can(actor, PRODUCTION_OFFSTANDARD_CODES, { companyId: body.companyId })) throw new ForbiddenError("You may not keep this company's off-standard codes.")
  const code = body.code.trim().toUpperCase()
  checkDraft({ code, labelIt: body.labelIt, labelEn: body.labelEn, labelI18n: body.labelI18n, icon: body.icon, colour: body.colour })
  const { result } = await command(caller, { name: 'production.offStandardCodeCreate', idempotencyKey, input: { ...body, code } }, async (tools: CommandTools) => {
    const existing = await tools.tx.offStandardCode.findMany({ where: { companyId: body.companyId }, select: { code: true, sortOrder: true } })
    if (existing.some((row) => row.code === code)) throw new ValidationError('The code is taken.', [{ path: 'body/code', message: `${code} is a code of this company already (active or not): pick another.` }])
    const row = await tools.tx.offStandardCode.create({
      data: {
        id: newId(),
        companyId: body.companyId,
        code,
        kind: body.kind,
        payRule: body.payRule,
        needsApproval: body.needsApproval ?? true,
        labelIt: body.labelIt.trim(),
        labelEn: body.labelEn.trim(),
        labelI18n: mergedWords({}, body.labelI18n),
        icon: body.icon ?? null,
        colour: body.colour ? body.colour.toLowerCase() : null,
        sortOrder: nextSortOrder(existing.map((entry) => entry.sortOrder)),
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: context.actorId,
      },
      select: CODE,
    })
    tools.audit({ recordType: 'OffStandardCode', recordId: row.id, companyId: row.companyId, after: audited(row) })
    tools.emit({ type: 'production.off_standard_code_changed', subject: row.id, companyId: row.companyId, payload: { companyId: row.companyId, codeId: row.id, code: row.code, change: 'CREATED' } })
    return viewOf(tools.tx, row)
  })
  return result
}

export async function editCode(caller: CommandCaller, codeId: string, body: EditCodeBody, idempotencyKey?: string): Promise<CodeView> {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const found = await caller.withClient((db) => readCode(db, codeId))
  if (!found || !can(actor, PRODUCTION_OFFSTANDARD_VIEW, { companyId: found.companyId })) throw new NotFoundError('Off-standard code not found.')
  if (!can(actor, PRODUCTION_OFFSTANDARD_CODES, { companyId: found.companyId })) throw new ForbiddenError("You may not keep this company's off-standard codes.")
  if (body.kind !== undefined && body.kind !== found.kind) refuse(KIND_FIXED)
  checkDraft({ labelIt: body.labelIt, labelEn: body.labelEn, labelI18n: body.labelI18n, icon: body.icon, colour: body.colour })
  const { result } = await command(
    caller,
    { name: 'production.offStandardCodeEdit', idempotencyKey, input: { codeId, ...body }, record: { type: 'OffStandardCode', id: codeId, expectedVersion: body.version } },
    async (tools) => {
      const before = (await readCode(tools.tx, codeId))!
      if (body.active === false && before.active) {
        const calls = (await callTypesOf(tools.tx, [codeId])).get(codeId) ?? []
        if (calls.length > 0) refuse(callsBookRefusal(calls))
      }
      const data: Prisma.OffStandardCodeUpdateInput = {
        ...(body.labelIt === undefined ? {} : { labelIt: body.labelIt.trim() }),
        ...(body.labelEn === undefined ? {} : { labelEn: body.labelEn.trim() }),
        ...(body.labelI18n === undefined ? {} : { labelI18n: mergedWords(wordsOf(before.labelI18n), body.labelI18n) }),
        ...(body.icon === undefined ? {} : { icon: body.icon }),
        ...(body.colour === undefined ? {} : { colour: body.colour === null ? null : body.colour.toLowerCase() }),
        ...(body.payRule === undefined ? {} : { payRule: body.payRule }),
        ...(body.needsApproval === undefined ? {} : { needsApproval: body.needsApproval }),
        ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
        ...(body.active === undefined ? {} : { active: body.active }),
      }
      const row = await tools.tx.offStandardCode.update({ where: { id: codeId }, data: { ...data, updatedAt: tools.now }, select: CODE })
      const was = audited(before)
      const now = audited(row)
      const keys = (Object.keys(now) as (keyof typeof now)[]).filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]))
      tools.audit({ recordType: 'OffStandardCode', recordId: row.id, companyId: row.companyId, before: Object.fromEntries(keys.map((key) => [key, was[key]])), after: Object.fromEntries(keys.map((key) => [key, now[key]])) })
      const onlyActive = keys.length === 1 && keys[0] === 'active'
      const change = onlyActive ? (row.active ? 'REACTIVATED' : 'DEACTIVATED') : 'EDITED'
      tools.emit({ type: 'production.off_standard_code_changed', subject: row.id, companyId: row.companyId, payload: { companyId: row.companyId, codeId: row.id, code: row.code, change } })
      return viewOf(tools.tx, row)
    },
  )
  return result
}
