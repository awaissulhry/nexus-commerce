import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_INSTRUCTIONS_APPROVE, PRODUCTION_INSTRUCTIONS_MANAGE, PRODUCTION_INSTRUCTIONS_PEOPLE } from '@nexus/factory-domain/production/instructions/permissions'
import { asWords, FALLBACK_LANGUAGES, languagesOf, missingLanguages, publishRefusal } from '@nexus/factory-domain/production/instructions/rules'
import type { CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { userNames } from '../../people/employees/employees'
import { workerGatesFor } from '../../people/privacy/worker-gate'
import { settingsOf } from './lookup'
import {
  classesOf,
  editorsOf,
  filesOf,
  INSTRUCTION,
  kindOf,
  may,
  mediaOf,
  officeOf,
  operationsOf,
  readInstruction,
  readVersion,
  revisionsOf,
  statusOf,
  stepsOf,
  versionsOf,
  viewWhere,
  wordsOrNull,
  type Db,
  type InstructionRow,
  type MediaRow,
  type SettingRow,
  type StepRow,
  type VersionRow,
} from './store'

/**
 * The work instructions as the office reads them (B-W2b-214; PRD-117; design production.instructions SCR-141):
 *
 *   GET /production/instructions                         the list: operation, the style it is for, the version in force with
 *                                                        its languages (missing ones marked) and media, the draft, how many
 *                                                        saw the version in force (a count, never a name), last change
 *   GET /production/instructions/:id                     the record: its versions (who wrote and approved each), the machine
 *                                                        settings, where the operation is used, what the caller may do
 *   GET …/versions/:versionId[?compare=]                 one version's steps with their media, compared with another
 *   GET …/acknowledgements                               how many saw each version, per site for the version in force; by
 *                                                        name only with production.instructions.people (HR: a training
 *                                                        record), and only where the site's legal gate lets an office read
 *                                                        name a worker (people/privacy worker-gate)
 */

const LIST_LIMIT = 500

/** The languages the company's floors read (its sites' floor languages), with Italian and English. */
async function floorLanguagesOf(db: Db, companyId: string): Promise<string[]> {
  const sites = await db.site.findMany({ where: { companyId }, select: { floorLocales: true } })
  return [...new Set([...FALLBACK_LANGUAGES, ...sites.flatMap((site) => site.floorLocales)])]
}

const personOf = (id: string | null, names: ReadonlyMap<string, string>) => (id ? { id, name: names.get(id) ?? '' } : null)

/** How many workers saw each version (distinct workers): a count per version, never per worker. */
async function seenCounts(db: Db, versionIds: readonly string[]): Promise<Map<string, number>> {
  if (versionIds.length === 0) return new Map()
  const rows = await db.instructionAcknowledgement.findMany({ where: { versionId: { in: [...versionIds] } }, select: { versionId: true, workerId: true } })
  const seen = new Map<string, Set<string>>()
  for (const row of rows) seen.set(row.versionId, (seen.get(row.versionId) ?? new Set()).add(row.workerId))
  return new Map([...seen].map(([versionId, workers]) => [versionId, workers.size]))
}

/** The released revisions whose routing does the operation (where a "for every style" instruction is used). */
async function revisionsUsing(db: Db, operationIds: readonly string[]): Promise<Map<string, string[]>> {
  if (operationIds.length === 0) return new Map()
  const steps = await db.routingOperation.findMany({ where: { operationId: { in: [...new Set(operationIds)] } }, select: { operationId: true, revisionId: true } })
  const released = new Set((await db.styleRevision.findMany({ where: { id: { in: [...new Set(steps.map((row) => row.revisionId))] }, status: 'RELEASED' }, select: { id: true } })).map((row) => row.id))
  const used = new Map<string, Set<string>>()
  for (const step of steps) if (released.has(step.revisionId)) used.set(step.operationId, (used.get(step.operationId) ?? new Set()).add(step.revisionId))
  return new Map([...used].map(([operationId, revisions]) => [operationId, [...revisions]]))
}

const operationView = (operation: { id: string; code: string; name: string } | undefined, id: string) => ({ id, code: operation?.code ?? '', name: operation?.name ?? '' })

function styleView(row: Pick<InstructionRow, 'styleRevisionId'>, revisions: Awaited<ReturnType<typeof revisionsOf>>) {
  const revision = row.styleRevisionId ? revisions.get(row.styleRevisionId) : undefined
  return revision ? { id: revision.style.id, code: revision.style.code, name: revision.style.name, revisionId: revision.id, revision: revision.revision, revisionStatus: revision.status } : null
}

// ---- the list --------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly operationId?: string | undefined
  readonly styleRevisionId?: string | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined
  readonly q?: string | undefined
}

export async function listInstructions(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const db = client as Db
    const q = query.q?.trim()
    const matchedOperations = q ? (await db.operation.findMany({ where: { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] }, select: { id: true }, take: 200 })).map((row) => row.id) : []
    const where: Prisma.WorkInstructionWhereInput = {
      AND: [
        viewWhere(context) as Prisma.WorkInstructionWhereInput,
        ...(query.companyId ? [{ companyId: query.companyId }] : []),
        ...(query.operationId ? [{ operationId: query.operationId }] : []),
        ...(query.styleRevisionId ? [{ styleRevisionId: query.styleRevisionId }] : []),
        ...(query.status ? [{ status: query.status }] : []),
        ...(q ? [{ OR: [{ number: { contains: q, mode: 'insensitive' as const } }, { operationId: { in: matchedOperations } }] }] : []),
      ],
    }
    const rows = await db.workInstruction.findMany({ where, select: INSTRUCTION, orderBy: [{ number: 'asc' }], take: LIST_LIMIT + 1 })
    const shown = rows.slice(0, LIST_LIMIT)
    const versions = await versionsOf(db, shown.map((row) => row.id))
    const current = new Map(versions.filter((row) => row.status === 'PUBLISHED').map((row) => [row.instructionId, row]))
    const drafts = new Map(versions.filter((row) => row.status === 'DRAFT').map((row) => [row.instructionId, row]))
    const currentIds = [...current.values()].map((row) => row.id)
    const steps = await stepsOf(db, currentIds)
    const media = await mediaOf(db, currentIds)
    const seen = await seenCounts(db, currentIds)
    const operations = await operationsOf(db, shown.map((row) => row.operationId))
    const revisions = await revisionsOf(db, shown.map((row) => row.styleRevisionId))
    const used = await revisionsUsing(db, shown.filter((row) => row.styleRevisionId === null).map((row) => row.operationId))
    const languagesByCompany = new Map<string, string[]>()
    for (const companyId of new Set(shown.map((row) => row.companyId))) languagesByCompany.set(companyId, await floorLanguagesOf(db, companyId))
    const counts = { active: 0, archived: 0, drafts: drafts.size }
    for (const row of shown) counts[row.status === 'ACTIVE' ? 'active' : 'archived'] += 1
    return {
      instructions: shown.map((row) => {
        const inForce = current.get(row.id)
        const own = inForce ? steps.filter((step) => step.versionId === inForce.id).map((step) => ({ text: asWords(step.textI18n) })) : []
        const languages = languagesOf(own)
        const draft = drafts.get(row.id)
        return {
          id: row.id,
          number: row.number,
          companyId: row.companyId,
          status: row.status as string,
          operation: operationView(operations.get(row.operationId), row.operationId),
          style: styleView(row, revisions),
          current: inForce
            ? {
                versionId: inForce.id,
                number: inForce.number,
                publishedAt: inForce.publishedAt ? toUtcIso(inForce.publishedAt) : null,
                steps: own.length,
                media: media.filter((medium) => medium.versionId === inForce.id).length,
                languages,
                missingLanguages: (languagesByCompany.get(row.companyId) ?? []).filter((language) => own.some((step) => missingLanguages(step.text, [language]).length > 0)),
                seen: seen.get(inForce.id) ?? 0,
              }
            : null,
          draft: draft ? { versionId: draft.id, number: draft.number } : null,
          usedIn: row.styleRevisionId ? 1 : (used.get(row.operationId)?.length ?? 0),
          updatedAt: toUtcIso(row.updatedAt),
        }
      }),
      truncated: rows.length > LIST_LIMIT,
      counts,
      canManage: context.companyId ? may(context, PRODUCTION_INSTRUCTIONS_MANAGE, context.companyId) : shown.some((row) => may(context, PRODUCTION_INSTRUCTIONS_MANAGE, row.companyId)),
    }
  })
}

// ---- the record ------------------------------------------------------------------------------------------------------------

export function settingViews(rows: readonly SettingRow[], classes: Awaited<ReturnType<typeof classesOf>>) {
  return rows.map((row) => {
    const machineClass = row.machineClassId ? classes.get(row.machineClassId) : undefined
    return {
      seq: row.seq,
      machineClass: machineClass ? { code: machineClass.code, labelIt: machineClass.labelIt, labelEn: machineClass.labelEn } : null,
      stitchType: row.stitchType,
      needle: row.needle,
      thread: row.thread,
      stitchesPerCm: row.stitchesPerCm === null ? null : row.stitchesPerCm.toString(),
      tension: row.tension,
      foot: row.foot,
      notes: row.notes,
    }
  })
}

function versionView(row: VersionRow, facts: { readonly steps: number; readonly media: number; readonly names: ReadonlyMap<string, string>; readonly seen: number }) {
  return {
    id: row.id,
    number: row.number,
    status: statusOf(row),
    changeNote: row.changeNote,
    acknowledgementRequired: row.acknowledgementRequired,
    author: personOf(row.authorId, facts.names)!,
    approvedBy: personOf(row.approvedById, facts.names),
    publishedAt: row.publishedAt ? toUtcIso(row.publishedAt) : null,
    supersededAt: row.supersededAt ? toUtcIso(row.supersededAt) : null,
    createdAt: toUtcIso(row.createdAt),
    steps: facts.steps,
    media: facts.media,
    seen: facts.seen,
    version: row.version,
  }
}

export async function recordIn(db: Db, context: OfficeContext, instructionId: string) {
  const instruction = await readInstruction(db, context, instructionId)
  const versions = await versionsOf(db, [instruction.id])
  const steps = await stepsOf(db, versions.map((row) => row.id))
  const media = await mediaOf(db, versions.map((row) => row.id))
  const names = await userNames(db, versions.flatMap((row) => [row.authorId, row.approvedById]))
  const seen = await seenCounts(db, versions.map((row) => row.id))
  const operation = (await operationsOf(db, [instruction.operationId])).get(instruction.operationId)
  const revisions = await revisionsOf(db, [instruction.styleRevisionId])
  const settings = await settingsOf(db, { routingOperationId: null, operationId: instruction.operationId })
  const used = instruction.styleRevisionId ? [instruction.styleRevisionId] : ((await revisionsUsing(db, [instruction.operationId])).get(instruction.operationId) ?? [])
  const usedRevisions = await revisionsOf(db, used.slice(0, 50))
  const current = versions.find((row) => row.status === 'PUBLISHED') ?? null
  const draft = versions.find((row) => row.status === 'DRAFT') ?? null
  const canApprove = may(context, PRODUCTION_INSTRUCTIONS_APPROVE, instruction.companyId)
  const draftRefusal = draft
    ? publishRefusal({
        number: draft.number,
        status: statusOf(draft),
        authorId: draft.authorId,
        editorIds: (await editorsOf(db, [draft.id])).get(draft.id) ?? [],
        approverId: context.actorId,
        instructionNumber: instruction.number,
        instructionActive: instruction.status === 'ACTIVE',
        changeNote: draft.changeNote,
        steps: steps.filter((step) => step.versionId === draft.id).length,
        mediaNotReady: [...(await filesOf(db, media.filter((medium) => medium.versionId === draft.id).map((medium) => medium.fileId))).values()].filter((file) => file.status !== 'AVAILABLE').length,
      })
    : null
  return {
    instruction: {
      id: instruction.id,
      number: instruction.number,
      companyId: instruction.companyId,
      status: instruction.status as string,
      version: instruction.version,
      operation: operationView(operation, instruction.operationId),
      style: styleView(instruction, revisions),
      createdAt: toUtcIso(instruction.createdAt),
      updatedAt: toUtcIso(instruction.updatedAt),
    },
    versions: versions.map((row) => versionView(row, { steps: steps.filter((step) => step.versionId === row.id).length, media: media.filter((medium) => medium.versionId === row.id).length, names, seen: seen.get(row.id) ?? 0 })),
    currentVersionId: current?.id ?? null,
    draftVersionId: draft?.id ?? null,
    settings: settingViews(settings, await classesOf(db, settings.map((row) => row.machineClassId))),
    floorLanguages: await floorLanguagesOf(db, instruction.companyId),
    usedIn: used.flatMap((revisionId) => {
      const revision = usedRevisions.get(revisionId)
      return revision ? [{ revisionId, styleId: revision.style.id, styleCode: revision.style.code, styleName: revision.style.name, revision: revision.revision, status: revision.status }] : []
    }),
    rights: {
      canManage: may(context, PRODUCTION_INSTRUCTIONS_MANAGE, instruction.companyId),
      canApprove,
      canSeePeople: may(context, PRODUCTION_INSTRUCTIONS_PEOPLE, instruction.companyId),
      /** Why the caller cannot publish the draft now (their own, not complete …), in words; null: they may. */
      approveHeld: draft && canApprove ? (draftRefusal?.message ?? null) : null,
    },
  }
}

/** GET /production/instructions/:instructionId. */
export async function instructionRecord(caller: CommandCaller, instructionId: string) {
  const context = officeOf(caller)
  return caller.withClient((client) => recordIn(client as Db, context, instructionId))
}

// ---- one version -----------------------------------------------------------------------------------------------------------

function stepViews(steps: readonly StepRow[], media: readonly MediaRow[], files: Awaited<ReturnType<typeof filesOf>>, floorLanguages: readonly string[]) {
  return steps.map((step) => {
    const text = asWords(step.textI18n)
    return {
      id: step.id,
      code: step.code,
      sortOrder: step.sortOrder,
      text,
      critical: step.critical,
      safety: wordsOrNull(step.safetyNoteI18n),
      icon: step.icon,
      requiredTick: step.requiredTick,
      missingLanguages: missingLanguages(text, floorLanguages),
      media: media
        .filter((medium) => medium.stepId === step.id)
        .map((medium) => {
          const file = files.get(medium.fileId)
          return { id: medium.id, fileId: medium.fileId, kind: kindOf(medium), sortOrder: medium.sortOrder, caption: wordsOrNull(medium.captionI18n), file: file ? { originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, status: file.status } : null }
        }),
    }
  })
}

/** What changed between two versions, step by step (by code): added, removed, changed (words, marks, icon, tick or media). */
function comparison(from: readonly StepRow[], to: readonly StepRow[], fromMedia: readonly MediaRow[], toMedia: readonly MediaRow[]) {
  const shape = (step: StepRow, media: readonly MediaRow[]) =>
    JSON.stringify([asWords(step.textI18n), step.critical, wordsOrNull(step.safetyNoteI18n), step.icon, step.requiredTick, media.filter((medium) => medium.stepId === step.id).map((medium) => [medium.fileId, medium.kind, wordsOrNull(medium.captionI18n)])])
  const before = new Map(from.map((step) => [step.code, shape(step, fromMedia)]))
  const after = new Map(to.map((step) => [step.code, shape(step, toMedia)]))
  return {
    added: [...after.keys()].filter((code) => !before.has(code)),
    removed: [...before.keys()].filter((code) => !after.has(code)),
    changed: [...after].filter(([code, value]) => before.has(code) && before.get(code) !== value).map(([code]) => code),
  }
}

/** GET …/versions/:versionId?compare=: one version, compared with another (default: the one before it). */
export async function versionRecord(caller: CommandCaller, instructionId: string, versionId: string, query: { readonly compare?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const db = client as Db
    const instruction = await readInstruction(db, context, instructionId)
    const version = await readVersion(db, instruction, versionId)
    const versions = await versionsOf(db, [instruction.id])
    const other = query.compare ? versions.find((row) => row.id === query.compare) : versions.filter((row) => row.number < version.number && row.status !== 'DISCARDED').sort((a, b) => b.number - a.number)[0]
    if (query.compare && (!isUuid(query.compare) || !other)) throw new NotFoundError('The version to compare with is not a version of this instruction.')
    const steps = await stepsOf(db, [version.id, ...(other ? [other.id] : [])])
    const media = await mediaOf(db, [version.id, ...(other ? [other.id] : [])])
    const files = await filesOf(db, media.map((medium) => medium.fileId))
    const names = await userNames(db, [version.authorId, version.approvedById])
    const own = steps.filter((step) => step.versionId === version.id)
    const ownMedia = media.filter((medium) => medium.versionId === version.id)
    const seen = await seenCounts(db, [version.id])
    return {
      version: versionView(version, { steps: own.length, media: ownMedia.length, names, seen: seen.get(version.id) ?? 0 }),
      steps: stepViews(own, ownMedia, files, await floorLanguagesOf(db, instruction.companyId)),
      comparedWith: other ? { id: other.id, number: other.number, ...comparison(steps.filter((step) => step.versionId === other.id), own, media.filter((medium) => medium.versionId === other.id), ownMedia) } : null,
    }
  })
}

// ---- acknowledgements (a training record) ------------------------------------------------------------------------------------

/** The people who work the operation: the holders of its skill at the company's sites, as their floor sign-ins (Worker). */
async function holdersOf(db: Db, companyId: string, operationId: string): Promise<{ workerId: string; siteId: string }[]> {
  const skills = await db.skill.findMany({ where: { operationId, status: 'ACTIVE' }, select: { id: true } })
  if (skills.length === 0) return []
  const sites = (await db.site.findMany({ where: { companyId }, select: { id: true } })).map((row) => row.id)
  const held = await db.employeeSkill.findMany({ where: { skillId: { in: skills.map((row) => row.id) }, siteId: { in: sites }, removedAt: null }, select: { employeeId: true, siteId: true } })
  if (held.length === 0) return []
  const workers = await db.worker.findMany({ where: { employeeId: { in: [...new Set(held.map((row) => row.employeeId))] }, siteId: { in: sites }, status: 'ACTIVE' }, select: { id: true, siteId: true, employeeId: true } })
  const holding = new Set(held.map((row) => `${row.siteId}|${row.employeeId}`))
  return workers.filter((row) => holding.has(`${row.siteId}|${row.employeeId}`)).map((row) => ({ workerId: row.id, siteId: row.siteId }))
}

/** One person of the training record: a name only where the site's gate lets an office read name a worker. */
interface PersonRow {
  readonly worker: { readonly id: string; readonly name: string } | null
  readonly workerHidden: boolean
  readonly site: { readonly id: string; readonly code: string }
  readonly holdsSkill: boolean
  readonly lastSeen: { readonly versionNumber: number; readonly at: string; readonly locale: string; readonly way: 'FLOOR' | 'PAPER' } | null
  readonly seenCurrent: boolean
}

/** GET /production/instructions/:instructionId/acknowledgements. */
export async function acknowledgementsOf(caller: CommandCaller, instructionId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const db = client as Db
    const instruction = await readInstruction(db, context, instructionId)
    const versions = (await versionsOf(db, [instruction.id])).filter((row) => row.status === 'PUBLISHED' || row.status === 'SUPERSEDED')
    const acks = versions.length === 0 ? [] : await db.instructionAcknowledgement.findMany({ where: { versionId: { in: versions.map((row) => row.id) } }, select: { id: true, versionId: true, workerId: true, siteId: true, deviceId: true, locale: true, acknowledgedAt: true }, orderBy: [{ acknowledgedAt: 'asc' }, { id: 'asc' }] })
    const current = versions.find((row) => row.status === 'PUBLISHED') ?? null
    const numberOf = new Map(versions.map((row) => [row.id, row.number]))
    const holders = await holdersOf(db, instruction.companyId, instruction.operationId)
    const sites = await db.site.findMany({ where: { companyId: instruction.companyId }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })
    const distinct = (rows: readonly { workerId: string }[]) => new Set(rows.map((row) => row.workerId)).size
    const canSeePeople = may(context, PRODUCTION_INSTRUCTIONS_PEOPLE, instruction.companyId)
    let people: { rows: PersonRow[] } | null = null
    if (canSeePeople) {
      const gates = await workerGatesFor(db, sites.map((site) => site.id))
      const keyOf = (row: { workerId: string; siteId: string }) => `${row.siteId}|${row.workerId}`
      const everyone = new Map<string, { workerId: string; siteId: string }>()
      for (const row of [...holders, ...acks]) everyone.set(keyOf(row), { workerId: row.workerId, siteId: row.siteId })
      const workerIds = [...everyone.values()].filter((row) => gates.at(row.siteId).open).map((row) => row.workerId)
      const names = new Map(workerIds.length === 0 ? [] : (await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
      const holding = new Set(holders.map(keyOf))
      const siteOf = new Map(sites.map((site) => [site.id, site]))
      people = {
        rows: [...everyone.values()]
          .map((row) => {
            const gate = gates.at(row.siteId)
            const own = acks.filter((ack) => ack.workerId === row.workerId && ack.siteId === row.siteId)
            const last = own.at(-1)
            return {
              worker: gate.person(row.workerId, names),
              workerHidden: gate.hidden(row.workerId),
              site: { id: row.siteId, code: siteOf.get(row.siteId)?.code ?? '' },
              holdsSkill: holding.has(keyOf(row)),
              lastSeen: last ? { versionNumber: numberOf.get(last.versionId) ?? 0, at: toUtcIso(last.acknowledgedAt), locale: last.locale, way: last.deviceId ? ('FLOOR' as const) : ('PAPER' as const) } : null,
              seenCurrent: current ? own.some((ack) => ack.versionId === current.id) : false,
            }
          })
          .sort((a, b) => (a.site.code < b.site.code ? -1 : a.site.code > b.site.code ? 1 : (a.worker?.name ?? '').localeCompare(b.worker?.name ?? ''))),
      }
    }
    return {
      versions: versions.map((row) => ({ versionId: row.id, number: row.number, status: statusOf(row), seen: distinct(acks.filter((ack) => ack.versionId === row.id)) })),
      current: current
        ? {
            versionId: current.id,
            number: current.number,
            acknowledgementRequired: current.acknowledgementRequired,
            perSite: sites.map((site) => ({ siteId: site.id, code: site.code, name: site.name, seen: distinct(acks.filter((ack) => ack.versionId === current.id && ack.siteId === site.id)), of: distinct(holders.filter((holder) => holder.siteId === site.id)) })),
          }
        : null,
      people,
      canSeePeople,
    }
  })
}

