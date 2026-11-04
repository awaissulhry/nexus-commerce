import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, holds, type Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_ROLESHEETS_MANAGE } from '@nexus/factory-domain/safety/rolesheets/permissions'
import {
  changesNothing,
  cleanContent,
  contentProblems,
  DEFAULT_VISIT_LAW,
  DEFAULT_VISIT_MONTHS,
  fingerprintOf,
  KIT_LAW,
  normalCode,
  ROLE_SHEET_CODE,
  ROLE_SHEET_LAW,
  ROLE_SHEET_LIMITS,
  sheetChanges,
  sheetImpact,
  SURVEILLANCE_LAW,
  TRAINING_LAW,
  type RoleAsks,
  type SheetChanges,
  type SheetContent,
} from '@nexus/factory-domain/safety/rolesheets/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { actorIdOf, asked, assertMayAt, assertMayWriteAt, assertVersion, bodyIssue, dateOf, officeOf, problemsError, refuse, siteScope, todayOf } from '../organisation/access'
import { holdingsOf, peopleOfRoles, roleNeedsOf } from './needs'
import { changesView, impactView, readSheetRow, refsOf, RECORD_ROLE_SHEET, SHEET_ROW_SELECT, sheetRowView, sheetView, type SheetRow } from './store'

/**
 * The role risk sheets (B-W2b-128; QHS-236; design plant.risk "Role sheets" index, the record's Role sheets tab, the sheet's
 * form card with its EditModeBar, the pop-up "What this changes"; Owner answer H2), office only, each write one command with
 * an Idempotency-Key:
 *
 *   GET   /safety/rolesheets                    the index: role, site, people, risks, PPE items, courses, surveillance, last
 *                                               changed (safety.view; ?companyId&siteId&status&q)
 *   GET   /safety/rolesheets/catalogue          the pickers: the company's ACTIVE PPE items (no cost) and the ACTIVE courses
 *   GET   /safety/rolesheets/:id                the sheet: risks and surveillance needs, the kit with when to wear each item,
 *                                               the courses, the health plan (needed, every how many months), the people
 *   POST  /safety/rolesheets                    add a role (safety.rolesheets.manage): a site of the company, a code unique on
 *                                               the site, a name; its content may come with it (nobody is in it yet)
 *   POST  /safety/rolesheets/:id/preview        "What this changes" for a draft of the whole sheet: the changes, then for the
 *                                               people in the role who now needs which course, which kit items to issue to
 *                                               whom, how many get or lose visits (counts), and its fingerprint
 *   POST  /safety/rolesheets/:id/apply          the same draft in one command: the sheet (version), its items, kit lines,
 *                                               requirements and the role's health plan (needed); with the fingerprint read,
 *                                               a change made meanwhile is refused (IMPACT_CHANGED)
 *   POST  /safety/rolesheets/:id/archive        once nobody active is in the role; /restore brings it back
 *
 * The health plan: the sheet says whether the role needs health surveillance (the design: "needed comes from the role
 * sheet"); a new needed plan asks a yearly visit (the law's rule, art. 41 c.2 b) until the doctor sets the frequency on the
 * health page (B-W2b-135). Which person needs which visit is never said here: visit lines are counts.
 */

const MANAGE_WORDS = 'The role sheets of this site are kept by a role that keeps them (safety.rolesheets.manage).'
const L = ROLE_SHEET_LIMITS
const EMPTY: SheetContent = { items: [], kit: [], requirements: [] }
const LAW = { roleSheet: ROLE_SHEET_LAW, kit: KIT_LAW, training: TRAINING_LAW, surveillance: SURVEILLANCE_LAW, yearlyVisit: DEFAULT_VISIT_LAW }

type Client = FactoryClient | CommandTx

/** The caller holds the permission at the screen's company (or anywhere, when the screen names none). */
const holdsHere = (context: OfficeContext, permission: Permission): boolean => (context.companyId ? can(actorOf(context), permission, { companyId: context.companyId }) : holds(actorOf(context), permission))

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | 'all' | undefined
  readonly q?: string | undefined
}

/** GET /safety/rolesheets. */
export async function listSheets(caller: CommandCaller, query: ListQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const status = query.status ?? 'ACTIVE'
    const q = query.q?.trim()
    const rows = (await client.roleSheet.findMany({
      where: {
        AND: [
          siteScope(context, SAFETY_VIEW) as Prisma.RoleSheetWhereInput,
          asked(query, 'strict') as Prisma.RoleSheetWhereInput,
          ...(status === 'all' ? [] : [{ status }]),
          ...(q ? [{ OR: [{ code: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }] }] : []),
        ],
      },
      orderBy: [{ site: { code: 'asc' } }, { code: 'asc' }, { id: 'asc' }],
      take: L.list + 1,
      select: SHEET_ROW_SELECT,
    })) as SheetRow[]
    return { roleSheets: rows.slice(0, L.list).map((row) => sheetRowView(context, row)), complete: rows.length <= L.list, canAdd: holdsHere(context, SAFETY_ROLESHEETS_MANAGE), law: LAW, today: todayOf(now) }
  })
}

async function readableSheet(client: Client, context: OfficeContext, sheetId: string): Promise<SheetRow> {
  const row = isUuid(sheetId) ? await readSheetRow(client, sheetId) : null
  if (!row) throw new NotFoundError('Role sheet not found.')
  assertMayAt(context, SAFETY_VIEW, row, 'Role sheet')
  return row
}

/** GET /safety/rolesheets/:roleSheetId. */
export async function sheetRecord(caller: CommandCaller, sheetId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => ({ roleSheet: await sheetView(client, context, await readableSheet(client, context, sheetId)), law: LAW, today: todayOf(now) }))
}

/** GET /safety/rolesheets/catalogue?companyId: what a sheet may take (ACTIVE items of the company, ACTIVE courses of it or the group). */
export async function sheetCatalogue(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const company = isUuid(query.companyId) ? await client.company.findUnique({ where: { id: query.companyId }, select: { id: true } }) : null
    if (!company) throw new NotFoundError('Company not found.')
    assertMayAt(context, SAFETY_ROLESHEETS_MANAGE, { companyId: company.id, siteId: null }, 'Company')
    const items = await client.ppeItem.findMany({ where: { companyId: company.id, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }], take: L.list, select: { id: true, code: true, name: true, nameI18n: true, category: true, standard: true, sizes: true } })
    const courses = await client.safetyCourse.findMany({
      where: { status: 'ACTIVE', OR: [{ companyId: null }, { companyId: company.id }] },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      take: L.list,
      select: { id: true, code: true, name: true, nameI18n: true, type: true, hours: true, refresherMonths: true },
    })
    const names = (value: Prisma.JsonValue | null) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null)
    return {
      ppeItems: items.map((item) => ({ id: item.id, code: item.code, name: item.name, nameI18n: names(item.nameI18n), category: item.category, standard: item.standard, sizes: item.sizes })),
      courses: courses.map((course) => ({ id: course.id, code: course.code, name: course.name, nameI18n: names(course.nameI18n), type: course.type, hours: course.hours.toString(), refresherMonths: course.refresherMonths })),
    }
  })
}

// ---- the content: checks and writes ---------------------------------------------------------------------------------------

/** The content's own problems (400 at the field), cleaned. */
function checkedContent(content: SheetContent, needed: boolean | undefined): SheetContent {
  const cleaned = cleanContent(content)
  const problems = contentProblems(cleaned, needed)
  if (problems.length > 0) throw problemsError(problems, 'The role sheet is not complete.')
  return cleaned
}

/** New kit items: ACTIVE items of the sheet's company; new courses: ACTIVE, of the company or the whole group (kept ones stay). */
async function checkAvailable(client: Client, sheet: { readonly companyId: string }, content: SheetContent, changes: SheetChanges): Promise<void> {
  if (changes.kit.added.length > 0) {
    const found = await client.ppeItem.findMany({ where: { id: { in: [...changes.kit.added] }, companyId: sheet.companyId, status: 'ACTIVE' }, select: { id: true } })
    const missing = changes.kit.added.find((ppeItemId) => !found.some((item) => item.id === ppeItemId))
    if (missing) refuse('PPE_ITEM_NOT_AVAILABLE', 'A kit takes ACTIVE items of the company’s PPE catalogue.', `content/kit/${content.kit.findIndex((entry) => entry.ppeItemId === missing)}/ppeItemId`)
  }
  if (changes.courses.added.length > 0) {
    const found = await client.safetyCourse.findMany({ where: { id: { in: [...changes.courses.added] }, status: 'ACTIVE', OR: [{ companyId: null }, { companyId: sheet.companyId }] }, select: { id: true } })
    const missing = changes.courses.added.find((courseId) => !found.some((course) => course.id === courseId))
    if (missing) refuse('COURSE_NOT_AVAILABLE', 'A role asks ACTIVE courses of the catalogue (of the company, or of the whole group).', `content/requirements/${content.requirements.findIndex((entry) => entry.courseId === missing)}/courseId`)
  }
}

/** Writes the content that changed: items (replaced), kit lines and requirements (kept by item and course), the health plan. */
async function writeContent(tools: CommandTools, sheet: { readonly id: string; readonly companyId: string; readonly siteId: string }, before: RoleAsks, content: SheetContent, changes: SheetChanges): Promise<void> {
  const { tx, now } = tools
  const by = actorIdOf(tools.context)
  const stamp = { createdAt: now, updatedAt: now, createdById: by }
  if (changes.itemsChanged) {
    await tx.roleSheetItem.deleteMany({ where: { roleSheetId: sheet.id } })
    if (content.items.length > 0)
      await tx.roleSheetItem.createMany({ data: content.items.map((item, index) => ({ id: newId(), siteId: sheet.siteId, roleSheetId: sheet.id, seq: index + 1, kind: item.kind, title: item.title, note: item.note ?? null, ...stamp })) })
  }
  if (changes.kitChanged) {
    if (changes.kit.removed.length > 0) await tx.ppeKitLine.deleteMany({ where: { roleSheetId: sheet.id, ppeItemId: { in: [...changes.kit.removed] } } })
    const kept = content.kit.filter((entry) => !changes.kit.added.includes(entry.ppeItemId))
    // Out of the way first, so no two lines hold one place (the place is unique per sheet).
    if (kept.length > 0) await tx.ppeKitLine.updateMany({ where: { roleSheetId: sheet.id, ppeItemId: { in: kept.map((entry) => entry.ppeItemId) } }, data: { seq: { increment: 1000 } } })
    for (const [index, entry] of content.kit.entries()) {
      if (changes.kit.added.includes(entry.ppeItemId)) continue
      await tx.ppeKitLine.updateMany({ where: { roleSheetId: sheet.id, ppeItemId: entry.ppeItemId }, data: { seq: index + 1, quantity: entry.quantity, whenToWear: entry.whenToWear, note: entry.note ?? null, version: { increment: 1 }, updatedAt: now } })
    }
    const added = content.kit.map((entry, index) => ({ entry, index })).filter(({ entry }) => changes.kit.added.includes(entry.ppeItemId))
    if (added.length > 0)
      await tx.ppeKitLine.createMany({ data: added.map(({ entry, index }) => ({ id: newId(), siteId: sheet.siteId, roleSheetId: sheet.id, seq: index + 1, ppeItemId: entry.ppeItemId, quantity: entry.quantity, whenToWear: entry.whenToWear, note: entry.note ?? null, ...stamp })) })
  }
  if (changes.requirementsChanged) {
    if (changes.courses.removed.length > 0) await tx.trainingRequirement.deleteMany({ where: { source: 'ROLE_SHEET', roleSheetId: sheet.id, courseId: { in: [...changes.courses.removed] } } })
    for (const entry of content.requirements) {
      const was = before.content.requirements.find((requirement) => requirement.courseId === entry.courseId)
      if (!was || (was.withinDays === entry.withinDays && (was.note ?? null) === (entry.note ?? null))) continue
      await tx.trainingRequirement.updateMany({ where: { source: 'ROLE_SHEET', roleSheetId: sheet.id, courseId: entry.courseId }, data: { withinDays: entry.withinDays, note: entry.note ?? null, version: { increment: 1 }, updatedAt: now } })
    }
    const added = content.requirements.filter((entry) => changes.courses.added.includes(entry.courseId))
    if (added.length > 0)
      await tx.trainingRequirement.createMany({ data: added.map((entry) => ({ id: newId(), source: 'ROLE_SHEET' as const, roleSheetId: sheet.id, courseId: entry.courseId, withinDays: entry.withinDays, note: entry.note ?? null, ...stamp })) })
  }
  if (changes.surveillance) await writePlan(tools, sheet, changes.surveillance.to)
}

/**
 * The role's health plan says whether the role needs surveillance (one plan per role, key `plan:<sheet>`): a new needed plan
 * asks a yearly visit (art. 41 c.2 b) until the doctor sets the frequency (the health page); a plan not needed asks none.
 */
async function writePlan(tools: CommandTools, sheet: { readonly id: string; readonly companyId: string; readonly siteId: string }, needed: boolean): Promise<void> {
  const { tx, now } = tools
  const today = todayOf(now)
  const plan = await tx.healthPlan.findFirst({ where: { roleSheetId: sheet.id }, select: { id: true, needed: true, frequencyMonths: true, endOfEmploymentVisit: true, status: true } })
  const frequencyMonths = needed ? (plan?.needed && plan.frequencyMonths ? plan.frequencyMonths : DEFAULT_VISIT_MONTHS) : null
  const endOfEmploymentVisit = needed ? (plan?.endOfEmploymentVisit ?? false) : false
  const id = plan?.id ?? newId()
  if (plan) {
    await tx.healthPlan.update({ where: { id: plan.id }, data: { needed, frequencyMonths, endOfEmploymentVisit, setOn: dateOf(today), status: 'ACTIVE', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  } else {
    await tx.healthPlan.create({ data: { id, companyId: sheet.companyId, siteId: sheet.siteId, roleSheetId: sheet.id, key: `plan:${sheet.id}`, needed, frequencyMonths, endOfEmploymentVisit, setOn: dateOf(today), createdAt: now, updatedAt: now, createdById: actorIdOf(tools.context) }, select: { id: true } })
  }
  tools.audit({
    action: 'safety.setRoleVisitNeed',
    recordType: 'HealthPlan',
    recordId: id,
    companyId: sheet.companyId,
    siteId: sheet.siteId,
    before: plan ? { needed: plan.needed, frequencyMonths: plan.frequencyMonths, status: plan.status } : null,
    after: { roleSheetId: sheet.id, needed, frequencyMonths, status: 'ACTIVE' },
  })
}

/** What an audit row keeps of a sheet's content (words, ids and numbers). */
const auditedContent = (asks: { readonly content: SheetContent; readonly needed: boolean | null }) => ({
  items: asks.content.items.map((item) => ({ kind: item.kind, title: item.title, note: item.note ?? null })),
  kit: asks.content.kit.map((entry) => ({ ppeItemId: entry.ppeItemId, quantity: entry.quantity, whenToWear: entry.whenToWear })),
  requirements: asks.content.requirements.map((entry) => ({ courseId: entry.courseId, withinDays: entry.withinDays })),
  surveillanceNeeded: asks.needed,
})

const eventPayload = (sheetId: string, change: 'ADDED' | 'APPLIED' | 'ARCHIVED' | 'RESTORED', people: number, changes: SheetChanges | null) => ({
  roleSheetId: sheetId,
  change,
  people,
  coursesAdded: changes ? [...changes.courses.added] : [],
  coursesRemoved: changes ? [...changes.courses.removed] : [],
  kitAdded: changes ? [...changes.kit.added] : [],
  kitRemoved: changes ? [...changes.kit.removed] : [],
  surveillance: changes?.surveillance ? (changes.surveillance.to ? ('NEEDED' as const) : ('NOT_NEEDED' as const)) : null,
})

// ---- add ------------------------------------------------------------------------------------------------------------------

export interface Header {
  readonly name?: string | undefined
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly description?: string | null | undefined
}

export interface CreateBody extends Header {
  readonly companyId: string
  readonly siteId: string
  readonly code: string
  readonly name: string
  readonly content?: SheetContent | undefined
  readonly surveillance?: { readonly needed: boolean } | undefined
}

const cleanI18n = (names: Record<string, string> | null | undefined): Record<string, string> | null => {
  if (!names) return null
  const entries = Object.entries(names).map(([language, words]) => [language, words.trim()] as const).filter(([, words]) => words !== '')
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/** POST /safety/rolesheets. */
export async function addSheet(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertMayWriteAt(context, SAFETY_ROLESHEETS_MANAGE, { companyId: body.companyId, siteId: body.siteId }, MANAGE_WORDS)
  const code = normalCode(body.code)
  if (!ROLE_SHEET_CODE.test(code)) throw bodyIssue('code', 'A code is letters, digits and . _ / - (no spaces).')
  const content = checkedContent(body.content ?? EMPTY, body.surveillance?.needed)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.addRoleSheet', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const site = await tx.site.findUnique({ where: { id: body.siteId }, select: { companyId: true } })
    if (!site || site.companyId !== body.companyId) refuse('SITE_OTHER_COMPANY', 'The site is one of the company’s sites.', 'siteId')
    const taken = await tx.roleSheet.findFirst({ where: { siteId: body.siteId, code: { equals: code, mode: 'insensitive' } }, select: { id: true } })
    if (taken) refuse('CODE_TAKEN', 'This site has a role sheet with that code already.', 'code')
    const nameI18n = cleanI18n(body.nameI18n)
    await tx.roleSheet.create({
      data: { id, companyId: body.companyId, siteId: body.siteId, code, name: body.name.trim(), ...(nameI18n ? { nameI18n } : {}), description: body.description?.trim() || null, createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools.context) },
      select: { id: true },
    })
    const before: RoleAsks = { content: EMPTY, needed: null, frequencyMonths: null }
    const changes = sheetChanges(before, content, body.surveillance?.needed)
    const sheet = { id, companyId: body.companyId, siteId: body.siteId }
    await checkAvailable(tx, sheet, content, changes)
    await writeContent(tools, sheet, before, content, changes)
    tools.audit({ action: 'safety.addRoleSheet', recordType: RECORD_ROLE_SHEET, recordId: id, companyId: body.companyId, siteId: body.siteId, after: { code, name: body.name.trim(), nameI18n, description: body.description?.trim() || null, ...auditedContent({ content, needed: body.surveillance?.needed ?? null }) } })
    tools.emit({ type: 'role_sheet.changed', subject: id, companyId: body.companyId, siteId: body.siteId, payload: eventPayload(id, 'ADDED', 0, changes) })
    return { roleSheet: await sheetView(tx, context, (await readSheetRow(tx, id))!) }
  })
  return { ...result, replayed }
}

// ---- preview and apply ----------------------------------------------------------------------------------------------------

/** The sheet the caller may change (404 when it may not read it, 403 when it may not change it). */
async function writableSheet(caller: CommandCaller, sheetId: string): Promise<{ context: OfficeContext; row: SheetRow }> {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => readableSheet(client, context, sheetId))
  assertMayWriteAt(context, SAFETY_ROLESHEETS_MANAGE, row, MANAGE_WORDS)
  return { context, row }
}

export interface DraftBody extends Header {
  readonly content: SheetContent
  readonly surveillance?: { readonly needed: boolean } | undefined
}

/** The header fields a draft changes (the code never changes). */
function headerChanges(row: SheetRow, body: Header): string[] {
  const fields: string[] = []
  if (body.name !== undefined && body.name.trim() !== row.name) fields.push('name')
  if (body.nameI18n !== undefined && JSON.stringify(cleanI18n(body.nameI18n)) !== JSON.stringify(row.nameI18n ?? null)) fields.push('nameI18n')
  if (body.description !== undefined && (body.description?.trim() || null) !== row.description) fields.push('description')
  return fields
}

/** "What this changes": the changes, the people's consequences, the names they need, and the fingerprint of what is shown. */
async function previewOf(client: Client, row: SheetRow, before: RoleAsks, content: SheetContent, changes: SheetChanges, header: readonly string[], today: BusinessDate) {
  const people = await peopleOfRoles(client, [row.id])
  const holdings = await holdingsOf(
    client,
    people.map((person) => person.employeeId),
    [...changes.courses.added, ...changes.courses.changed.map((change) => change.courseId)],
    [...changes.kit.added, ...changes.kit.changed.map((change) => change.ppeItemId)],
    today,
  )
  const impact = sheetImpact(
    people.map((person) => ({ employeeId: person.employeeId, name: person.name })),
    before,
    content,
    changes,
    holdings,
  )
  const shown = { changes: changesView(changes, header), impact: impactView(impact), people: people.length }
  return { ...shown, refs: await refsOf(client, changes, impact), fingerprint: fingerprintOf(shown) }
}

/** POST /safety/rolesheets/:roleSheetId/preview. */
export async function previewSheet(caller: CommandCaller, sheetId: string, body: DraftBody, now: Date = new Date()) {
  const { row } = await writableSheet(caller, sheetId)
  if (row.status !== 'ACTIVE') refuse('ARCHIVED', 'This role sheet is archived: restore it to change it.')
  const content = checkedContent(body.content, body.surveillance?.needed)
  return caller.withClient(async (client) => {
    const before = (await roleNeedsOf(client, [row.id])).get(row.id)!
    const changes = sheetChanges(before, content, body.surveillance?.needed)
    await checkAvailable(client, row, content, changes)
    return { ...(await previewOf(client, row, before, content, changes, headerChanges(row, body), todayOf(now))), today: todayOf(now) }
  })
}

export interface ApplyBody extends DraftBody {
  readonly version: number
  /** The fingerprint of the preview read: a change made meanwhile is refused instead of applied unseen. */
  readonly impactFingerprint?: string | undefined
}

/** POST /safety/rolesheets/:roleSheetId/apply. */
export async function applySheet(caller: CommandCaller, sheetId: string, body: ApplyBody, idempotencyKey?: string) {
  const { context } = await writableSheet(caller, sheetId)
  const content = checkedContent(body.content, body.surveillance?.needed)
  const { result } = await command(caller, { name: 'safety.applyRoleSheet', idempotencyKey, input: { roleSheetId: sheetId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    await tx.$queryRaw`SELECT "id" FROM "RoleSheet" WHERE "id" = ${sheetId}::uuid FOR UPDATE`
    const row = (await readSheetRow(tx, sheetId))!
    assertVersion('role sheet', row.version, body.version)
    if (row.status !== 'ACTIVE') refuse('ARCHIVED', 'This role sheet is archived: restore it to change it.')
    const before = (await roleNeedsOf(tx, [row.id])).get(row.id)!
    const header = headerChanges(row, body)
    const changes = sheetChanges(before, content, body.surveillance?.needed)
    if (header.length === 0 && changesNothing(changes)) {
      tools.audit({ action: 'safety.applyRoleSheet', recordType: RECORD_ROLE_SHEET, recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { unchanged: true } })
      return { roleSheet: await sheetView(tx, context, row), ...(await previewOf(tx, row, before, content, changes, header, today)), applied: false }
    }
    await checkAvailable(tx, row, content, changes)
    const preview = await previewOf(tx, row, before, content, changes, header, today)
    if (body.impactFingerprint && body.impactFingerprint !== preview.fingerprint)
      refuse('IMPACT_CHANGED', 'What this changes is not what you read any more (someone joined or left the role, or a course or a PPE item was recorded): read it again.')
    const nameI18n = body.nameI18n !== undefined ? cleanI18n(body.nameI18n) : undefined
    await tx.roleSheet.update({
      where: { id: row.id },
      data: {
        ...(header.includes('name') ? { name: body.name!.trim() } : {}),
        ...(header.includes('nameI18n') && nameI18n ? { nameI18n } : {}),
        ...(header.includes('description') ? { description: body.description?.trim() || null } : {}),
        version: { increment: 1 },
        updatedAt: now,
      },
      select: { id: true },
    })
    // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
    if (header.includes('nameI18n') && nameI18n === null) await tx.$executeRaw`UPDATE "RoleSheet" SET "nameI18n" = NULL WHERE "id" = ${row.id}::uuid`
    await writeContent(tools, row, before, content, changes)
    const neededAfter = changes.surveillance ? changes.surveillance.to : before.needed
    tools.audit({
      action: 'safety.applyRoleSheet',
      recordType: RECORD_ROLE_SHEET,
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { name: row.name, nameI18n: row.nameI18n ?? null, description: row.description, ...auditedContent(before) },
      after: {
        name: header.includes('name') ? body.name!.trim() : row.name,
        nameI18n: header.includes('nameI18n') ? nameI18n : (row.nameI18n ?? null),
        description: header.includes('description') ? body.description?.trim() || null : row.description,
        ...auditedContent({ content, needed: neededAfter }),
        people: preview.people,
      },
    })
    tools.emit({ type: 'role_sheet.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: eventPayload(row.id, 'APPLIED', preview.people, changes) })
    return { roleSheet: await sheetView(tx, context, (await readSheetRow(tx, row.id))!), ...preview, applied: true }
  })
  return result
}

// ---- archive and restore --------------------------------------------------------------------------------------------------

/** POST /safety/rolesheets/:roleSheetId/archive | restore. */
export async function setSheetStatus(caller: CommandCaller, sheetId: string, to: 'ARCHIVED' | 'ACTIVE', body: { readonly version: number }, idempotencyKey?: string) {
  const { context } = await writableSheet(caller, sheetId)
  const name = to === 'ARCHIVED' ? 'safety.archiveRoleSheet' : 'safety.restoreRoleSheet'
  const { result } = await command(caller, { name, idempotencyKey, input: { roleSheetId: sheetId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "RoleSheet" WHERE "id" = ${sheetId}::uuid FOR UPDATE`
    const row = (await readSheetRow(tx, sheetId))!
    assertVersion('role sheet', row.version, body.version)
    if (to === 'ARCHIVED' && row.status !== 'ACTIVE') refuse('ARCHIVED', 'This role sheet is archived already.')
    if (to === 'ACTIVE' && row.status !== 'ARCHIVED') refuse('NOT_ARCHIVED', 'This role sheet is not archived.')
    if (to === 'ARCHIVED') {
      const people = await tx.employee.count({ where: { roleSheetId: row.id, status: 'ACTIVE' } })
      if (people > 0) refuse('PEOPLE_IN_ROLE', `${people === 1 ? 'One person is' : `${people} people are`} in this role: give them another role sheet first (their HR record).`)
    }
    await tx.roleSheet.update({ where: { id: row.id }, data: { status: to, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: name, recordType: RECORD_ROLE_SHEET, recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: to } })
    tools.emit({ type: 'role_sheet.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: eventPayload(row.id, to === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED', 0, null) })
    return { roleSheet: await sheetView(tx, context, (await readSheetRow(tx, row.id))!) }
  })
  return result
}
