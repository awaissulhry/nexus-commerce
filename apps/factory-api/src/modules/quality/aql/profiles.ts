import type { AqlInspectionLevel, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { INSPECTION_LEVELS } from '@nexus/factory-domain/quality/aql/iso2859'
import { QUALITY_AQL_VIEW } from '@nexus/factory-domain/quality/aql/permissions'
import { PROFILE_LIMITS, profileDraftProblems, type ProfileChange } from '@nexus/factory-domain/quality/aql/profiles'
import { AQL_VALUES, aqlStored, CRITICAL_LOCK, LEVEL_WORDS, levelOf, levelText } from '@nexus/factory-domain/quality/aql/sampling'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { ProfileView } from './contract'
import { assertManage, auditedProfile, lockCompanyProfiles, mayManage, mayView, officeOf, profileFor, profileView, PROFILE_COLUMNS, readProfile, usageOf, type ProfileRow, type Reader } from './store'

/**
 * AQL profiles (B-W2b-93; QHS-021; design quality.plans pl-aql "Rows: profile, inspection level (I, II, III, S1-S4),
 * critical (always 0), major, minor, used by customers / styles"; "critical is locked at 0 with the reason (QHS-002)").
 * A company's profiles: read with quality.aql.view over the company, kept with quality.aql.manage over it; each write is
 * ONE command() with its audit row and the event quality.aql_profile_changed.
 *
 *   GET   /quality/aql/profiles             the companies' profiles the caller sees, with what uses each; the levels, the
 *                                           AQLs a profile may take (Table 2-A's), critical's lock in words.
 *   POST  /quality/aql/profiles             a profile (code fixed from now on); `isDefault` makes it the company's default
 *                                           (the old default stops being it in the same command).
 *   PATCH /quality/aql/profiles/:profileId  name, level, AQLs, note; retire (active false) or make active again; become
 *                                           the default. Critical stays 0 (a body that says otherwise is refused in words).
 *
 * The database's AqlProfile_guard is the last word (code fixed, critical 0, a default in use, never deleted); a profile is
 * retired while no active assignment and no draft or approved plan version names it, and never while it is the default.
 */

const refuse = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

const changed = (tools: CommandTools, row: ProfileRow, change: ProfileChange) =>
  tools.emit({ type: 'quality.aql_profile_changed', subject: row.id, companyId: row.companyId, payload: { companyId: row.companyId, profileId: row.id, code: row.code, change } })

async function viewOne(db: Reader, row: ProfileRow): Promise<ProfileView> {
  return profileView(row, (await usageOf(db, [row.id])).get(row.id))
}

/** The company's default stops being it (another profile becomes the default in the same command). */
async function clearDefault(tools: CommandTools, companyId: string, keep: string | null): Promise<string | null> {
  const { tx, now } = tools
  const old = await tx.aqlProfile.findFirst({ where: { companyId, isDefault: true, ...(keep ? { id: { not: keep } } : {}) }, select: PROFILE_COLUMNS })
  if (!old) return null
  const row = await tx.aqlProfile.update({ where: { id: old.id }, data: { isDefault: false, version: { increment: 1 }, updatedAt: now }, select: PROFILE_COLUMNS })
  tools.audit({ recordType: 'AqlProfile', recordId: old.id, companyId, before: auditedProfile(old), after: auditedProfile(row) })
  changed(tools, row, 'EDITED')
  return old.id
}

// ---- reads ----------------------------------------------------------------------------------------------------------

/** GET /quality/aql/profiles */
export async function readProfiles(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly active?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  if (query.companyId && !mayView(context, query.companyId)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => {
    const rows = await client.aqlProfile.findMany({
      where: { AND: [scopeWhere(actorOf(context), QUALITY_AQL_VIEW, { company: 'companyId' }), query.companyId ? { companyId: query.companyId } : {}, query.active ? { active: query.active === 'true' } : {}] },
      select: PROFILE_COLUMNS,
      orderBy: [{ companyId: 'asc' }, { isDefault: 'desc' }, { code: 'asc' }],
    })
    const usage = await usageOf(client, rows.map((row) => row.id))
    return {
      profiles: rows.map((row) => profileView(row, usage.get(row.id))),
      levels: INSPECTION_LEVELS.map((level) => ({ level, text: levelText(level), ...LEVEL_WORDS[level] })),
      aqlValues: [...AQL_VALUES],
      criticalLock: { ...CRITICAL_LOCK, rule: { ...CRITICAL_LOCK.rule } },
      manageCompanyIds: [...new Set(rows.map((row) => row.companyId).concat(query.companyId ? [query.companyId] : []))].filter((companyId) => mayManage(context, companyId)),
    }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------

export interface CreateProfileBody {
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly inspectionLevel: string
  readonly aqlMajor: string
  readonly aqlMinor: string
  readonly aqlCritical?: string | undefined
  readonly isDefault?: boolean | undefined
  readonly note?: string | null | undefined
}

const levelIn = (text: string | undefined): string | undefined => (text === undefined ? undefined : (levelOf(text) ?? text))

/** POST /quality/aql/profiles */
export async function createProfile(caller: CommandCaller, body: CreateProfileBody, idempotencyKey?: string): Promise<{ profile: ProfileView; previousDefaultId: string | null }> {
  const context = officeOf(caller)
  const company = isUuid(body.companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: body.companyId }, select: { id: true } })) : null
  if (!company || !mayView(context, body.companyId)) throw new NotFoundError('Company not found.')
  assertManage(context, body.companyId)
  const code = body.code.trim().toUpperCase()
  const draft = { ...body, code, inspectionLevel: levelIn(body.inspectionLevel) }
  const problems = profileDraftProblems(draft, true)
  if (problems.length > 0) refuse(problems, 'The AQL profile is not valid.')
  const id = newId()
  const { result } = await command(caller, { name: 'quality.aql.createProfile', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockCompanyProfiles(tx, body.companyId)
    if ((await tx.aqlProfile.count({ where: { companyId: body.companyId } })) >= PROFILE_LIMITS.perCompany) throw new ConflictError(`A company keeps at most ${PROFILE_LIMITS.perCompany} AQL profiles: retire some first.`)
    const taken = await tx.aqlProfile.findFirst({ where: { companyId: body.companyId, code }, select: { active: true } })
    if (taken) throw new ConflictError(`AQL profile ${code} is taken in this company${taken.active ? '' : ' by a retired profile'}.`)
    // The company's first profile is its default: every inspection then has a profile to start from.
    const first = (await tx.aqlProfile.count({ where: { companyId: body.companyId, active: true } })) === 0
    const isDefault = body.isDefault === true || first
    const previousDefaultId = isDefault ? await clearDefault(tools, body.companyId, null) : null
    const row = await tx.aqlProfile.create({
      data: {
        id,
        companyId: body.companyId,
        code,
        name: body.name.trim(),
        inspectionLevel: draft.inspectionLevel as AqlInspectionLevel,
        aqlMajor: aqlStored(body.aqlMajor),
        aqlMinor: aqlStored(body.aqlMinor),
        isDefault,
        note: body.note?.trim() || null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: PROFILE_COLUMNS,
    })
    tools.audit({ recordType: 'AqlProfile', recordId: id, companyId: body.companyId, after: auditedProfile(row) })
    changed(tools, row, 'CREATED')
    if (isDefault) changed(tools, row, 'DEFAULT_SET')
    return { profile: await viewOne(tx, row), previousDefaultId }
  })
  return result
}

export interface EditProfileBody {
  readonly version: number
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly inspectionLevel?: string | undefined
  readonly aqlMajor?: string | undefined
  readonly aqlMinor?: string | undefined
  readonly aqlCritical?: string | undefined
  readonly note?: string | null | undefined
  readonly active?: boolean | undefined
  readonly isDefault?: true | undefined
}

/** Why a profile cannot be retired now, in words; null: it can. */
async function retireProblem(db: Reader, row: ProfileRow): Promise<string | null> {
  if (row.isDefault) return `${row.code} is the company's default: make another profile the default first (the default is always a profile in use).`
  const assigned = await db.aqlProfileAssignment.count({ where: { profileId: row.id, active: true } })
  const versions = await db.inspectionPlanVersion.count({ where: { aqlProfileId: row.id, status: { in: ['DRAFT', 'APPROVED'] } } })
  if (assigned === 0 && versions === 0) return null
  const parts = [assigned > 0 ? `${assigned} active ${assigned === 1 ? 'assignment' : 'assignments'}` : null, versions > 0 ? `${versions} draft or approved plan ${versions === 1 ? 'version' : 'versions'}` : null].filter(Boolean)
  return `${row.code} is named by ${parts.join(' and ')}: end those assignments or name another profile on those plans first.`
}

/** PATCH /quality/aql/profiles/:profileId */
export async function editProfile(caller: CommandCaller, profileId: string, body: EditProfileBody, idempotencyKey?: string): Promise<{ profile: ProfileView; previousDefaultId: string | null }> {
  const { row: before } = await profileFor(caller, profileId, true)
  const draft = { ...body, inspectionLevel: levelIn(body.inspectionLevel) }
  const problems = profileDraftProblems(draft, false)
  if (body.isDefault === true && body.active === false) problems.push({ path: 'active', message: 'The default is a profile in use: it cannot be retired in the same change.' })
  if (problems.length > 0) refuse(problems, 'The change is not valid.')
  const { result } = await command(
    caller,
    { name: 'quality.aql.editProfile', idempotencyKey, input: { profileId, ...body }, record: { type: 'AqlProfile', id: before.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      await lockCompanyProfiles(tx, before.companyId)
      const current = (await readProfile(tx, before.id))!
      if (body.active === false && current.active) {
        const problem = await retireProblem(tx, current)
        if (problem) throw new ConflictError(problem)
      }
      const becomesDefault = body.isDefault === true && !current.isDefault
      if (becomesDefault && !(body.active ?? current.active)) throw new ConflictError(`${current.code} is retired: make it active again to make it the default.`)
      const previousDefaultId = becomesDefault ? await clearDefault(tools, current.companyId, current.id) : null
      const data: Prisma.AqlProfileUncheckedUpdateInput = { updatedAt: now }
      if (body.name !== undefined) data.name = body.name.trim()
      if (draft.inspectionLevel !== undefined) data.inspectionLevel = draft.inspectionLevel as AqlInspectionLevel
      if (body.aqlMajor !== undefined) data.aqlMajor = aqlStored(body.aqlMajor)
      if (body.aqlMinor !== undefined) data.aqlMinor = aqlStored(body.aqlMinor)
      if (body.note !== undefined) data.note = body.note?.trim() || null
      if (body.active !== undefined) data.active = body.active
      if (becomesDefault) data.isDefault = true
      const row = await tx.aqlProfile.update({ where: { id: current.id }, data, select: PROFILE_COLUMNS })
      tools.audit({ recordType: 'AqlProfile', recordId: row.id, companyId: row.companyId, before: auditedProfile(current), after: auditedProfile(row) })
      changed(tools, row, body.active === false && current.active ? 'RETIRED' : body.active === true && !current.active ? 'REACTIVATED' : becomesDefault ? 'DEFAULT_SET' : 'EDITED')
      return { profile: await viewOne(tx, row), previousDefaultId }
    },
  )
  return result
}
