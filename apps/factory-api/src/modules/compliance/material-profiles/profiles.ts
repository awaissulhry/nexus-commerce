import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { INNOCUOUSNESS_WORDS, profileEditProblems, type ProfileEdit } from '@nexus/factory-domain/compliance/material-profiles/rules'
import { SUBSTANCES_MANAGE, SUBSTANCES_VIEW } from '@nexus/factory-domain/compliance/substances/permissions'
import type { DeclarationKind, SubstanceTest } from '@nexus/factory-domain/compliance/substances/rules'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor } from '@nexus/factory-domain/core/permissions'
import type { FibreShare } from '@nexus/factory-domain/product/materials/rules'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { companyReach, namesFor, officeOf } from '../register-of-rules/common'
import { substancesClock, substancesGuarded, substancesSettings } from '../substances/common'
import { declarationsOf, usesOf, type Reader } from '../substances/store'
import { profileFactsOf, PROFILE_RECORD_TYPE } from './facts'
import { reevaluateInCommand } from './reevaluate'

/**
 * Material profiles (B-W2b-256; PRD-303, PRD-314; design compliance.tests › Material profiles and the material record's
 * Compliance tab). Reading needs compliance.certificates.view (the materials of the companies the person reads and the
 * tenant-wide ones); a person's edit (the composition or a leather's tannage confirmed against the evidence, the country it
 * is made in, a note) needs compliance.substances.manage over the material's company (a tenant-wide material: every
 * company) and re-runs the evaluator in the same command: the evaluator owns the profile's state (B-W2b-250), a missing
 * confirmation or a PPE material's missing innocuousness evidence (EN ISO 13688) keeps it INCOMPLETE. The innocuousness
 * evidence for the technical file is the newest lab results of its lots (Cr VI, azo, nickel) and the profile's own lab
 * report files (POST /files with recordType MaterialComplianceProfile and the material's id: a file there evaluates it again).
 */

export const PROFILE_LIST_LIMIT = 500
const day = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

const ITEM_SELECT = {
  id: true,
  code: true,
  name: true,
  kind: true,
  companyId: true,
  status: true,
  composition: true,
  tannage: true,
  animalSpecies: true,
  isPpeComponent: true,
  requiresCrViTest: true,
  defaultSupplierId: true,
} as const satisfies Prisma.ItemSelect
type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_SELECT }>

const PROFILE_COLUMNS = {
  id: true,
  compositionConfirmedAt: true,
  compositionConfirmedById: true,
  tannageConfirmedAt: true,
  tannageConfirmedById: true,
  originCountry: true,
  svhcAboveThreshold: true,
  svhcListVersionId: true,
  testsNeeded: true,
  declarationsNeeded: true,
  evaluatedAt: true,
  state: true,
  stateReason: true,
  note: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.MaterialComplianceProfileSelect
type ProfileRow = Prisma.MaterialComplianceProfileGetPayload<{ select: typeof PROFILE_COLUMNS }>

/** "80 % polyester, 20 % elastane". */
const compositionWords = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length === 0) return null
  return (value as FibreShare[]).map((share) => `${share.percent} % ${share.fibre}`).join(', ')
}

/** Per material: the declarations in force (accepted, valid today) by kind, and the kinds asked and not decided. */
async function declarationKinds(db: Reader, ids: readonly string[], today: BusinessDate) {
  const facts = await declarationsOf(db, ids)
  return new Map(
    ids.map((id) => {
      const mine = facts.get(id) ?? []
      const present = [...new Set(mine.filter((fact) => fact.status === 'ACCEPTED' && (fact.validTo === null || fact.validTo >= today)).map((fact) => fact.kind))]
      const asked = [...new Set(mine.filter((fact) => fact.status === 'SENT' || fact.status === 'OVERDUE' || fact.status === 'ANSWERED').map((fact) => fact.kind))]
      return [id, { present, asked, requests: mine }] as const
    }),
  )
}

/** The list rows (design ts-profiles): material, kind, composition, tannage, origin, supplier, required tests, declarations present / missing, innocuousness, status. */
async function rowsOf(db: Reader, items: readonly ItemRow[], now: Date) {
  const today = businessDate(now)
  const ids = items.map((item) => item.id)
  const profiles = new Map((ids.length === 0 ? [] : await db.materialComplianceProfile.findMany({ where: { id: { in: ids } }, select: PROFILE_COLUMNS })).map((row) => [row.id, row]))
  const uses = await usesOf(db, ids)
  const facts = await profileFactsOf(db, items, uses, today)
  const declarations = await declarationKinds(db, ids, today)
  const supplierIds = [...new Set(items.flatMap((item) => (item.defaultSupplierId ? [item.defaultSupplierId] : [])))]
  const suppliers = new Map((supplierIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  return items.map((item) => {
    const profile = profiles.get(item.id)
    const fact = facts.get(item.id)!
    const declared = declarations.get(item.id)!
    const needed = (profile?.declarationsNeeded ?? []) as DeclarationKind[]
    const supplier = item.defaultSupplierId ? suppliers.get(item.defaultSupplierId) : undefined
    return {
      material: { id: item.id, code: item.code, name: item.name, kind: item.kind, companyId: item.companyId, status: item.status },
      composition: compositionWords(item.composition),
      tannage: item.tannage,
      animalSpecies: item.animalSpecies,
      originCountry: profile?.originCountry ?? null,
      supplier: supplier ? { id: supplier.id, code: supplier.code, name: supplier.legalName } : null,
      /** The saved state (null: no profile yet: never evaluated). */
      state: (profile?.state as 'INCOMPLETE' | 'COMPLETE' | 'BLOCKED' | undefined) ?? null,
      stateReason: profile?.stateReason ?? null,
      evaluatedAt: iso(profile?.evaluatedAt ?? null),
      testsNeeded: [...(profile?.testsNeeded ?? [])] as SubstanceTest[],
      declarations: { needed, present: declared.present, missing: needed.filter((kind) => !declared.present.includes(kind)), asked: declared.asked },
      compositionConfirmed: fact.compositionConfirmed,
      tannageConfirmed: item.kind === 'LEATHER' ? fact.tannageConfirmed : null,
      innocuousness: { required: fact.innocuousness.required, complete: fact.innocuousness.complete, parameters: fact.innocuousness.parameters.map((entry) => ({ parameter: entry.parameter, status: entry.status })) },
      svhcAboveThreshold: profile?.svhcAboveThreshold ?? null,
      version: profile?.version ?? null,
    }
  })
}

export interface ListQuery {
  readonly state?: 'INCOMPLETE' | 'COMPLETE' | 'BLOCKED' | 'NONE' | undefined
  readonly kind?: string | undefined
  readonly q?: string | undefined
}

/** GET /compliance/material-profiles — every active material the person reads with its profile, and the tiles' counts. */
export async function listProfiles(request: FastifyRequest, query: ListQuery) {
  const actor = actorOf(officeOf(request))
  const now = substancesClock().now()
  return request.withClient(async (db) => {
    const reach = companyReach(actor, SUBSTANCES_VIEW) as Prisma.ItemWhereInput
    const base: Prisma.ItemWhereInput = { AND: [reach, { kind: { not: 'FINISHED' } }, { status: 'ACTIVE' }] }
    const stateWhere: Prisma.ItemWhereInput[] =
      query.state === 'NONE' ? [{ complianceProfiles: { none: {} } }] : query.state ? [{ complianceProfiles: { some: { state: query.state } } }] : []
    const where: Prisma.ItemWhereInput = {
      AND: [
        base,
        ...stateWhere,
        ...(query.kind ? [{ kind: query.kind as never }] : []),
        ...(query.q ? [{ OR: [{ code: { contains: query.q, mode: 'insensitive' as const } }, { name: { contains: query.q, mode: 'insensitive' as const } }] }] : []),
      ],
    }
    const items = await db.item.findMany({ where, select: ITEM_SELECT, orderBy: [{ code: 'asc' }], take: PROFILE_LIST_LIMIT + 1 })
    const rows = await rowsOf(db, items.slice(0, PROFILE_LIST_LIMIT), now)
    const counted = await db.item.findMany({ where: base, select: { complianceProfiles: { select: { state: true } } } })
    const counts = { materials: counted.length, none: 0, incomplete: 0, complete: 0, blocked: 0 }
    for (const item of counted) {
      const state = item.complianceProfiles[0]?.state
      if (!state) counts.none += 1
      else if (state === 'INCOMPLETE') counts.incomplete += 1
      else if (state === 'COMPLETE') counts.complete += 1
      else counts.blocked += 1
    }
    return { profiles: rows, more: items.length > PROFILE_LIST_LIMIT, counts, mayEdit: holds(actor, SUBSTANCES_MANAGE), asOf: toUtcIso(now) }
  })
}

async function readItem(db: Reader, actor: Actor, itemId: string): Promise<ItemRow> {
  const item = isUuid(itemId) ? await db.item.findUnique({ where: { id: itemId }, select: ITEM_SELECT }) : null
  if (!item || item.kind === 'FINISHED' || !can(actor, SUBSTANCES_VIEW, { companyId: item.companyId })) throw new NotFoundError('Material not found.')
  return item
}

/** The material record's Compliance tab: the profile with its confirmations, innocuousness evidence, declarations, lab results and evidence files. */
async function profileRecord(db: Reader, actor: Actor, item: ItemRow, now: Date) {
  const today = businessDate(now)
  const [row] = await rowsOf(db, [item], now)
  const profile = await db.materialComplianceProfile.findUnique({ where: { id: item.id }, select: PROFILE_COLUMNS })
  const facts = (await profileFactsOf(db, [item], await usesOf(db, [item.id]), today)).get(item.id)!
  const name = await namesFor(db, [profile?.compositionConfirmedById, profile?.tannageConfirmedById])
  const declarations = (await declarationKinds(db, [item.id], today)).get(item.id)!
  const results = await db.labResult.findMany({
    where: { itemId: item.id },
    select: { id: true, lotId: true, test: true, verdict: true, testedOn: true, valueMgKg: true, belowDetectionLimit: true, unit: true, limitMgKg: true, method: true, lab: true, supersededBy: { select: { id: true } }, lot: { select: { code: true } } },
    orderBy: [{ testedOn: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  })
  const requestParties = new Map(
    (declarations.requests.length === 0 ? [] : await db.supplierDeclarationRequest.findMany({ where: { id: { in: declarations.requests.map((fact) => fact.requestId) } }, select: { id: true, partyId: true } })).map((request) => [request.id, request.partyId]),
  )
  const partyIds = [...new Set(requestParties.values())]
  const parties = new Map((partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true } })).map((party) => [party.id, party.code]))
  return {
    ...row!,
    compositionList: Array.isArray(item.composition) ? (item.composition as unknown as FibreShare[]).map((share) => ({ fibre: share.fibre, percent: share.percent })) : [],
    isPpeComponent: item.isPpeComponent,
    requiresCrViTest: item.requiresCrViTest,
    compositionConfirmedAt: iso(profile?.compositionConfirmedAt ?? null),
    compositionConfirmedBy: name(profile?.compositionConfirmedById ?? null),
    tannageConfirmedAt: iso(profile?.tannageConfirmedAt ?? null),
    tannageConfirmedBy: name(profile?.tannageConfirmedById ?? null),
    note: profile?.note ?? null,
    gaps: [...facts.gaps],
    innocuousnessDetail: {
      required: facts.innocuousness.required,
      ppeStyles: [...facts.innocuousness.ppeStyles],
      complete: facts.innocuousness.complete,
      parameters: facts.innocuousness.parameters.map((entry) => ({ parameter: entry.parameter, words: INNOCUOUSNESS_WORDS[entry.parameter], status: entry.status, result: entry.result, files: [...entry.files], explanation: entry.words })),
    },
    evidenceFiles: facts.files.map((file) => ({ fileId: file.fileId, name: file.name, category: file.category, expiresOn: file.expiresOn })),
    declarationRequests: declarations.requests.map((fact) => ({
      requestId: fact.requestId,
      number: fact.number,
      kind: fact.kind,
      status: fact.status,
      party: { id: requestParties.get(fact.requestId) ?? null, code: parties.get(requestParties.get(fact.requestId) ?? '') ?? '?' },
      dueOn: fact.dueOn,
      validTo: fact.validTo,
      lines: fact.lines.map((line) => ({ contains: line.contains, aboveThreshold: line.aboveThreshold, substanceName: line.substanceName })),
    })),
    labResults: results.map((result) => ({
      resultId: result.id,
      lot: { id: result.lotId, code: result.lot.code },
      test: result.test,
      verdict: result.verdict,
      testedOn: day(result.testedOn),
      value: result.valueMgKg ? result.valueMgKg.toFixed() : null,
      belowDetectionLimit: result.belowDetectionLimit,
      unit: result.unit,
      limit: result.limitMgKg.toFixed(),
      method: result.method,
      lab: result.lab,
      current: result.supersededBy.length === 0,
    })),
    evidenceRecord: { recordType: PROFILE_RECORD_TYPE, recordId: item.id },
    mayEdit: mayWrite(actor, SUBSTANCES_MANAGE, item.companyId),
  }
}

/** GET /compliance/material-profiles/:itemId. */
export async function getProfile(request: FastifyRequest, itemId: string) {
  const actor = actorOf(officeOf(request))
  const now = substancesClock().now()
  return request.withClient(async (db) => {
    const item = await readItem(db, actor, itemId)
    return { profile: await profileRecord(db, actor, item, now), asOf: toUtcIso(now) }
  })
}

export interface EditBody extends ProfileEdit {
  /** The profile's version as read (absent: the material has no profile yet). */
  readonly version?: number | undefined
}

/** PATCH /compliance/material-profiles/:itemId — confirmations, origin, note; the evaluator runs again in the same command. */
export async function editProfile(caller: CommandCaller & Pick<FastifyRequest, 'withClient'>, itemId: string, body: EditBody, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const item = await caller.withClient((db) => readItem(db, actor, itemId))
  if (!mayWrite(actor, SUBSTANCES_MANAGE, item.companyId)) throw new ForbiddenError(item.companyId === null ? `${item.code} is a material for every company: its profile is kept only by a role over every company.` : `You may not change ${item.code}'s compliance profile: it needs compliance.substances.manage.`)
  const problems = profileEditProblems(body, item.kind)
  if (problems.length > 0) throw new ValidationError('The profile is not valid.', problems)
  const exists = await caller.withClient((db) => db.materialComplianceProfile.findUnique({ where: { id: item.id }, select: { version: true } }))
  if (exists && body.version === undefined) throw new ValidationError('The profile is not valid.', [{ path: 'body/version', message: 'The profile exists: send its version as read.' }])
  const { result } = await substancesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.materialProfiles.edit', idempotencyKey: key, input: { itemId, ...body }, ...(exists ? { record: { type: 'MaterialComplianceProfile' as const, id: item.id, expectedVersion: body.version! } } : {}) },
        async (tools) => {
          const { tx, now } = tools
          let before: ProfileRow | null = await tx.materialComplianceProfile.findUnique({ where: { id: item.id }, select: PROFILE_COLUMNS })
          if (!before) {
            await tx.materialComplianceProfile.create({ data: { id: item.id, itemId: item.id, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
            before = null
          }
          const changed: ('COMPOSITION' | 'TANNAGE' | 'ORIGIN' | 'NOTE')[] = []
          const data: Prisma.MaterialComplianceProfileUpdateInput = { updatedAt: now }
          if (body.compositionConfirmed !== undefined && body.compositionConfirmed !== Boolean(before?.compositionConfirmedAt)) {
            Object.assign(data, body.compositionConfirmed ? { compositionConfirmedAt: now, compositionConfirmedById: context.actorId } : { compositionConfirmedAt: null, compositionConfirmedById: null })
            changed.push('COMPOSITION')
          }
          if (body.tannageConfirmed !== undefined && body.tannageConfirmed !== Boolean(before?.tannageConfirmedAt)) {
            Object.assign(data, body.tannageConfirmed ? { tannageConfirmedAt: now, tannageConfirmedById: context.actorId } : { tannageConfirmedAt: null, tannageConfirmedById: null })
            changed.push('TANNAGE')
          }
          if (body.originCountry !== undefined && body.originCountry !== (before?.originCountry ?? null)) {
            data.originCountry = body.originCountry
            changed.push('ORIGIN')
          }
          if (body.note !== undefined && (body.note?.trim() ?? null) !== (before?.note ?? null)) {
            data.note = body.note === null ? null : body.note.trim()
            changed.push('NOTE')
          }
          if (changed.length > 0) await tx.materialComplianceProfile.update({ where: { id: item.id }, data, select: { id: true } })
          const shown = (row: ProfileRow | null) => (row ? { compositionConfirmedAt: iso(row.compositionConfirmedAt), tannageConfirmedAt: iso(row.tannageConfirmedAt), originCountry: row.originCountry, note: row.note } : null)
          // The evaluator says again what the material needs (B-W2b-250's one writer): a confirmation may complete it.
          await reevaluateInCommand(tools, [item.id], context.actorId)
          const after = await tx.materialComplianceProfile.findUniqueOrThrow({ where: { id: item.id }, select: PROFILE_COLUMNS })
          tools.audit({ action: 'compliance.materialProfiles.edit', recordType: 'MaterialComplianceProfile', recordId: item.id, companyId: item.companyId, before: shown(before), after: { ...shown(after), changed } })
          tools.emit({ type: 'compliance_material_tests.profile_changed', subject: item.id, companyId: item.companyId, payload: { itemId: item.id, changed, state: after.state as 'INCOMPLETE' | 'COMPLETE' | 'BLOCKED' } })
          return { profile: await profileRecord(tx, actor, item, now), changed, at: toUtcIso(now) }
        },
        substancesSettings(),
      ),
    { taken: 'The material got its profile meanwhile: read it again.' },
  )
  return result
}
