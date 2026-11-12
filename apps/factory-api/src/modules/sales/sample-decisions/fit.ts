import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommentBody, CommentView, FitSaveBody, FitView, UpdateCommentBody } from '@nexus/factory-domain/sales/sample-decisions/contracts'
import { SALES_SAMPLES_MEASURE } from '@nexus/factory-domain/sales/sample-decisions/permissions'
import {
  differenceOf,
  fitRefusal,
  measuredProblems,
  noSpecRefusal,
  notASpecPointRefusal,
  outsideWords,
  passOf,
  plain,
  pointRefusal,
  sizeRefusal,
  specPointRefusal,
} from '@nexus/factory-domain/sales/sample-decisions/rules'
import { cellsOf, type SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { databaseRefusal, may, officeRound, readRoundRow, type Reader, type RoundData } from '../samples/store'
import { namesOf, refuse, stale } from './store'

/**
 * The fit of a sample round (B-W2b-252; PRD-070 "sample measurement entry", PRD-152 fit comments with photos; design
 * products.samples › the round's "Fit & comments" tab: "Measured against spec" — POM, Spec (per size), Measured, Difference,
 * Inside tolerance; out-of-tolerance values listed above the grid; autosave per cell):
 *
 *   GET    /sales/samples/rounds/:roundId/fit        sales.samples.view: the points of the revision's live measurement spec
 *                                                    (approved, or the draft a proto or fit round is made against) × the
 *                                                    round's sizes, each cell with the spec's value now and what was measured
 *                                                    (nominal and tolerances frozen when first written, difference, pass);
 *                                                    rows measured earlier against points the spec no longer has; the values
 *                                                    outside their tolerance; the comments with their photos
 *   PUT    /sales/samples/rounds/:roundId/fit        sales.samples.measure: cells saved (one, or a pasted column): each a point
 *                                                    of that spec and a size of the round; measured null clears the value
 *   POST   /sales/samples/rounds/:roundId/comments   a fit comment about a point of the spec, a body area or the whole sample
 *   PATCH  /sales/samples/comments/:commentId        its words while the round is open; resolved at any time
 *   DELETE /sales/samples/comments/:commentId        while the round is open
 *
 * B-W2b-284: SampleMeasurement / SampleComment.pointOfMeasureId are foreign keys to the library's PointOfMeasure (W2b-5 wave
 * 34; Restrict): the points are read through the keys (the spec value's, the measurement's, the comment's), never looked up by
 * this module on their own, and a point is accepted only as one of the round's pinned revision's spec (its code, name and unit
 * frozen from that point). Photos of a comment are files of record type SampleComment (the generic POST /files with the
 * round's company).
 */

/** The library point a spec value, measurement or comment names (through its foreign key, B-W2b-284). */
const POINT = { select: { id: true, code: true, name: true, uom: true } } as const
const SPEC_VALUE = { pointOfMeasureId: true, size: true, seq: true, nominal: true, toleranceMinus: true, tolerancePlus: true, pointOfMeasure: POINT } as const
const MEASUREMENT = { id: true, seq: true, pointOfMeasureId: true, pomCode: true, pomName: true, size: true, nominal: true, toleranceMinus: true, tolerancePlus: true, uom: true, measured: true, measuredAt: true, pass: true, note: true, version: true, pointOfMeasure: POINT } as const
const COMMENT = { id: true, roundId: true, pointOfMeasureId: true, pomCode: true, bodyArea: true, text: true, resolved: true, resolvedAt: true, resolvedById: true, version: true, createdAt: true, createdById: true } as const

type PointRow = Prisma.PointOfMeasureGetPayload<typeof POINT>
type SpecValueRow = { pointOfMeasureId: string; size: string; seq: number; nominal: { toString(): string }; toleranceMinus: { toString(): string }; tolerancePlus: { toString(): string }; pointOfMeasure: PointRow }

/** The spec's points by id (each read through its spec values' foreign key). */
const specPointsOf = (values: readonly SpecValueRow[]): Map<string, PointRow> => new Map(values.map((value) => [value.pointOfMeasureId, value.pointOfMeasure]))

/** The revision's live spec (DRAFT or APPROVED, not archived), its values and their points. */
async function liveSpecOf(db: Reader, revisionId: string) {
  const spec = await db.measurementSpec.findFirst({ where: { revisionId, status: { not: 'ARCHIVED' } }, select: { id: true, status: true, baseSize: true } })
  const values: SpecValueRow[] = spec ? await db.measurementSpecValue.findMany({ where: { specId: spec.id }, select: SPEC_VALUE, orderBy: [{ seq: 'asc' }, { size: 'asc' }] }) : []
  return { spec, values }
}

/** The round's sizes in the style's range order (sizes not in the range last, as given). */
async function sizesOf(db: Reader, round: Pick<RoundData, 'styleId' | 'cells'>, extra: readonly string[] = []): Promise<string[]> {
  const style = await db.style.findUnique({ where: { id: round.styleId }, select: { sizes: true } })
  const wanted = new Set([...cellsOf(round.cells).map((cell) => cell.size), ...extra])
  const range = style?.sizes ?? []
  return [...range.filter((size) => wanted.has(size)), ...[...wanted].filter((size) => !range.includes(size))]
}

const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/**
 * The words for a point the spec has no value for in this size (B-W2b-284): a point of the spec in another size, a library
 * point outside the spec (its code read for the words only), or an id that is no point at all.
 */
async function offSpecRefusal(db: Reader, pointOfMeasureId: string, inSpec: PointRow | null, size: string, revision: number) {
  if (inSpec) return pointRefusal(inSpec.code, size, revision)
  const named = isUuid(pointOfMeasureId) ? await db.pointOfMeasure.findUnique({ where: { id: pointOfMeasureId }, select: { code: true } }) : null
  return named ? pointRefusal(named.code, size, revision) : notASpecPointRefusal(revision)
}

async function commentViewsOf(db: Reader, rows: readonly { id: string; pointOfMeasureId: string | null; pomCode: string | null; bodyArea: string | null; text: string; resolved: boolean; resolvedAt: Date | null; resolvedById: string | null; version: number; createdAt: Date; createdById: string | null }[]): Promise<CommentView[]> {
  if (rows.length === 0) return []
  const [names, photos] = await Promise.all([
    namesOf(db, rows.flatMap((row) => [row.createdById, row.resolvedById])),
    db.storedFile.findMany({ where: { recordType: 'SampleComment', recordId: { in: rows.map((row) => row.id) }, kind: 'PHOTO', status: 'AVAILABLE', supersededAt: null }, select: { id: true, recordId: true, originalName: true, contentType: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ])
  return rows.map((row) => ({
    id: row.id,
    pointOfMeasureId: row.pointOfMeasureId,
    pomCode: row.pomCode,
    bodyArea: row.bodyArea,
    text: row.text,
    resolved: row.resolved,
    resolvedAt: at(row.resolvedAt),
    resolvedBy: row.resolvedById ? { id: row.resolvedById, name: names.get(row.resolvedById) ?? '' } : null,
    createdBy: row.createdById ? { id: row.createdById, name: names.get(row.createdById) ?? '' } : null,
    createdAt: toUtcIso(row.createdAt),
    photos: photos.filter((photo) => photo.recordId === row.id).map((photo) => ({ id: photo.id, originalName: photo.originalName, contentType: photo.contentType })),
    version: row.version,
  }))
}

async function fitViewOf(db: Reader, context: OfficeContext, round: RoundData): Promise<FitView> {
  const [revision, { spec, values }, measurements, commentRows] = await Promise.all([
    db.styleRevision.findUniqueOrThrow({ where: { id: round.revisionId }, select: { id: true, revision: true, status: true } }),
    liveSpecOf(db, round.revisionId),
    db.sampleMeasurement.findMany({ where: { roundId: round.id }, select: MEASUREMENT, orderBy: [{ seq: 'asc' }, { pomCode: 'asc' }, { size: 'asc' }] }),
    db.sampleComment.findMany({ where: { roundId: round.id }, select: COMMENT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ])
  // B-W2b-284: the points come through the foreign keys (the spec's values, the measurements made against points it no longer has).
  const points = specPointsOf(values)
  for (const row of measurements) if (row.pointOfMeasure && !points.has(row.pointOfMeasure.id)) points.set(row.pointOfMeasure.id, row.pointOfMeasure)
  const sizes = await sizesOf(db, round, measurements.map((row) => row.size))
  const measurementView = (row: (typeof measurements)[number]) => ({
    id: row.id,
    nominal: plain(row.nominal),
    toleranceMinus: plain(row.toleranceMinus),
    tolerancePlus: plain(row.tolerancePlus),
    measured: row.measured === null ? null : plain(row.measured),
    difference: row.measured === null ? null : differenceOf(row.measured.toString(), row.nominal.toString()),
    pass: row.pass,
    measuredAt: at(row.measuredAt),
    note: row.note,
    version: row.version,
  })
  const used = new Set<string>()
  const specOrder = [...new Set(values.map((value) => value.pointOfMeasureId))]
  const rows: FitView['points'] = specOrder.flatMap((pointId) => {
    const point = points.get(pointId)
    if (!point) return []
    return [
      {
        pointOfMeasureId: point.id,
        code: point.code,
        name: point.name,
        uom: point.uom,
        inSpec: true,
        cells: sizes.map((size) => {
          const value = values.find((each) => each.pointOfMeasureId === pointId && each.size === size)
          const measured = measurements.find((row) => row.size === size && (row.pointOfMeasureId === pointId || (row.pointOfMeasureId === null && row.pomCode === point.code)))
          if (measured) used.add(measured.id)
          return {
            size,
            spec: value ? { nominal: plain(value.nominal), toleranceMinus: plain(value.toleranceMinus), tolerancePlus: plain(value.tolerancePlus) } : null,
            measurement: measured ? measurementView(measured) : null,
          }
        }),
      },
    ]
  })
  // Values measured earlier against points the spec no longer has (or before points had ids): their own rows.
  const orphans = measurements.filter((row) => !used.has(row.id))
  for (const code of [...new Set(orphans.map((row) => row.pomCode))]) {
    const mine = orphans.filter((row) => row.pomCode === code)
    const first = mine[0]!
    const point = first.pointOfMeasureId ? points.get(first.pointOfMeasureId) : undefined
    rows.push({
      pointOfMeasureId: first.pointOfMeasureId,
      code,
      name: point?.name ?? first.pomName ?? code,
      uom: first.uom,
      inSpec: false,
      cells: sizes.map((size) => {
        const measured = mine.find((row) => row.size === size)
        return { size, spec: null, measurement: measured ? measurementView(measured) : null }
      }),
    })
  }
  const outside = measurements
    .filter((row) => row.pass === false && row.measured !== null)
    .map((row) => {
      const cell = { pomCode: row.pomCode, size: row.size, measured: row.measured!.toString(), nominal: row.nominal.toString(), toleranceMinus: row.toleranceMinus.toString(), tolerancePlus: row.tolerancePlus.toString(), uom: row.uom }
      return { pomCode: row.pomCode, size: row.size, measured: plain(cell.measured), nominal: plain(cell.nominal), difference: differenceOf(cell.measured, cell.nominal), words: outsideWords(cell) }
    })
  const comments = await commentViewsOf(db, commentRows)
  const closed = fitRefusal({ number: round.number, stage: round.stage as SampleStage })
  return {
    round: { id: round.id, number: round.number, stage: round.stage as SampleStage, revision, companyId: round.companyId, version: round.version },
    spec,
    sizes,
    points: rows,
    outside,
    measuredCount: measurements.filter((row) => row.measured !== null).length,
    comments,
    openComments: comments.filter((comment) => !comment.resolved).length,
    editable: closed === null && may(context, SALES_SAMPLES_MEASURE, round),
    refusal: closed,
  }
}

/** GET /sales/samples/rounds/:roundId/fit */
export async function readFit(caller: CommandCaller, roundId: string): Promise<FitView> {
  const { context, round } = await officeRound(caller, roundId)
  return caller.withClient((db) => fitViewOf(db, context, round))
}

function assertMeasure(context: OfficeContext, round: RoundData): void {
  if (!may(context, SALES_SAMPLES_MEASURE, round)) throw new ForbiddenError('Your role does not measure sample fits for this company or customer (sales.samples.measure).')
}

/** PUT /sales/samples/rounds/:roundId/fit: cells saved, the nominal and tolerances frozen from the spec when first written. */
export async function saveFit(caller: CommandCaller, roundId: string, body: FitSaveBody, idempotencyKey?: string): Promise<FitView> {
  const { context, round: seen } = await officeRound(caller, roundId)
  assertMeasure(context, seen)
  refuse(fitRefusal({ number: seen.number, stage: seen.stage as SampleStage }))
  const problems: Issue[] = []
  const seenCells = new Set<string>()
  body.cells.forEach((cell, index) => {
    if (cell.measured !== null) problems.push(...measuredProblems(cell.measured, `body/cells/${index}/measured`))
    const key = `${cell.pointOfMeasureId}/${cell.size}`
    if (seenCells.has(key)) problems.push({ path: `body/cells/${index}`, message: `Size ${cell.size} of this point is named twice.` })
    seenCells.add(key)
  })
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These cells cannot be saved.', problems)
  const { revision, roundSizes } = await caller.withClient(async (db) => ({
    revision: (await db.styleRevision.findUniqueOrThrow({ where: { id: seen.revisionId }, select: { revision: true } })).revision,
    roundSizes: cellsOf(seen.cells).map((cell) => cell.size),
  }))
  body.cells.forEach((cell) => refuse(roundSizes.includes(cell.size) ? null : sizeRefusal(cell.size, seen.number)))

  await command(caller, { name: 'sales.samples.measure', idempotencyKey, input: { roundId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = (await readRoundRow(tx, roundId))!
    refuse(fitRefusal({ number: row.number, stage: row.stage as SampleStage }))
    const { spec, values } = await liveSpecOf(tx, row.revisionId)
    if (!spec) refuse(noSpecRefusal(revision))
    // B-W2b-284: a point is one of the spec's (read through its values' foreign key); no library look-up of its own.
    const points = specPointsOf(values)
    const before: unknown[] = []
    const after: unknown[] = []
    for (const cell of body.cells) {
      const point = points.get(cell.pointOfMeasureId) ?? null
      const value = values.find((each) => each.pointOfMeasureId === cell.pointOfMeasureId && each.size === cell.size)
      if (!point || !value) refuse(await offSpecRefusal(tx, cell.pointOfMeasureId, point, cell.size, revision))
      if (!point) continue
      const existing = await tx.sampleMeasurement.findFirst({ where: { roundId, size: cell.size, OR: [{ pointOfMeasureId: point.id }, { pomCode: point.code }] }, select: MEASUREMENT })
      if (existing && cell.version === undefined) throw stale(`${point.code} ${cell.size}`, existing.version)
      if (existing && cell.version !== existing.version) throw new StaleVersionError('SampleMeasurement', existing.id, existing.version, cell.version!)
      if (!existing && cell.version !== undefined) throw new NotFoundError(`${point.code} ${cell.size} was cleared meanwhile: read the grid again.`)
      const measured = cell.measured === null ? null : plain(cell.measured.trim())
      if (existing) {
        const note = cell.note === undefined ? existing.note : cell.note
        before.push({ pomCode: existing.pomCode, size: existing.size, measured: existing.measured === null ? null : plain(existing.measured), pass: existing.pass, note: existing.note })
        if (measured === null && note === null) {
          await tx.sampleMeasurement.delete({ where: { id: existing.id }, select: { id: true } })
          after.push({ pomCode: existing.pomCode, size: existing.size, removed: true })
          continue
        }
        const pass = measured === null ? null : passOf(measured, existing.nominal.toString(), existing.toleranceMinus.toString(), existing.tolerancePlus.toString())
        await tx.sampleMeasurement.update({
          where: { id: existing.id },
          data: { measured, measuredAt: measured === null ? null : existing.measured !== null && plain(existing.measured) === measured ? existing.measuredAt : now, pass, note, version: { increment: 1 }, updatedAt: now },
          select: { id: true },
        })
        after.push({ pomCode: existing.pomCode, size: existing.size, measured, pass, note })
        continue
      }
      const note = cell.note ?? null
      if (measured === null && note === null) continue
      const nominal = value!.nominal.toString()
      const minus = value!.toleranceMinus.toString()
      const plus = value!.tolerancePlus.toString()
      const pass = measured === null ? null : passOf(measured, nominal, minus, plus)
      await tx.sampleMeasurement.create({
        data: {
          id: newId(),
          roundId,
          seq: value!.seq,
          pointOfMeasureId: point.id,
          pomCode: point.code,
          pomName: point.name.slice(0, 200),
          size: cell.size,
          nominal,
          toleranceMinus: minus,
          tolerancePlus: plus,
          uom: point.uom,
          measured,
          measuredAt: measured === null ? null : now,
          pass,
          note,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
        },
        select: { id: true },
      })
      before.push(null)
      after.push({ pomCode: point.code, size: cell.size, nominal: plain(nominal), toleranceMinus: plain(minus), tolerancePlus: plain(plus), measured, pass, note, spec: spec!.status })
    }
    const outside = await tx.sampleMeasurement.count({ where: { roundId, pass: false } })
    tools.audit({ action: 'sales.samples.measure', recordType: 'SampleRound', recordId: roundId, companyId: row.companyId, before: { cells: before }, after: { cells: after, specId: spec!.id } })
    tools.emit({ type: 'sample_round.fit_changed', subject: roundId, companyId: row.companyId, payload: { sampleRoundId: roundId, number: row.number, change: 'MEASURED', cells: body.cells.length, outside } })
    return null
  }).catch(databaseRefusal)
  return readFit(caller, roundId)
}

// ---- fit comments ----------------------------------------------------------------------------------------------------------

async function commentOf(db: Reader | CommandTx, commentId: string) {
  return isUuid(commentId) ? db.sampleComment.findUnique({ where: { id: commentId }, select: COMMENT }) : null
}

async function oneComment(caller: CommandCaller, commentId: string): Promise<CommentView> {
  const [view] = await caller.withClient(async (db) => commentViewsOf(db, [(await commentOf(db, commentId))!]))
  return view!
}

/** The comment and its round, as the office caller sees them (its round's sales.samples.view, else not found). */
async function officeComment(caller: CommandCaller, commentId: string) {
  const comment = await caller.withClient((db) => commentOf(db, commentId))
  if (!comment) throw new NotFoundError('Fit comment not found.')
  const { context, round } = await officeRound(caller, comment.roundId).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new NotFoundError('Fit comment not found.')
    throw error
  })
  assertMeasure(context, round)
  return { context, round, comment }
}

/** POST /sales/samples/rounds/:roundId/comments */
export async function addComment(caller: CommandCaller, roundId: string, body: CommentBody, idempotencyKey?: string): Promise<CommentView> {
  const { context, round: seen } = await officeRound(caller, roundId)
  assertMeasure(context, seen)
  refuse(fitRefusal({ number: seen.number, stage: seen.stage as SampleStage }))
  let point: { id: string; code: string } | null = null
  if (body.pointOfMeasureId) {
    const asked = body.pointOfMeasureId
    point = await caller.withClient(async (db) => {
      // B-W2b-284: one of the spec's points (through its values' foreign key); no library look-up of its own.
      const found = specPointsOf((await liveSpecOf(db, seen.revisionId)).values).get(asked)
      if (!found) {
        const revision = (await db.styleRevision.findUniqueOrThrow({ where: { id: seen.revisionId }, select: { revision: true } })).revision
        const named = isUuid(asked) ? await db.pointOfMeasure.findUnique({ where: { id: asked }, select: { code: true } }) : null
        refuse(named ? specPointRefusal(named.code, revision) : notASpecPointRefusal(revision))
      }
      return found!
    })
  }
  const id = newId()
  await command(caller, { name: 'sales.samples.comment', idempotencyKey, input: { roundId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = (await readRoundRow(tx, roundId))!
    refuse(fitRefusal({ number: row.number, stage: row.stage as SampleStage }))
    const data = { id, roundId, pointOfMeasureId: point?.id ?? null, pomCode: point?.code ?? null, bodyArea: body.bodyArea ?? null, text: body.text, createdAt: now, updatedAt: now, createdById: context.actorId }
    await tx.sampleComment.create({ data, select: { id: true } })
    tools.audit({ action: 'sales.samples.comment', recordType: 'SampleComment', recordId: id, companyId: row.companyId, after: { roundId, pomCode: data.pomCode, bodyArea: data.bodyArea, text: data.text } })
    tools.emit({ type: 'sample_round.fit_changed', subject: roundId, companyId: row.companyId, payload: { sampleRoundId: roundId, number: row.number, change: 'COMMENT_ADDED', cells: 0, outside: await tx.sampleMeasurement.count({ where: { roundId, pass: false } }) } })
    return null
  }).catch(databaseRefusal)
  return oneComment(caller, id)
}

/** PATCH /sales/samples/comments/:commentId: its words while the round is open; resolved (or open again) at any time. */
export async function updateComment(caller: CommandCaller, commentId: string, body: UpdateCommentBody, idempotencyKey?: string): Promise<CommentView> {
  const { context, round, comment } = await officeComment(caller, commentId)
  const words = body.text !== undefined || body.bodyArea !== undefined
  if (!words && body.resolved === undefined) throw new ValidationError('Say what changes.', [{ path: 'body/version', message: 'Say what changes.' }])
  if (words) refuse(fitRefusal({ number: round.number, stage: round.stage as SampleStage }))
  await command(caller, { name: 'sales.samples.comment', idempotencyKey, input: { commentId, ...body }, record: { type: 'SampleComment', id: commentId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = (await commentOf(tx, commentId))!
    if (words) {
      const row = (await readRoundRow(tx, comment.roundId))!
      refuse(fitRefusal({ number: row.number, stage: row.stage as SampleStage }))
    }
    const resolving = body.resolved !== undefined && body.resolved !== current.resolved
    const data = {
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.bodyArea !== undefined ? { bodyArea: body.bodyArea } : {}),
      ...(resolving ? (body.resolved ? { resolved: true, resolvedAt: now, resolvedById: context.actorId } : { resolved: false, resolvedAt: null, resolvedById: null }) : {}),
    }
    await tx.sampleComment.update({ where: { id: commentId }, data: { ...data, updatedAt: now }, select: { id: true } })
    tools.audit({
      action: 'sales.samples.comment',
      recordType: 'SampleComment',
      recordId: commentId,
      companyId: round.companyId,
      before: { text: current.text, bodyArea: current.bodyArea, resolved: current.resolved },
      after: { text: data.text ?? current.text, bodyArea: data.bodyArea === undefined ? current.bodyArea : data.bodyArea, resolved: resolving ? body.resolved : current.resolved },
    })
    tools.emit({ type: 'sample_round.fit_changed', subject: round.id, companyId: round.companyId, payload: { sampleRoundId: round.id, number: round.number, change: 'COMMENT_CHANGED', cells: 0, outside: await tx.sampleMeasurement.count({ where: { roundId: round.id, pass: false } }) } })
    return null
  }).catch(databaseRefusal)
  return oneComment(caller, commentId)
}

/** DELETE /sales/samples/comments/:commentId?version=: while the round is open (its photos stay files of the comment). */
export async function removeComment(caller: CommandCaller, commentId: string, version: number, idempotencyKey?: string): Promise<{ id: string; removed: true }> {
  const { round } = await officeComment(caller, commentId)
  refuse(fitRefusal({ number: round.number, stage: round.stage as SampleStage }))
  await command(caller, { name: 'sales.samples.comment', idempotencyKey, input: { commentId, version, remove: true }, record: { type: 'SampleComment', id: commentId, expectedVersion: version } }, async (tools) => {
    const { tx } = tools
    const row = (await readRoundRow(tx, round.id))!
    refuse(fitRefusal({ number: row.number, stage: row.stage as SampleStage }))
    const current = (await commentOf(tx, commentId))!
    await tx.sampleComment.delete({ where: { id: commentId }, select: { id: true } })
    tools.audit({ action: 'sales.samples.commentRemove', recordType: 'SampleComment', recordId: commentId, companyId: row.companyId, before: { roundId: row.id, pomCode: current.pomCode, bodyArea: current.bodyArea, text: current.text, resolved: current.resolved } })
    tools.emit({ type: 'sample_round.fit_changed', subject: row.id, companyId: row.companyId, payload: { sampleRoundId: row.id, number: row.number, change: 'COMMENT_REMOVED', cells: 0, outside: await tx.sampleMeasurement.count({ where: { roundId: row.id, pass: false } }) } })
    return null
  }).catch(databaseRefusal)
  return { id: commentId, removed: true }
}
