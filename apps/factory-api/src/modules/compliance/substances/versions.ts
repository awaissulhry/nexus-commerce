import type { FastifyRequest } from 'fastify'
import { SUBSTANCES_MANAGE } from '@nexus/factory-domain/compliance/substances/permissions'
import { httpsOk, SUBSTANCE_LIMITS } from '@nexus/factory-domain/compliance/substances/rules'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { assertMayKeep, officeOf } from '../register-of-rules/common'
import { substancesClock, substancesGuarded, substancesSettings } from './common'
import { todayOf, VERSION_SELECT, type Reader, type VersionRow } from './store'

/**
 * The versions of the ECHA Candidate List of SVHCs (B-W2b-250; PRD-326): the day ECHA published it, how many entries it
 * has and where it was read (a person reads ECHA's page: no paid feed). A new version is a row; the SVHC answers of the
 * materials judged against an older, shorter list say so (the evaluator's `current` and `grewBy`), and B-W2b-256 asks
 * those declarations again. Tenant-wide: reading needs compliance.certificates.view, recording compliance.substances.manage
 * over every company. What was published never changes, only the note.
 */

const day = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

async function versionViews(db: Reader, rows: readonly VersionRow[]) {
  const counts = new Map<string, number>()
  for (const row of await db.restrictedSubstance.groupBy({ by: ['svhcListVersionId'], where: { svhcListVersionId: { in: rows.map((version) => version.id) } }, _count: { _all: true } })) {
    if (row.svhcListVersionId) counts.set(row.svhcListVersionId, row._count._all)
  }
  const ordered = [...rows].sort((a, b) => b.publishedOn.getTime() - a.publishedOn.getTime())
  return ordered.map((row, index) => {
    const previous = ordered[index + 1]
    return {
      id: row.id,
      publishedOn: day(row.publishedOn),
      entryCount: row.entryCount,
      source: row.source,
      sourceUrl: row.sourceUrl,
      note: row.note,
      /** Substances of the list that this version added. */
      substancesAdded: counts.get(row.id) ?? 0,
      /** Entries more than the version before it (null: the first one held). */
      grewBy: previous ? row.entryCount - previous.entryCount : null,
      newest: index === 0,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
    }
  })
}
export type VersionView = Awaited<ReturnType<typeof versionViews>>[number]

/** GET /compliance/substances/svhc-versions — newest first. */
export async function listVersions(request: FastifyRequest) {
  const actor = actorOf(officeOf(request))
  return request.withClient(async (db) => {
    const rows = await db.svhcListVersion.findMany({ select: VERSION_SELECT })
    return { versions: await versionViews(db, rows), asOf: toUtcIso(substancesClock().now()), mayManage: mayWrite(actor, SUBSTANCES_MANAGE, null) }
  })
}

export interface CreateBody {
  readonly publishedOn: BusinessDate
  readonly entryCount: number
  readonly source: string
  readonly sourceUrl?: string | null | undefined
  readonly note?: string | null | undefined
}

function problemsOf(body: CreateBody, today: BusinessDate): Issue[] {
  const issues: Issue[] = []
  if (body.publishedOn > today) issues.push({ path: 'body/publishedOn', message: 'A Candidate List version is recorded once ECHA has published it: not a day in the future.' })
  if (!httpsOk(body.sourceUrl)) issues.push({ path: 'body/sourceUrl', message: "ECHA's page is an https address (up to 2000 characters)." })
  return issues
}

/** POST /compliance/substances/svhc-versions */
export async function createVersion(caller: CommandCaller, body: CreateBody, key: string | null | undefined): Promise<{ version: VersionView }> {
  const context = officeOf(caller)
  assertMayKeep(context, SUBSTANCES_MANAGE, null, 'The Candidate List')
  const taken = `The Candidate List version of ${body.publishedOn} is recorded already.`
  const { result } = await substancesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.substances.addSvhcVersion', idempotencyKey: key, input: body },
        async ({ tx, now, audit, emit }) => {
          const issues = problemsOf(body, todayOf(now))
          if (issues.length > 0) throw new ValidationError('The Candidate List version is not valid.', issues)
          const publishedOn = new Date(`${body.publishedOn}T00:00:00.000Z`)
          if (await tx.svhcListVersion.findFirst({ where: { publishedOn }, select: { id: true } })) throw new ConflictError(taken)
          const previous = await tx.svhcListVersion.findFirst({ where: { publishedOn: { lt: publishedOn } }, select: { entryCount: true }, orderBy: { publishedOn: 'desc' } })
          const id = newId()
          const row = await tx.svhcListVersion.create({
            data: { id, publishedOn, entryCount: body.entryCount, source: body.source, sourceUrl: body.sourceUrl ?? null, note: body.note ?? null, createdAt: now, updatedAt: now, createdById: context.actorId },
            select: VERSION_SELECT,
          })
          audit({ recordType: 'SvhcListVersion', recordId: id, companyId: null, after: { publishedOn: body.publishedOn, entryCount: row.entryCount, source: row.source, sourceUrl: row.sourceUrl, note: row.note } })
          emit({ type: 'compliance_substances.svhc_version_added', subject: id, companyId: null, payload: { versionId: id, publishedOn: body.publishedOn, entryCount: row.entryCount, grewBy: previous ? row.entryCount - previous.entryCount : null } })
          const views = await versionViews(tx, await tx.svhcListVersion.findMany({ select: VERSION_SELECT }))
          return { version: views.find((view) => view.id === id)! }
        },
        substancesSettings(),
      ),
    { taken },
  )
  return result
}

/** PATCH /compliance/substances/svhc-versions/:versionId {version, note} — only the note changes. */
export async function editVersion(caller: CommandCaller, versionId: string, body: { readonly version: number; readonly note: string | null }, key: string | null | undefined): Promise<{ version: VersionView }> {
  const context = officeOf(caller)
  assertMayKeep(context, SUBSTANCES_MANAGE, null, 'The Candidate List')
  if (!isUuid(versionId)) throw new NotFoundError('There is no such Candidate List version.')
  if (body.note !== null && body.note.length > SUBSTANCE_LIMITS.note) throw new ValidationError('The note is too long.', [{ path: 'body/note', message: `A note takes up to ${SUBSTANCE_LIMITS.note} characters.` }])
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.substances.editSvhcVersion', idempotencyKey: key, input: { versionId, ...body }, record: { type: 'SvhcListVersion', id: versionId, expectedVersion: body.version } },
      async ({ tx, now, audit }) => {
        const before = await tx.svhcListVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_SELECT })
        await tx.svhcListVersion.update({ where: { id: versionId }, data: { note: body.note, updatedAt: now }, select: { id: true } })
        audit({ recordType: 'SvhcListVersion', recordId: versionId, companyId: null, before: { note: before.note }, after: { note: body.note } })
        const views = await versionViews(tx, await tx.svhcListVersion.findMany({ select: VERSION_SELECT }))
        return { version: views.find((view) => view.id === versionId)! }
      },
      substancesSettings(),
    ),
  )
  return result
}
