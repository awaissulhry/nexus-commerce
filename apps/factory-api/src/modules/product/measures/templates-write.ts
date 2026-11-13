import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { MEASUREMENT_TEMPLATE_CHANGES } from '@nexus/factory-domain/mtm-office/events'
import { baseSizeRuleOf, baseSizeRuleProblems, rulesProblems, rulesSummary, sameDecimal, type TemplatePoint } from '@nexus/factory-domain/product/mtm-rules/rules'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { editTemplateBody, newTemplateBody, templateMoveBody, templatePointsBody, templateView, type EditTemplateBody, type NewTemplateBody, type TemplatePointBody, type TemplatePointsBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { mayWrite } from '../materials/store'
import { checkTemplateOf, readTemplate, readTemplateFor, ruleFieldsOf, type PointRow, type Reader, type TemplateRecord } from '../mtm-rules/store'
import { assertMayWrite, contextOf, invalid, isUniqueViolation } from './store'

/**
 * Measurement templates (B-W2b-358; B-W1-17 deferred on 10-28 comes back here; PRD-200; design products.sizes › Measurement
 * templates, the made-to-measure office's "Measurement templates (opens Products › Sizes & measurements)"): which body measures
 * a made-to-measure garment of one type takes, in order, each with its unit, plausible range, how to measure it and its library
 * point of measure. The list is B-W2b-283's GET /product/measurement-templates; the made-to-measure rules of a template are
 * B-W2b-248's (…/mtm-rules: read, saved, switched by the Owner). Office only, the size library's permissions:
 *
 *   GET   /product/measurement-templates/:templateId          product.styles.view: the template page (header, points with how
 *                                                             many active rules check each, B-W2b-248's rules in words, the
 *                                                             styles and profiles measured with it, editable or why not)
 *   POST  /product/measurement-templates                      product.styles.manage: a template with its points (code unique in
 *                                                             the tenant: a profile's garment type; it never changes)
 *   PATCH /product/measurement-templates/:templateId          product.styles.manage: name, words, product type, instructions
 *   PUT   /product/measurement-templates/:templateId/points   product.styles.manage: the whole list of points in order (kept by
 *                                                             code, changed, added; one left out is archived, never deleted:
 *                                                             profiles keep its values)
 *   POST  /product/measurement-templates/:templateId/archive  product.styles.manage (with its rules off and no style measured
 *   POST  /product/measurement-templates/:templateId/restore  with it) / back to ACTIVE
 *
 * A template of every company is changed only by a role over every company. Every write is ONE command on the template (its
 * version compared and bumped), its rules re-checked against the points as they will be (B-W2b-248's rulesProblems and base size
 * rule: an active rule never names an archived point, an ORDER rule compares points of one unit), audited on the template,
 * measurement_template.changed. Made-to-measure stays off: nothing here turns a template's rules on (product.mtm.switch, the
 * Owner's word).
 */

// The routes' contracts (factory-domain sales/mtm/contracts; no money).
const templateParams = input({ templateId: id() })
const one = output({ template: templateView })
export const getTemplateContract = defineContract({ params: templateParams, response: { 200: one } })
export const newTemplateContract = defineContract({ body: newTemplateBody, response: { 201: one } })
export const editTemplateContract = defineContract({ params: templateParams, body: editTemplateBody, response: { 200: one } })
export const templatePointsContract = defineContract({ params: templateParams, body: templatePointsBody, response: { 200: one } })
export const moveTemplateContract = defineContract({ params: templateParams, body: templateMoveBody, response: { 200: one } })

type Change = (typeof MEASUREMENT_TEMPLATE_CHANGES)[number]
const NOUN = 'measurement template'
const DECIMAL = /^\d{1,6}(?:\.\d{1,2})?$/

const changed = (tools: CommandTools, template: { id: string; code: string; companyId: string | null }, change: Change): void =>
  tools.emit({ type: 'measurement_template.changed', subject: template.id, companyId: template.companyId, payload: { templateId: template.id, code: template.code, change } })

const words = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
const plain = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))
const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** A point's own problems (its range, its library point checked in the command). */
function pointProblems(points: readonly TemplatePointBody[]): Issue[] {
  const out: Issue[] = []
  const seen = new Set<string>()
  points.forEach((point, index) => {
    const at = `body/points/${index}`
    if (seen.has(point.code)) out.push({ path: `${at}/code`, message: `${point.code} is named twice: each point once.` })
    seen.add(point.code)
    for (const field of ['minValue', 'maxValue'] as const) {
      const value = blank(point[field])
      if (value !== null && !DECIMAL.test(value)) out.push({ path: `${at}/${field}`, message: 'A number of 0 or more with at most 6 digits and 2 decimals.' })
    }
    const min = blank(point.minValue)
    const max = blank(point.maxValue)
    if (min !== null && max !== null && DECIMAL.test(min) && DECIMAL.test(max) && Number(min) > Number(max)) out.push({ path: `${at}/maxValue`, message: 'The plausible range: its lowest value is not above its highest.' })
  })
  return out
}

/** The library points named: BODY points of the point's own unit (the database's MeasurementPoint_mtm_depth). */
async function libraryProblems(db: Reader, points: readonly TemplatePointBody[]): Promise<Issue[]> {
  const ids = [...new Set(points.flatMap((point) => (point.pointOfMeasureId ? [point.pointOfMeasureId] : [])))]
  if (ids.length === 0) return []
  const rows = new Map((await db.pointOfMeasure.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, uom: true } })).map((row) => [row.id, row]))
  return points.flatMap((point, index) => {
    if (!point.pointOfMeasureId) return []
    const row = rows.get(point.pointOfMeasureId)
    if (!row) return [{ path: `body/points/${index}/pointOfMeasureId`, message: 'Not a point of measure of the library.' }]
    if (row.kind !== 'BODY' || row.uom !== point.uom) return [{ path: `body/points/${index}/pointOfMeasureId`, message: `A BODY point of measure in ${point.uom.toLowerCase()} (the point's own unit).` }]
    return []
  })
}

/** The template page (see the file's head). */
async function viewOf(db: Reader, record: TemplateRecord, context: RequestContext) {
  const { template, points } = record
  const extra = await db.measurementTemplate.findUnique({ where: { id: template.id }, select: { instructions: true } })
  const howTo = new Map((await db.measurementPoint.findMany({ where: { templateId: template.id }, select: { id: true, howTo: true } })).map((row) => [row.id, row.howTo]))
  const active = record.rules.filter((rule) => rule.status === 'ACTIVE')
  const measured = await db.style.count({ where: { measurementTemplateId: template.id } })
  const madeToMeasure = await db.style.count({ where: { measurementTemplateId: template.id, mtmAllowed: true } })
  const profiles = await db.measurementProfile.count({ where: { garmentType: template.code } })
  const editable = mayWrite(actorOf(context), PRODUCT_STYLES_MANAGE, template.companyId)
  return {
    id: template.id,
    companyId: template.companyId,
    code: template.code,
    name: template.name,
    nameI18n: words(template.nameI18n),
    productType: template.productType,
    instructions: extra?.instructions ?? null,
    status: template.status === 'ARCHIVED' ? ('ARCHIVED' as const) : ('ACTIVE' as const),
    rulesOn: template.rulesOn,
    rulesSummary: rulesSummary(checkTemplateOf(record)),
    version: template.version,
    updatedAt: toUtcIso(template.updatedAt),
    points: points.map((point) => ({
      id: point.id,
      code: point.code,
      name: point.name,
      nameI18n: words(point.nameI18n),
      seq: point.seq,
      uom: point.uom,
      minValue: plain(point.minValue),
      maxValue: plain(point.maxValue),
      required: point.required,
      howTo: howTo.get(point.id) ?? null,
      pointOfMeasureId: point.pointOfMeasureId,
      status: point.status === 'ARCHIVED' ? ('ARCHIVED' as const) : ('ACTIVE' as const),
      rules: active.filter((rule) => rule.pointId === point.id || rule.otherPointId === point.id).length,
    })),
    styles: { measured, madeToMeasure },
    profiles,
    editable,
    refusal: editable ? null : template.companyId === null ? 'A measurement template of every company is changed only by a role over every company.' : 'Your roles do not change the size library of this company.',
  }
}

/** GET /product/measurement-templates/:templateId */
export async function getTemplate(caller: CommandCaller, templateId: string) {
  const context = contextOf(caller)
  const record = await readTemplateFor(caller, templateId)
  return { template: await caller.withClient((db) => viewOf(db, record, context)) }
}

const pointData = (point: TemplatePointBody, seq: number) => ({
  name: point.name,
  nameI18n: point.nameI18n ? { ...point.nameI18n } : undefined,
  seq,
  uom: point.uom,
  minValue: blank(point.minValue),
  maxValue: blank(point.maxValue),
  required: point.required,
  howTo: blank(point.howTo),
  pointOfMeasureId: point.pointOfMeasureId ?? null,
})

/** POST /product/measurement-templates */
export async function createTemplate(caller: CommandCaller, body: NewTemplateBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (body.companyId !== null && !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: body.companyId })) throw new NotFoundError('Company not found.')
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, body.companyId, NOUN)
  const problems = [...pointProblems(body.points), ...(await caller.withClient((db) => libraryProblems(db, body.points)))]
  if (problems.length > 0) throw invalid(problems, NOUN)
  const { result } = await command(caller, { name: 'product.templates.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (await tx.measurementTemplate.findFirst({ where: { code: body.code }, select: { id: true } })) throw new ConflictError(`Measurement template ${body.code} exists already: a garment type has one template.`)
    const id = newId()
    const createdById = context.audience === 'office' ? context.actorId : null
    await tx.measurementTemplate.create({
      data: { id, companyId: body.companyId, code: body.code, name: body.name, ...(body.nameI18n ? { nameI18n: { ...body.nameI18n } } : {}), productType: body.productType, instructions: blank(body.instructions), createdAt: now, updatedAt: now, createdById },
      select: { id: true },
    })
    for (const [index, point] of body.points.entries()) {
      await tx.measurementPoint.create({ data: { id: newId(), templateId: id, code: point.code, ...pointData(point, index + 1), createdAt: now, updatedAt: now, createdById }, select: { id: true } })
    }
    tools.audit({ recordType: 'MeasurementTemplate', recordId: id, companyId: body.companyId, after: { code: body.code, name: body.name, productType: body.productType, points: body.points.map((point) => point.code), rulesOn: false } })
    changed(tools, { id, code: body.code, companyId: body.companyId }, 'CREATED')
    return { id }
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError(`Measurement template ${body.code} exists already: a garment type has one template.`)
    throw error
  })
  const record = await readTemplateFor(caller, result.id)
  return { template: await caller.withClient((db) => viewOf(db, record, context)) }
}

async function writable(caller: CommandCaller, templateId: string) {
  const context = contextOf(caller)
  const seen = await readTemplateFor(caller, templateId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.template.companyId, NOUN)
  return { context, seen }
}

/** PATCH /product/measurement-templates/:templateId */
export async function editTemplate(caller: CommandCaller, templateId: string, body: EditTemplateBody, idempotencyKey?: string) {
  const { context } = await writable(caller, templateId)
  const { result } = await command(caller, { name: 'product.templates.edit', idempotencyKey, input: { templateId, ...body }, record: { type: 'MeasurementTemplate', id: templateId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.measurementTemplate.findUnique({ where: { id: templateId }, select: { id: true, code: true, companyId: true, name: true, nameI18n: true, productType: true, instructions: true, status: true } })
    if (!row) throw new NotFoundError('Measurement template not found.')
    if (row.status !== 'ACTIVE') throw new InvalidStateError(`Measurement template ${row.code} is archived: restore it to change it.`)
    if (body.productType !== undefined && body.productType !== row.productType) {
      const styles = await tx.style.count({ where: { measurementTemplateId: templateId } })
      if (styles > 0) throw new ConflictError(`${styles} style(s) of ${row.productType} are measured with ${row.code}: it keeps its product type (a new type is a new template).`)
    }
    const data = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.nameI18n !== undefined && body.nameI18n !== null ? { nameI18n: { ...body.nameI18n } } : {}),
      ...(body.productType !== undefined ? { productType: body.productType } : {}),
      ...(body.instructions !== undefined ? { instructions: blank(body.instructions) } : {}),
    }
    await tx.measurementTemplate.update({ where: { id: templateId }, data: { ...data, updatedAt: now }, select: { id: true } })
    if (body.nameI18n === null) await tx.$executeRaw`UPDATE "MeasurementTemplate" SET "nameI18n" = NULL WHERE "id" = ${templateId}::uuid`
    tools.audit({ recordType: 'MeasurementTemplate', recordId: templateId, companyId: row.companyId, before: { name: row.name, nameI18n: row.nameI18n, productType: row.productType, instructions: row.instructions }, after: { ...data, ...(body.nameI18n === null ? { nameI18n: null } : {}) } })
    changed(tools, row, 'UPDATED')
    return { id: templateId }
  })
  const record = await readTemplateFor(caller, result.id)
  return { template: await caller.withClient((db) => viewOf(db, record, context)) }
}

/** The points as they will be (kept by code; one left out archived), as B-W2b-248's rules read them. */
function nextPoints(rows: readonly PointRow[], body: readonly TemplatePointBody[]): TemplatePoint[] {
  const named = new Map(body.map((point) => [point.code, point]))
  const kept = rows.map((row) => {
    const next = named.get(row.code)
    return { id: row.id, code: row.code, name: next?.name ?? row.name, uom: next?.uom ?? row.uom, status: next ? 'ACTIVE' : 'ARCHIVED', alterationMinus: plain(row.alterationMinus), alterationPlus: plain(row.alterationPlus) }
  })
  const added = body.filter((point) => !rows.some((row) => row.code === point.code)).map((point) => ({ id: `new:${point.code}`, code: point.code, name: point.name, uom: point.uom, status: 'ACTIVE', alterationMinus: null, alterationPlus: null }))
  return [...kept, ...added]
}

/** PUT /product/measurement-templates/:templateId/points */
export async function replacePoints(caller: CommandCaller, templateId: string, body: TemplatePointsBody, idempotencyKey?: string) {
  const { context } = await writable(caller, templateId)
  const own = [...pointProblems(body.points), ...(await caller.withClient((db) => libraryProblems(db, body.points)))]
  if (own.length > 0) throw invalid(own, NOUN)
  const { result } = await command(caller, { name: 'product.templates.points', idempotencyKey, input: { templateId, ...body }, record: { type: 'MeasurementTemplate', id: templateId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const record = await readTemplate(tx, { id: templateId })
    if (!record) throw new NotFoundError('Measurement template not found.')
    const { template } = record
    if (template.status !== 'ACTIVE') throw new InvalidStateError(`Measurement template ${template.code} is archived: restore it to change its points.`)
    // B-W2b-248's check: the template's rules and base size rule still hold on the points as they will be.
    const points = nextPoints(record.points, body.points)
    const rules = ruleFieldsOf(record.rules, record.points.map((row) => ({ ...row, uom: points.find((point) => point.id === row.id)!.uom as PointRow['uom'] })))
    const ruleIssues = [...rulesProblems(rules, points), ...baseSizeRuleProblems(baseSizeRuleOf(template.baseSizeRule), points.filter((point) => point.status === 'ACTIVE'))]
    if (ruleIssues.length > 0) {
      throw new ValidationError(
        `The made-to-measure rules of ${template.code} still need these points as they are: change the rules first (${ruleIssues[0]!.message})`,
        ruleIssues.map((issue) => ({ path: `template/${issue.path}`, message: issue.message })),
      )
    }
    const createdById = context.audience === 'office' ? context.actorId : null
    const archived: string[] = []
    const updated: string[] = []
    const added: string[] = []
    // Every seq moves aside first: the new order never meets the old one half-way (no unique key on seq; kept tidy anyway).
    for (const row of record.points) {
      const next = body.points.findIndex((point) => point.code === row.code)
      if (next === -1) {
        if (row.status !== 'ARCHIVED') {
          await tx.measurementPoint.update({ where: { id: row.id }, data: { status: 'ARCHIVED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
          archived.push(row.code)
        }
        continue
      }
      const point = body.points[next]!
      const data = pointData(point, next + 1)
      const same =
        row.status === 'ACTIVE' &&
        row.name === data.name &&
        row.seq === data.seq &&
        row.uom === data.uom &&
        sameDecimal(plain(row.minValue), data.minValue) &&
        sameDecimal(plain(row.maxValue), data.maxValue) &&
        row.required === data.required &&
        row.pointOfMeasureId === data.pointOfMeasureId &&
        JSON.stringify(words(row.nameI18n)) === JSON.stringify(point.nameI18n ? { ...point.nameI18n } : {})
      const howTo = (await tx.measurementPoint.findUnique({ where: { id: row.id }, select: { howTo: true } }))?.howTo ?? null
      if (same && howTo === data.howTo) continue
      await tx.measurementPoint.update({ where: { id: row.id }, data: { ...data, status: 'ACTIVE', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      updated.push(row.code)
    }
    for (const [index, point] of body.points.entries()) {
      if (record.points.some((row) => row.code === point.code)) continue
      await tx.measurementPoint.create({ data: { id: newId(), templateId, code: point.code, ...pointData(point, index + 1), createdAt: now, updatedAt: now, createdById }, select: { id: true } })
      added.push(point.code)
    }
    const anything = archived.length + updated.length + added.length > 0
    if (anything) await tx.measurementTemplate.update({ where: { id: templateId }, data: { updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'MeasurementTemplate', recordId: templateId, companyId: template.companyId, before: { points: record.points.filter((row) => row.status === 'ACTIVE').map((row) => row.code) }, after: anything ? { points: body.points.map((point) => point.code), added, updated, archived } : { unchanged: true } })
    if (anything) changed(tools, template, 'POINTS')
    return { id: templateId }
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('Another change added a point with the same code at the same time: load the template again.')
    throw error
  })
  const record = await readTemplateFor(caller, result.id)
  return { template: await caller.withClient((db) => viewOf(db, record, context)) }
}

/** POST /product/measurement-templates/:templateId/archive | /restore */
export async function moveTemplate(caller: CommandCaller, templateId: string, to: 'ARCHIVED' | 'ACTIVE', body: { readonly version: number }, idempotencyKey?: string) {
  const { context } = await writable(caller, templateId)
  const { result } = await command(caller, { name: to === 'ARCHIVED' ? 'product.templates.archive' : 'product.templates.restore', idempotencyKey, input: { templateId, ...body }, record: { type: 'MeasurementTemplate', id: templateId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.measurementTemplate.findUnique({ where: { id: templateId }, select: { id: true, code: true, companyId: true, status: true, rulesOn: true } })
    if (!row) throw new NotFoundError('Measurement template not found.')
    if (row.status === to) throw new InvalidStateError(`Measurement template ${row.code} is ${to === 'ARCHIVED' ? 'archived' : 'active'} already.`)
    if (to === 'ARCHIVED') {
      if (row.rulesOn) throw new ConflictError(`The made-to-measure rules of ${row.code} are on: they are turned off first (product.mtm.switch).`)
      const styles = await tx.style.count({ where: { measurementTemplateId: templateId, status: { not: 'ARCHIVED' } } })
      if (styles > 0) throw new ConflictError(`${styles} style(s) are measured with ${row.code}: give them another template first.`)
    }
    await tx.measurementTemplate.update({ where: { id: templateId }, data: { status: to, updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'MeasurementTemplate', recordId: templateId, companyId: row.companyId, before: { status: row.status }, after: { status: to } })
    changed(tools, row, to === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED')
    return { id: templateId }
  })
  const record = await readTemplateFor(caller, result.id)
  return { template: await caller.withClient((db) => viewOf(db, record, context)) }
}
