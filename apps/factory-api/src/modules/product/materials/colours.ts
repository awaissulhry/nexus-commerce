import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { colourProblems, normaliseColour } from '@nexus/factory-domain/product/materials/colours'
import type { MaterialView, UpdateColourBody } from '@nexus/factory-domain/product/materials/contracts'
import { PRODUCT_MATERIALS_MANAGE } from '@nexus/factory-domain/product/materials/permissions'
import { materialMachine } from '@nexus/factory-domain/product/materials/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMayWrite, contextOf, COLOUR_COLUMNS, isUniqueViolation, libraryColourProblems, readMaterial, viewInTx, type MaterialRowData } from './store'

/**
 * A material's colours (feature PRD-032): added, changed, removed (archived: no runtime role deletes product rows, and
 * BOM lines point at them) and restored. A colour has its own version, so a colour change never clashes with an edit
 * of the material itself. Each write records an audit row on the colour and one on its material (the material's
 * history shows its colours), and the material.colours_changed event.
 */

function activeMaterial(material: MaterialRowData): void {
  if (material.status !== 'ACTIVE') throw new InvalidStateError('This material is archived: reactivate it before changing its colours.')
}

function recordOnMaterial(tools: CommandTools, material: MaterialRowData, colourId: string, change: { before?: unknown; after: unknown }): void {
  tools.audit({ recordType: 'Item', recordId: material.id, companyId: material.companyId, ...(change.before === undefined ? {} : { before: { colour: change.before } }), after: { colour: change.after } })
  tools.emit({ type: 'material.colours_changed', subject: material.id, companyId: material.companyId, payload: { itemId: material.id, code: material.code, itemColourIds: [colourId] } })
}

export interface AddColour {
  readonly code: string
  readonly name: string
  readonly supplierColourCode?: string | null | undefined
  readonly colourId?: string | null | undefined
}

/** product.materials.addColour: a new colour of the material; a code it has (also an archived one) is a 409. */
export async function addColour(caller: CommandCaller, materialId: string, body: AddColour, idempotencyKey?: string): Promise<MaterialView> {
  const context = contextOf(caller)
  const material = await readMaterial(caller, materialId)
  assertMayWrite(context, PRODUCT_MATERIALS_MANAGE, material.companyId)
  activeMaterial(material)
  const colour = normaliseColour(body)
  const problems = colourProblems(colour, 'body/')
  if (problems.length > 0) throw new ValidationError('The colour is not valid.', problems)

  const { result } = await command(caller, { name: 'product.materials.addColour', idempotencyKey, input: { materialId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.item.findUniqueOrThrow({ where: { id: materialId }, select: { status: true } })
    if (current.status !== 'ACTIVE') activeMaterial({ ...material, status: current.status })
    const library = await libraryColourProblems(tx, body.colourId, material.companyId, 'body/colourId')
    if (library.length > 0) throw new ValidationError('The colour is not valid.', library)
    const taken = await tx.itemColour.findFirst({ where: { itemId: materialId, code: colour.code }, select: { status: true } })
    if (taken) throw new ConflictError(taken.status === 'ARCHIVED' ? `The material had colour ${colour.code}; restore it instead.` : `The material has colour ${colour.code} already.`)
    const id = newId()
    const row = await tx.itemColour.create({
      data: { id, itemId: materialId, ...colour, colourId: body.colourId ?? null, createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null },
      select: COLOUR_COLUMNS,
    })
    const after = { code: row.code, name: row.name, supplierColourCode: row.supplierColourCode, colourId: row.colourId, status: row.status }
    tools.audit({ recordType: 'ItemColour', recordId: id, companyId: material.companyId, after })
    recordOnMaterial(tools, material, id, { after: { id, ...after } })
    return viewInTx(tx, context, materialId)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError(`The material has colour ${colour.code} already.`)
    throw error
  })
  return result
}

/**
 * product.materials.updateColour: its name, supplier code or library colour (versioned), and `status` ARCHIVED to
 * remove it from new use, ACTIVE to restore it.
 */
export async function updateColour(caller: CommandCaller, materialId: string, colourId: string, body: UpdateColourBody, idempotencyKey?: string): Promise<MaterialView> {
  const context = contextOf(caller)
  const material = await readMaterial(caller, materialId)
  assertMayWrite(context, PRODUCT_MATERIALS_MANAGE, material.companyId)
  activeMaterial(material)
  if (!isUuid(colourId)) throw new NotFoundError('Colour not found.')
  const before = await caller.withClient((client) => client.itemColour.findUnique({ where: { id: colourId }, select: COLOUR_COLUMNS }))
  if (!before || before.itemId !== materialId) throw new NotFoundError('Colour not found.')
  const next = normaliseColour({
    code: before.code,
    name: body.name ?? before.name,
    supplierColourCode: body.supplierColourCode === undefined ? before.supplierColourCode : body.supplierColourCode,
  })
  const problems = colourProblems(next, 'body/')
  if (problems.length > 0) throw new ValidationError('The colour is not valid.', problems)
  const move = body.status !== undefined && body.status !== before.status ? body.status : undefined

  const { result } = await command(
    caller,
    {
      name: 'product.materials.updateColour',
      idempotencyKey,
      input: { materialId, colourId, ...body },
      record: { type: 'ItemColour', id: colourId, expectedVersion: body.version, ...(move ? { transition: { machine: materialMachine, to: move } } : {}) },
    },
    async (tools) => {
      const { tx } = tools
      const current = await tx.item.findUniqueOrThrow({ where: { id: materialId }, select: { status: true } })
      if (current.status !== 'ACTIVE') activeMaterial({ ...material, status: current.status })
      if (body.colourId !== undefined) {
        const library = await libraryColourProblems(tx, body.colourId, material.companyId, 'body/colourId')
        if (library.length > 0) throw new ValidationError('The colour is not valid.', library)
      }
      const data = {
        name: next.name,
        supplierColourCode: next.supplierColourCode,
        ...(body.colourId === undefined ? {} : { colourId: body.colourId }),
      }
      const row = await tx.itemColour.update({ where: { id: colourId }, data, select: COLOUR_COLUMNS })
      const shape = (entry: typeof row) => ({ name: entry.name, supplierColourCode: entry.supplierColourCode, colourId: entry.colourId, status: entry.status })
      tools.audit({ recordType: 'ItemColour', recordId: colourId, companyId: material.companyId, before: shape(before), after: shape(row) })
      recordOnMaterial(tools, material, colourId, { before: { id: colourId, code: before.code, ...shape(before) }, after: { id: colourId, code: row.code, ...shape(row) } })
      return viewInTx(tx, context, materialId)
    },
  )
  return result
}
