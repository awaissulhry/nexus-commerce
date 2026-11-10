import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { packagingRulesOf } from '@nexus/factory-domain/compliance/label-artwork/rules'
import type { AddSetFileBody, BrandingSetsQuery, BrandingSetsView, BrandingSetView, CreateSetBody, PackagingRuleBody, SetStatusBody, UpdateSetBody } from '@nexus/factory-domain/product/branding-sets/contracts'
import {
  archivedSetRefusal,
  BRANDING_LIMITS,
  FILE_KINDS_OF_ROLE,
  idListProblems,
  isDrawnPicture,
  normaliseSetCode,
  otherActiveRefusal,
  packagingRuleProblems,
  setProblems,
  storedRule,
  unknownFiles,
  type StoredPackagingRule,
} from '@nexus/factory-domain/product/branding-sets/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { libraryGuarded } from '../colours/store'
import { contextOf } from '../styles/store'
import { assertMayKeep, readSet, rowsOf, SET_COLUMNS, setsWhere, viewOf, type SetRowData } from './store'

/**
 * The brands' branding sets (B-W2b-247; PRD-045; design products.colours sec:colours.branding, pop:colours.branding). Read
 * with product.styles.view over the set's company and brand; kept with product.branding.manage. Every write is one command:
 * B-W2b-206's BrandingSet_check said first in words, an audit row and branding_set.changed. Its files are files of the set:
 * sent through the files platform (POST /files, recordType "BrandingSet", recordId the set), then named a logo or label
 * artwork here. One set in use per company and brand: a new set with `replace` archives the old one in the same command.
 *
 *   GET  /product/branding-sets[?status&q&partyId&companyId]
 *   GET  /product/branding-sets/brands[?q&companyId]   the customers and brands a set may be started for
 *   GET  /product/branding-sets/:setId
 *   POST /product/branding-sets                     {companyId, partyId, code, name, note?, brandColourIds?, packagingRules?, replace?}
 *   PATCH /product/branding-sets/:setId              {version, name?, note?, brandColourIds?, packagingRules?, logoFileIds?, labelArtworkFileIds?}
 *   POST /product/branding-sets/:setId/files         {version, fileId, role LOGO | ARTWORK}
 *   POST /product/branding-sets/:setId/archive | restore   {version, reason?}
 */

const invalid = (issues: Issue[]) => new ValidationError('The branding set is not valid.', issues)

/** GET /product/branding-sets */
export async function listSets(caller: CommandCaller, query: BrandingSetsQuery): Promise<BrandingSetsView> {
  const actor = actorOf(contextOf(caller))
  const q = query.q?.trim()
  const filters: Prisma.BrandingSetWhereInput[] = [
    setsWhere(actor),
    query.status === 'ALL' ? {} : { status: query.status },
    query.partyId ? { partyId: query.partyId } : {},
    query.companyId ? { companyId: query.companyId } : {},
    q
      ? {
          OR: [
            { code: { contains: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
            { party: { OR: [{ code: { contains: q, mode: 'insensitive' } }, { legalName: { contains: q, mode: 'insensitive' } }, { tradeName: { contains: q, mode: 'insensitive' } }] } },
          ],
        }
      : {},
  ]
  return caller.withClient(async (client) => {
    const sets = await client.brandingSet.findMany({ where: { AND: filters }, select: SET_COLUMNS, orderBy: [{ status: 'asc' }, { code: 'asc' }, { id: 'asc' }], take: 500 })
    return { sets: await rowsOf(client, actor, sets) }
  })
}

/** GET /product/branding-sets/:setId */
export async function getSet(caller: CommandCaller, setId: string): Promise<BrandingSetView> {
  const set = await readSet(caller, setId)
  return caller.withClient((client) => viewOf(client, actorOf(contextOf(caller)), set))
}

/** GET /product/branding-sets/brands: customers and brands (CUSTOMER or BRAND role, active), with the set each has in use. */
export async function brandCandidates(caller: CommandCaller, query: { readonly q?: string | undefined; readonly companyId?: string | undefined }) {
  const actor = actorOf(contextOf(caller))
  const q = query.q?.trim()
  return caller.withClient(async (client) => {
    const parties = await client.party.findMany({
      where: {
        AND: [
          { roles: { hasSome: ['CUSTOMER', 'BRAND'] }, status: { in: ['PROSPECT', 'ACTIVE'] }, kind: 'ORGANISATION' },
          q ? { OR: [{ code: { contains: q, mode: 'insensitive' } }, { legalName: { contains: q, mode: 'insensitive' } }, { tradeName: { contains: q, mode: 'insensitive' } }] } : {},
        ],
      },
      select: { id: true, code: true, legalName: true, tradeName: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: 20,
    })
    const sets = parties.length === 0 ? [] : await client.brandingSet.findMany({ where: { AND: [setsWhere(actor), { partyId: { in: parties.map((party) => party.id) }, status: 'ACTIVE' }, query.companyId ? { companyId: query.companyId } : {}] }, select: { id: true, code: true, name: true, partyId: true, companyId: true } })
    return {
      brands: parties.map((party) => ({
        id: party.id,
        code: party.code,
        name: party.tradeName ?? party.legalName,
        active: sets.filter((set) => set.partyId === party.id).map((set) => ({ id: set.id, code: set.code, name: set.name, companyId: set.companyId })),
      })),
    }
  })
}

// ---- writes -------------------------------------------------------------------------------------------------------------

/** The rules as stored, refused in words per rule and field. */
function rulesOf(rules: readonly PackagingRuleBody[], at = 'body/packagingRules'): StoredPackagingRule[] {
  const stored = rules.map((rule) => storedRule({ key: rule.key, text: rule.text, itemId: rule.itemId ?? null, quantity: rule.quantity ?? null, per: rule.per ?? null }))
  const problems = packagingRuleProblems(stored, at)
  if (problems.length > 0) throw invalid(problems)
  return stored
}

/** The colours are colours of the library the set's company may use; the materials of its rules, materials of the library. */
async function referenceProblems(tx: CommandTx, companyId: string, colourIds: readonly string[] | undefined, rules: readonly StoredPackagingRule[] | undefined, before?: SetRowData): Promise<Issue[]> {
  const issues: Issue[] = []
  if (colourIds !== undefined) {
    issues.push(...idListProblems(colourIds, 'body/brandColourIds', BRANDING_LIMITS.colours))
    const added = colourIds.filter((colourId) => !before?.brandColourIds.includes(colourId))
    if (added.length > 0) {
      const found = await tx.colour.findMany({ where: { id: { in: added } }, select: { id: true, code: true, companyId: true, status: true } })
      const byId = new Map(found.map((colour) => [colour.id, colour]))
      colourIds.forEach((colourId, index) => {
        if (!added.includes(colourId)) return
        const colour = byId.get(colourId)
        if (!colour || (colour.companyId !== null && colour.companyId !== companyId)) issues.push({ path: `body/brandColourIds/${index}`, message: "Pick a colour of the library of the set's company." })
        else if (colour.status !== 'ACTIVE') issues.push({ path: `body/brandColourIds/${index}`, message: `Colour ${colour.code} is archived: restore it first.` })
      })
    }
  }
  if (rules !== undefined) {
    const kept = new Set(packagingRulesOf(before?.packagingRules ?? null).flatMap((rule) => (rule.itemId ? [rule.itemId] : [])))
    const itemIds = [...new Set(rules.flatMap((rule) => (rule.itemId && !kept.has(rule.itemId) ? [rule.itemId] : [])))]
    if (itemIds.length > 0) {
      const found = await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, companyId: true, status: true } })
      const byId = new Map(found.map((item) => [item.id, item]))
      rules.forEach((rule, index) => {
        if (!rule.itemId || kept.has(rule.itemId)) return
        const item = byId.get(rule.itemId)
        if (!item || (item.companyId !== null && item.companyId !== companyId)) issues.push({ path: `body/packagingRules/${index}/itemId`, message: "Pick a material of the library of the set's company." })
        else if (item.status !== 'ACTIVE') issues.push({ path: `body/packagingRules/${index}/itemId`, message: `Material ${item.code} is archived: pick another.` })
      })
    }
  }
  return issues
}

async function answer(tools: CommandTools, setId: string): Promise<BrandingSetView> {
  const set = await tools.tx.brandingSet.findUniqueOrThrow({ where: { id: setId }, select: SET_COLUMNS })
  return viewOf(tools.tx, actorOf(tools.context), set)
}

/** The audited shape of a set. */
const shapeOf = (set: SetRowData) => ({
  code: set.code,
  name: set.name,
  note: set.note,
  logoFileIds: set.logoFileIds,
  labelArtworkFileIds: set.labelArtworkFileIds,
  brandColourIds: set.brandColourIds,
  packagingRules: set.packagingRules,
  status: set.status,
})

/** POST /product/branding-sets */
export async function createSet(caller: CommandCaller, body: CreateSetBody, idempotencyKey?: string): Promise<BrandingSetView> {
  assertMayKeep(caller, body.companyId, body.partyId)
  const fields = { code: normaliseSetCode(body.code), name: body.name.trim(), note: body.note?.trim() ? body.note.trim() : null }
  const problems = setProblems(fields)
  if (problems.length > 0) throw invalid(problems)
  const rules = body.packagingRules ? rulesOf(body.packagingRules) : []
  const colourIds = body.brandColourIds ?? []
  const id = newId()
  const taken = () => `The branding set code ${fields.code} is taken: pick another.`
  const { result } = await libraryGuarded(
    () =>
      command(caller, { name: 'product.branding.create', idempotencyKey, input: body }, async (tools) => {
        const { tx, now, context: actor } = tools
        if (!(await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw invalid([{ path: 'body/companyId', message: 'No such company.' }])
        const party = await tx.party.findUnique({ where: { id: body.partyId }, select: { id: true, code: true, roles: true, status: true } })
        if (!party) throw invalid([{ path: 'body/partyId', message: 'No such customer or brand.' }])
        if (!party.roles.includes('CUSTOMER') && !party.roles.includes('BRAND')) throw invalid([{ path: 'body/partyId', message: `${party.code} is no customer or brand: a branding set is a private-label brand's.` }])
        if (await tx.brandingSet.findFirst({ where: { code: fields.code }, select: { id: true } })) throw new ConflictError(taken())
        const issues = await referenceProblems(tx, body.companyId, colourIds, rules)
        if (issues.length > 0) throw invalid(issues)
        // One set in use per company and brand: the old one is archived first, in this command, when asked.
        const old = await tx.brandingSet.findFirst({ where: { companyId: body.companyId, partyId: body.partyId, status: 'ACTIVE' }, select: SET_COLUMNS })
        if (old && !body.replace) throw new ConflictError(`${party.code} has branding set ${old.code} in use in this company: archive it, or start the new set to replace it.`)
        if (old) {
          await tx.brandingSet.update({ where: { id: old.id }, data: { status: 'ARCHIVED', version: { increment: 1 } }, select: { id: true } })
          tools.audit({ recordType: 'BrandingSet', recordId: old.id, companyId: old.companyId, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED', replacedBy: fields.code }, ...(body.reason ? { reason: body.reason } : {}) })
          tools.emit({ type: 'branding_set.changed', subject: old.id, companyId: old.companyId, payload: { brandingSetId: old.id, partyId: old.partyId, code: old.code, change: 'ARCHIVED', fields: ['status'] } })
        }
        await tx.brandingSet.create({
          data: {
            id,
            companyId: body.companyId,
            partyId: body.partyId,
            ...fields,
            brandColourIds: [...colourIds],
            ...(rules.length > 0 ? { packagingRules: rules as unknown as Prisma.InputJsonValue } : {}),
            createdAt: now,
            updatedAt: now,
            createdById: actor.audience === 'office' ? actor.actorId : null,
          },
          select: { id: true },
        })
        const row = await tx.brandingSet.findUniqueOrThrow({ where: { id }, select: SET_COLUMNS })
        tools.audit({ recordType: 'BrandingSet', recordId: id, companyId: body.companyId, after: { ...shapeOf(row), partyId: body.partyId, ...(old ? { replaces: old.code } : {}) }, ...(body.reason ? { reason: body.reason } : {}) })
        tools.emit({ type: 'branding_set.changed', subject: id, companyId: body.companyId, payload: { brandingSetId: id, partyId: body.partyId, code: fields.code, change: 'CREATED', fields: [] } })
        return answer(tools, id)
      }),
    taken,
  )
  return result
}

/** Refuses a change of an archived set (restore it first). */
function active(set: SetRowData): void {
  if (set.status !== 'ACTIVE') throw new InvalidStateError(archivedSetRefusal(set.code))
}

/** PATCH /product/branding-sets/:setId */
export async function updateSet(caller: CommandCaller, setId: string, body: UpdateSetBody, idempotencyKey?: string): Promise<BrandingSetView> {
  const seen = await readSet(caller, setId)
  assertMayKeep(caller, seen.companyId, seen.partyId)
  const rules = body.packagingRules ? rulesOf(body.packagingRules) : undefined
  const { result } = await libraryGuarded(() =>
    command(caller, { name: 'product.branding.update', idempotencyKey, input: { setId, ...body }, record: { type: 'BrandingSet', id: setId, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const before = await tx.brandingSet.findUniqueOrThrow({ where: { id: setId }, select: SET_COLUMNS })
      active(before)
      const fields = { code: before.code, name: body.name === undefined ? before.name : body.name.trim(), note: body.note === undefined ? before.note : body.note?.trim() ? body.note.trim() : null }
      const issues: Issue[] = [...setProblems(fields)]
      // A file list is reordered or shortened here: a file it does not hold is added through POST …/files first.
      for (const [list, held, path] of [
        [body.logoFileIds, before.logoFileIds, 'body/logoFileIds'],
        [body.labelArtworkFileIds, before.labelArtworkFileIds, 'body/labelArtworkFileIds'],
      ] as const) {
        if (list === undefined) continue
        issues.push(...idListProblems(list, path, BRANDING_LIMITS.files))
        if (unknownFiles(list, held).length > 0) issues.push({ path, message: 'A file is added to the set first (Add a logo or artwork); here the files are only reordered or removed.' })
      }
      issues.push(...(await referenceProblems(tx, before.companyId, body.brandColourIds, rules, before)))
      if (issues.length > 0) throw invalid(issues)
      await tx.brandingSet.update({
        where: { id: setId },
        data: {
          name: fields.name,
          note: fields.note,
          ...(body.brandColourIds ? { brandColourIds: [...body.brandColourIds] } : {}),
          ...(body.logoFileIds ? { logoFileIds: [...body.logoFileIds] } : {}),
          ...(body.labelArtworkFileIds ? { labelArtworkFileIds: [...body.labelArtworkFileIds] } : {}),
          ...(rules && rules.length > 0 ? { packagingRules: rules as unknown as Prisma.InputJsonValue } : {}),
        },
        select: { id: true },
      })
      // No rule left: the column back to NULL (factory-db exports no runtime DbNull).
      if (rules && rules.length === 0 && before.packagingRules !== null) await tx.$executeRaw`UPDATE "BrandingSet" SET "packagingRules" = NULL WHERE "id" = ${setId}::uuid`
      const after = await tx.brandingSet.findUniqueOrThrow({ where: { id: setId }, select: SET_COLUMNS })
      const [shapeBefore, shapeAfter] = [shapeOf(before), shapeOf(after)]
      const changed = (Object.keys(shapeAfter) as (keyof typeof shapeAfter)[]).filter((key) => JSON.stringify(shapeBefore[key]) !== JSON.stringify(shapeAfter[key]))
      tools.audit({ recordType: 'BrandingSet', recordId: setId, companyId: before.companyId, before: shapeBefore, after: shapeAfter, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'branding_set.changed', subject: setId, companyId: before.companyId, payload: { brandingSetId: setId, partyId: before.partyId, code: before.code, change: 'UPDATED', fields: changed } })
      return answer(tools, setId)
    }),
  )
  return result
}

/** POST /product/branding-sets/:setId/files */
export async function addSetFile(caller: CommandCaller, setId: string, body: AddSetFileBody, idempotencyKey?: string): Promise<BrandingSetView> {
  const seen = await readSet(caller, setId)
  assertMayKeep(caller, seen.companyId, seen.partyId)
  const { result } = await libraryGuarded(() =>
    command(caller, { name: 'product.branding.addFile', idempotencyKey, input: { setId, ...body }, record: { type: 'BrandingSet', id: setId, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const before = await tx.brandingSet.findUniqueOrThrow({ where: { id: setId }, select: SET_COLUMNS })
      active(before)
      const file = await tx.storedFile.findUnique({ where: { id: body.fileId }, select: { id: true, recordType: true, recordId: true, kind: true, status: true, contentType: true, originalName: true } })
      const path = 'body/fileId'
      if (!file || file.recordType !== 'BrandingSet' || file.recordId !== setId) throw invalid([{ path, message: 'Send the file as a file of this set first (recordType BrandingSet).' }])
      if (file.status !== 'AVAILABLE') throw new ConflictError(`${file.originalName} is not available yet (being checked, or removed): add it once it is.`)
      if (!FILE_KINDS_OF_ROLE[body.role].includes(file.kind) || (body.role === 'LOGO' && !isDrawnPicture(file.contentType))) {
        throw invalid([{ path, message: body.role === 'LOGO' ? 'A logo is a picture: JPEG, PNG or WebP.' : 'Label artwork is a picture or a document (PDF).' }])
      }
      if (before.logoFileIds.includes(file.id) || before.labelArtworkFileIds.includes(file.id)) throw new ConflictError(`${file.originalName} is in the set already.`)
      const list = body.role === 'LOGO' ? before.logoFileIds : before.labelArtworkFileIds
      if (list.length >= BRANDING_LIMITS.files) throw new ConflictError(`A set keeps at most ${BRANDING_LIMITS.files} ${body.role === 'LOGO' ? 'logos' : 'artwork files'}: remove one first.`)
      await tx.brandingSet.update({ where: { id: setId }, data: body.role === 'LOGO' ? { logoFileIds: [...list, file.id] } : { labelArtworkFileIds: [...list, file.id] }, select: { id: true } })
      tools.audit({ recordType: 'BrandingSet', recordId: setId, companyId: before.companyId, after: { added: { fileId: file.id, role: body.role, name: file.originalName } } })
      tools.emit({ type: 'branding_set.changed', subject: setId, companyId: before.companyId, payload: { brandingSetId: setId, partyId: before.partyId, code: before.code, change: 'FILE_ADDED', fields: [body.role === 'LOGO' ? 'logoFileIds' : 'labelArtworkFileIds'] } })
      return answer(tools, setId)
    }),
  )
  return result
}

/** POST /product/branding-sets/:setId/archive | restore */
export async function setSetStatus(caller: CommandCaller, setId: string, to: 'ACTIVE' | 'ARCHIVED', body: SetStatusBody, idempotencyKey?: string): Promise<BrandingSetView> {
  const seen = await readSet(caller, setId)
  assertMayKeep(caller, seen.companyId, seen.partyId)
  const { result } = await libraryGuarded(() =>
    command(
      caller,
      { name: to === 'ARCHIVED' ? 'product.branding.archive' : 'product.branding.restore', idempotencyKey, input: { setId, ...body }, record: { type: 'BrandingSet', id: setId, expectedVersion: body.version } },
      async (tools) => {
        const { tx } = tools
        const before = await tx.brandingSet.findUniqueOrThrow({ where: { id: setId }, select: SET_COLUMNS })
        if (before.status === to) throw new InvalidStateError(to === 'ARCHIVED' ? `Branding set ${before.code} is archived already.` : `Branding set ${before.code} is in use already.`)
        if (to === 'ACTIVE') {
          const other = await tx.brandingSet.findFirst({ where: { companyId: before.companyId, partyId: before.partyId, status: 'ACTIVE' }, select: { code: true } })
          if (other) throw new ConflictError(otherActiveRefusal(before.code, other.code))
        }
        await tx.brandingSet.update({ where: { id: setId }, data: { status: to }, select: { id: true } })
        tools.audit({ recordType: 'BrandingSet', recordId: setId, companyId: before.companyId, before: { status: before.status }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
        tools.emit({ type: 'branding_set.changed', subject: setId, companyId: before.companyId, payload: { brandingSetId: setId, partyId: before.partyId, code: before.code, change: to === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED', fields: ['status'] } })
        return answer(tools, setId)
      },
    ),
  )
  return result
}
