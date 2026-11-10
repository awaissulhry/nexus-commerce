import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { ColourLibraryRow, ColourStatusBody, CreateColourBody, UpdateColourBody } from '@nexus/factory-domain/product/colours/contracts'
import { PRODUCT_COLOURS_MANAGE } from '@nexus/factory-domain/product/colours/permissions'
import { archivedRefusal, colourProblems, normaliseColour, statusRefusal, type ColourFields } from '@nexus/factory-domain/product/colours/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMayWrite, contextOf } from '../styles/store'
import { COLOUR_COLUMNS, libraryGuarded, namesOf, readColour, viewsOf, type ColourRowData } from './store'

/**
 * The colour library's writes (B-W2b-247; PRD-041): a new colour, a change at its version, archive and restore. Kept by
 * product.colours.manage over the colour's company (a colour of every company: a grant over every company). Every write is
 * one command: the database's Colour_system_check said first in words (factory-domain colours/rules), an audit row and
 * colour.changed. A colour is never deleted: archived, it stays on what names it and no new colourway or material colour
 * can pick it (W1's pickers read ACTIVE colours only).
 *
 *   POST  /product/colours                        {companyId, code, name, names?, system?, reference?, family?, hex?}
 *   PATCH /product/colours/:colourId               {version, name?, names?, system?, reference?, family?, hex?}
 *   POST  /product/colours/:colourId/archive | restore   {version, reason?}
 */

const invalid = (issues: { path: string; message: string }[]) => new ValidationError('The colour is not valid.', issues)

/** What a change keeps of the fields; the names (Json) apart: set, or cleared in SQL (factory-db exports no runtime DbNull). */
const dataOf = (fields: ColourFields): Prisma.ColourUncheckedUpdateInput => ({
  name: fields.name,
  ...(Object.keys(fields.names).length > 0 ? { nameI18n: fields.names } : {}),
  system: fields.system,
  reference: fields.reference,
  family: fields.family,
  hex: fields.hex ?? null,
})

/** The audited shape of a row. */
const shapeOf = (row: ColourRowData) => ({ code: row.code, name: row.name, names: namesOf(row.nameI18n), system: row.system, reference: row.reference, family: row.family, hex: row.hex, status: row.status })

/** The fields that differ between two shapes (the event's `fields`). */
function changedFields(before: ReturnType<typeof shapeOf>, after: ReturnType<typeof shapeOf>): string[] {
  return (Object.keys(after) as (keyof typeof after)[]).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
}

async function answer(tools: CommandTools, id: string): Promise<ColourLibraryRow> {
  const row = await tools.tx.colour.findUniqueOrThrow({ where: { id }, select: COLOUR_COLUMNS })
  return (await viewsOf(tools.tx, actorOf(tools.context), [row]))[0]!
}

/** POST /product/colours */
export async function createColour(caller: CommandCaller, body: CreateColourBody, idempotencyKey?: string): Promise<ColourLibraryRow> {
  const context = contextOf(caller)
  assertMayWrite(context, PRODUCT_COLOURS_MANAGE, body.companyId)
  const fields = normaliseColour(body)
  const problems = colourProblems(fields)
  if (problems.length > 0) throw invalid(problems)
  const id = newId()
  const taken = () => `The colour code ${fields.code} is taken: pick another.`
  const { result } = await libraryGuarded(
    () =>
      command(caller, { name: 'product.colours.create', idempotencyKey, input: body }, async (tools) => {
        const { tx, now, context: actor } = tools
        if (body.companyId !== null && !(await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) {
          throw invalid([{ path: 'body/companyId', message: 'No such company.' }])
        }
        // Codes are unique in the tenant, archived colours included (restore one instead).
        const holder = await tx.colour.findFirst({ where: { code: fields.code }, select: { status: true } })
        if (holder) throw new ConflictError(holder.status === 'ARCHIVED' ? `The colour code ${fields.code} is taken by an archived colour: restore it instead.` : taken())
        await tx.colour.create({
          data: {
            id,
            companyId: body.companyId,
            code: fields.code,
            name: fields.name,
            ...(Object.keys(fields.names).length > 0 ? { nameI18n: fields.names } : {}),
            system: fields.system,
            reference: fields.reference,
            family: fields.family,
            hex: fields.hex ?? null,
            createdAt: now,
            updatedAt: now,
            createdById: actor.audience === 'office' ? actor.actorId : null,
          },
          select: { id: true },
        })
        const row = await tx.colour.findUniqueOrThrow({ where: { id }, select: COLOUR_COLUMNS })
        tools.audit({ recordType: 'Colour', recordId: id, companyId: body.companyId, after: shapeOf(row), ...(body.reason ? { reason: body.reason } : {}) })
        tools.emit({ type: 'colour.changed', subject: id, companyId: body.companyId, payload: { colourId: id, code: fields.code, change: 'CREATED', fields: [] } })
        return answer(tools, id)
      }),
    taken,
  )
  return result
}

/** PATCH /product/colours/:colourId */
export async function updateColour(caller: CommandCaller, colourId: string, body: UpdateColourBody, idempotencyKey?: string): Promise<ColourLibraryRow> {
  const context = contextOf(caller)
  const seen = await readColour(caller, colourId)
  assertMayWrite(context, PRODUCT_COLOURS_MANAGE, seen.companyId)
  const { result } = await libraryGuarded(() =>
    command(caller, { name: 'product.colours.update', idempotencyKey, input: { colourId, ...body }, record: { type: 'Colour', id: colourId, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const row = await tx.colour.findUniqueOrThrow({ where: { id: colourId }, select: COLOUR_COLUMNS })
      if (row.status === 'ARCHIVED') throw new InvalidStateError(archivedRefusal(row.code))
      const names = namesOf(row.nameI18n)
      const system = body.system === undefined ? row.system : body.system
      const fields = normaliseColour({
        code: row.code,
        name: body.name ?? row.name,
        names: body.names === undefined ? names : { ...names, ...body.names },
        system,
        reference: body.reference === undefined ? row.reference : body.reference,
        family: body.family === undefined ? row.family : body.family,
        hex: body.hex === undefined ? row.hex : body.hex,
      })
      // A system cleared takes its reference with it (a reference only with its system).
      const kept = system === null && body.reference === undefined ? { ...fields, reference: null } : fields
      const problems = colourProblems(kept)
      if (problems.length > 0) throw invalid(problems)
      await tx.colour.update({ where: { id: colourId }, data: dataOf(kept), select: { id: true } })
      if (Object.keys(kept.names).length === 0 && row.nameI18n !== null) await tx.$executeRaw`UPDATE "Colour" SET "nameI18n" = NULL WHERE "id" = ${colourId}::uuid`
      const after = await tx.colour.findUniqueOrThrow({ where: { id: colourId }, select: COLOUR_COLUMNS })
      const fieldsChanged = changedFields(shapeOf(row), shapeOf(after))
      tools.audit({ recordType: 'Colour', recordId: colourId, companyId: row.companyId, before: shapeOf(row), after: shapeOf(after), ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'colour.changed', subject: colourId, companyId: row.companyId, payload: { colourId, code: row.code, change: 'UPDATED', fields: fieldsChanged } })
      return answer(tools, colourId)
    }),
  )
  return result
}

/** POST /product/colours/:colourId/archive | restore */
export async function setColourStatus(caller: CommandCaller, colourId: string, to: 'ACTIVE' | 'ARCHIVED', body: ColourStatusBody, idempotencyKey?: string): Promise<ColourLibraryRow> {
  const context = contextOf(caller)
  const seen = await readColour(caller, colourId)
  assertMayWrite(context, PRODUCT_COLOURS_MANAGE, seen.companyId)
  const { result } = await command(
    caller,
    { name: to === 'ARCHIVED' ? 'product.colours.archive' : 'product.colours.restore', idempotencyKey, input: { colourId, ...body }, record: { type: 'Colour', id: colourId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.colour.findUniqueOrThrow({ where: { id: colourId }, select: COLOUR_COLUMNS })
      const refusal = statusRefusal(row.status, to, row.code)
      if (refusal) throw new InvalidStateError(refusal)
      await tx.colour.update({ where: { id: colourId }, data: { status: to }, select: { id: true } })
      tools.audit({ recordType: 'Colour', recordId: colourId, companyId: row.companyId, before: { status: row.status }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'colour.changed', subject: colourId, companyId: row.companyId, payload: { colourId, code: row.code, change: to === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED', fields: ['status'] } })
      return answer(tools, colourId)
    },
  )
  return result
}
