import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_GARMENTS_RELEASE, QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { inspectionLabel } from '@nexus/factory-domain/quality/final/rules'
import {
  FOUR_EYES_WORDS,
  openChecks,
  releasable,
  releaseSummary,
  reversalHolds,
  reversalImpact,
  secondPersonText,
  type SecondPersonReason,
} from '@nexus/factory-domain/quality/release/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { asTenantSystem, assertFloorReady } from '../../production/serials/facts'
import { readCells, type LabelHeader } from '../../production/serials/store'
import { finalWorkOrder, inspectorOf, mayOn, officeOf, postedBy, signerOf } from './access'
import { cellGate, cellText, documentBlockers, identityOf, inspectorSigner, makerCheck, ReleaseRefusedError, ruleInForce, type Identity } from './facts'
import { callerIdentity, qualityNumber, signatureOf } from './inspections'
import {
  labelsOfCell,
  lockRelease,
  lockSerials,
  makersOf,
  readInspection,
  readRelease,
  readReleases,
  readReversals,
  readWorkOrderInspections,
  releasedFrom,
  releasedPerCell,
  shippedOfCell,
  type ReleaseRow,
  type Reader,
} from './store'

/**
 * The quality release of inspected garments (B-W1-45; QHS-051, QHS-058, QHS-073, QHS-300, PLT-097; Owner answer Q1 (a);
 * design ins-release, dec-sod, dec-release, floor.final release). quality.garments.release over the work order: the
 * office (step-up) or the site's floor inspector (PIN); ONE command():
 *
 *   the work order's release lock (the triggers take it too: two releases of one work order read the caps in turn) →
 *   the serials named, FOR UPDATE (a SERIAL style) → the gate (facts.ts cellGate: the cell and lot caps, the serials,
 *   the garment labels, the certificate gate today, the DoC and leaflet, the material lots on hold, who made the
 *   garments, four eyes) → 409 with every open check in words → the QualityRelease (the certificate that covers the cell
 *   today; the database writes why a second person signed) → its serials MADE → RELEASED → audit → event.
 *
 * Reads: the work order's final state (`GET /quality/final/work-orders/:id`: cells, the gate per cell for the viewer,
 * inspections, makers, the rule in force), the releases list with the reversed view and the on-hold filter (Q3 (a)), one
 * release with its gate at the release (the certificates it names) and its reversals.
 */

const today = () => businessDate(serverClock.now())

/** The floor's system-view reads (the office reads them in the transaction): the documents and the people. */
interface PreRead {
  readonly documents: Awaited<ReturnType<typeof documentBlockers>> | null
  readonly releaser: Identity
  readonly inspector: Identity | null
}

async function preRead(caller: CommandCaller, header: LabelHeader, inspectorRow: { inspectorWorkerId: string | null; inspectorUserId: string | null } | null): Promise<PreRead> {
  const context = inspectorOf(caller)
  const reader = context.audience === 'office' ? caller : asTenantSystem(caller)
  return reader.withClient(async (client) => ({
    documents: context.audience === 'office' ? null : await documentBlockers(client, header),
    releaser: await identityOf(client, signerOf(context)),
    inspector: inspectorRow ? await identityOf(client, inspectorSigner(inspectorRow)) : null,
  }))
}

export interface ReleaseBody {
  readonly inspectionId: string
  readonly workOrderSizeId: string
  readonly quantity: number
  readonly serialIds?: readonly string[] | undefined
  readonly note?: string | null | undefined
}

export async function releaseGarments(caller: CommandCaller, body: ReleaseBody, options: { readonly sign: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const context = inspectorOf(caller)
  const inspection = await caller.withClient((client) => readInspection(client, body.inspectionId))
  if (!inspection || !(mayOn(context, QUALITY_INSPECTIONS_VIEW, inspection) || mayOn(context, QUALITY_GARMENTS_RELEASE, inspection))) throw new NotFoundError('Inspection not found.')
  const header = await finalWorkOrder(caller, inspection.workOrderId, QUALITY_GARMENTS_RELEASE)
  if (context.audience === 'floor') await assertFloorReady(caller, header.siteId)
  const serialIds = [...new Set(body.serialIds ?? [])]
  if (serialIds.length !== (body.serialIds ?? []).length) throw new ValidationError('Name each serial once.', [{ path: 'body/serialIds', message: 'Each serial once.' }])
  const pre = await preRead(caller, header, inspection)
  // Every check before the signature: a release the gate refuses never asks for the code or the PIN.
  const before = await caller.withClient(async (db) =>
    cellGate(db, {
      tenantId: context.tenantId,
      header,
      cellId: body.workOrderSizeId,
      inspection,
      quantity: body.quantity,
      serialIds,
      releaser: pre.releaser,
      inspector: pre.inspector,
      documents: pre.documents ?? (await documentBlockers(db, header)),
      today: today(),
    }),
  ).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'Not a cell of this work order.') throw new ValidationError('Not a cell of this work order.', [{ path: 'body/workOrderSizeId', message: 'Not a cell of this work order.' }])
    throw error
  })
  if (openChecks(before.checks).length > 0) throw new ReleaseRefusedError(before.checks)
  await options.sign()

  const { result } = await command(caller, { name: 'quality.garments.release', idempotencyKey: options.idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockRelease(tx, context.tenantId, header.id)
    if (serialIds.length > 0) await lockSerials(tx, serialIds)
    const current = (await readInspection(tx, inspection.id))!
    const gate = await cellGate(tx, {
      tenantId: context.tenantId,
      header,
      cellId: body.workOrderSizeId,
      inspection: current,
      quantity: body.quantity,
      serialIds,
      releaser: pre.releaser,
      inspector: pre.inspector,
      documents: pre.documents ?? (await documentBlockers(tx, header)),
      today: businessDate(now),
    })
    if (openChecks(gate.checks).length > 0) throw new ReleaseRefusedError(gate.checks)
    const id = newId()
    const signer = signerOf(context)
    const certificateIds = gate.certificate.outcome === 'covered' && gate.certificate.certificate ? [gate.certificate.certificate.id] : []
    const number = await qualityNumber(tools, 'RELEASE', header.companyId, { type: 'QualityRelease', id })
    const signature = signatureOf({ releaseId: id, number, inspectionId: current.id, workOrderSizeId: body.workOrderSizeId, quantity: body.quantity, serialIds, certificateIds, signer, at: toUtcIso(now) })
    const row = await tx.qualityRelease.create({
      data: {
        id,
        number,
        companyId: header.companyId,
        siteId: header.siteId,
        workOrderId: header.id,
        workOrderSizeId: body.workOrderSizeId,
        inspectionId: current.id,
        quantity: body.quantity,
        certificateIds,
        releasedById: signer.userId,
        releasedByWorkerId: signer.workerId,
        releasedAt: now,
        signatureSha256: signature,
        note: body.note?.trim() || null,
        createdAt: now,
        createdById: context.actorId,
      },
      select: { id: true, secondPersonReasons: true },
    })
    for (const serialId of serialIds) {
      await tx.garmentSerial.update({ where: { id: serialId }, data: { status: 'RELEASED', releaseId: id, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    }
    const reasons = (row.secondPersonReasons ?? []) as SecondPersonReason[]
    tools.audit({
      recordType: 'QualityRelease',
      recordId: id,
      companyId: header.companyId,
      siteId: header.siteId,
      after: { number, inspectionId: current.id, workOrderSizeId: body.workOrderSizeId, quantity: body.quantity, serialIds, certificateIds, secondPersonReasons: reasons, signatureSha256: signature, releasedBy: postedBy(context), checks: gate.checks.map((check) => ({ code: check.code, state: check.state, message: check.message })) },
    })
    for (const serialId of serialIds) tools.audit({ recordType: 'GarmentSerial', recordId: serialId, companyId: header.companyId, siteId: header.siteId, before: { status: 'MADE' }, after: { status: 'RELEASED', releaseId: id } })
    tools.emit({
      type: 'quality.garments_released',
      subject: id,
      companyId: header.companyId,
      siteId: header.siteId,
      payload: { releaseId: id, releaseNumber: number, inspectionId: current.id, workOrderId: header.id, number: header.number, workOrderSizeId: body.workOrderSizeId, quantity: body.quantity, serialIds, secondPersonReasons: reasons, postedBy: postedBy(context) },
    })
    return { id, number, cell: cellText(gate.cell) }
  })
  const release = await caller.withClient((db) => readRelease(db, result.id))
  return { release: await caller.withClient((db) => releaseView(db, release!, header.number)), words: `Released ${body.quantity} garment(s) of ${result.cell} (${result.number}): packing allowed.` }
}

// ---- the views --------------------------------------------------------------------------------------------------------------

export async function releaseView(db: Reader, row: ReleaseRow, number: string) {
  const reversals = await readReversals(db, { releaseId: row.id })
  const reversed = reversals.reduce((sum, entry) => sum + entry.quantity, 0)
  const passedAfter = (await readWorkOrderInspections(db, row.workOrderId)).filter((entry) => entry.status === 'PASSED' && entry.decidedAt).map((entry) => entry.decidedAt!)
  const held = reversals.filter((entry) => reversalHolds(entry.reversedAt, passedAfter)).reduce((sum, entry) => sum + entry.quantity, 0)
  const certificates = row.certificateIds.length ? await db.certificate.findMany({ where: { id: { in: row.certificateIds } }, select: { id: true, number: true, standard: true, ppeClass: true, status: true, validTo: true } }) : []
  const serials = await db.garmentSerial.findMany({ where: { releaseId: row.id }, select: { id: true, serial: true, status: true, shipmentLineId: true }, orderBy: { serial: 'asc' } })
  const reasons = (row.secondPersonReasons ?? []) as SecondPersonReason[]
  return {
    id: row.id,
    /** Its own number (REL-2026-0088); null for one made before the company's RELEASE series existed. */
    releaseNumber: row.number,
    workOrderId: row.workOrderId,
    number,
    workOrderSizeId: row.workOrderSizeId,
    inspectionId: row.inspectionId,
    companyId: row.companyId,
    siteId: row.siteId,
    quantity: row.quantity,
    reversed,
    /** Garments of it taken back and on hold until an inspection passes after the reversal (Q3 (a)). */
    onHold: held,
    releasedBy: { kind: row.releasedByWorkerId ? ('FLOOR' as const) : ('OFFICE' as const), userId: row.releasedById, workerId: row.releasedByWorkerId },
    releasedAt: toUtcIso(row.releasedAt),
    signatureSha256: row.signatureSha256,
    secondPerson: { reasons, words: reasons.length ? `A second person released it: ${secondPersonText(reasons)}.` : 'The inspector, who made none of the garments, released it alone.' },
    /** The gate at the release: the certificates it named, as they were on file (their status now beside). */
    certificates: certificates.map((certificate) => ({ id: certificate.id, number: certificate.number, standard: certificate.standard, ppeClass: certificate.ppeClass, statusNow: certificate.status, validTo: certificate.validTo.toISOString().slice(0, 10) })),
    serials: serials.map((serial) => ({ id: serial.id, serial: serial.serial, status: serial.status, packed: serial.shipmentLineId !== null })),
    reversals: reversals.map((entry) => ({
      id: entry.id,
      quantity: entry.quantity,
      reasonCode: entry.reasonCode,
      reason: entry.reason,
      serialIds: entry.serialIds,
      serialsTo: entry.serialsTo,
      reversedById: entry.reversedById,
      reversedAt: toUtcIso(entry.reversedAt),
      onHold: reversalHolds(entry.reversedAt, passedAfter),
    })),
    note: row.note,
  }
}

/** GET /quality/releases/:id (office): the release, its gate snapshot, its reversals, and what a reversal would do now. */
export async function getRelease(caller: CommandCaller, releaseId: string) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => readRelease(db, releaseId))
  if (!row || !mayOn(context, QUALITY_INSPECTIONS_VIEW, row)) throw new NotFoundError('Release not found.')
  const header = await finalWorkOrder(caller, row.workOrderId, QUALITY_INSPECTIONS_VIEW)
  return caller.withClient(async (db) => {
    const view = await releaseView(db, row, header.number)
    const counts = (await releasedPerCell(db, [row.workOrderSizeId])).get(row.workOrderSizeId)!
    const shipped = await shippedOfCell(db, row.workOrderSizeId)
    const impact = reversalImpact({ released: row.quantity, reversed: view.reversed, cell: { netReleased: counts.released - counts.reversed, onDraft: shipped.onDraft, packed: shipped.packed, shipped: shipped.shipped } })
    const entries = await db.ppeRegisterEntry.findMany({ where: { sourceType: 'QualityReleaseReversal', sourceId: { in: view.reversals.map((entry) => entry.id) } }, select: { id: true, reference: true, status: true, sourceId: true } })
    return { release: view, reverseImpact: impact, registerEntries: entries.map((entry) => ({ id: entry.id, reference: entry.reference, status: entry.status, reversalId: entry.sourceId })) }
  })
}

export interface ReleaseQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  /** The reversed-release view (design dec-reversal; Q3 (a)): releases with garments taken back. */
  readonly reversed?: boolean | undefined
  /** Garments taken back and still on hold (no inspection passed since). */
  readonly onHold?: boolean | undefined
  readonly limit: number
}

/** GET /quality/releases (office): newest first, within the caller's companies and sites. */
export async function listReleases(caller: CommandCaller, query: ReleaseQuery) {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), QUALITY_INSPECTIONS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.QualityReleaseWhereInput
  const where: Prisma.QualityReleaseWhereInput = {
    AND: [
      scope,
      {
        ...(query.companyId ? { companyId: query.companyId } : {}),
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.workOrderId ? { workOrderId: query.workOrderId } : {}),
        ...(query.reversed || query.onHold ? { reversals: { some: {} } } : {}),
      },
    ],
  }
  return caller.withClient(async (db) => {
    const rows = await readReleases(db, where, query.onHold ? 1000 : query.limit)
    const numbers = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workOrderId))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
    const views = []
    for (const row of rows) {
      const view = await releaseView(db, row, numbers.get(row.workOrderId) ?? '')
      if (query.onHold && view.onHold === 0) continue
      views.push(view)
      if (views.length >= query.limit) break
    }
    return { releases: views }
  })
}

// ---- the work order's final state ---------------------------------------------------------------------------------------------

/** GET /quality/final/work-orders/:id (office and floor): what the bench and the record show before a release. */
export async function workOrderFinal(caller: CommandCaller, workOrderId: string) {
  const context = inspectorOf(caller)
  const header = await finalWorkOrder(caller, workOrderId, QUALITY_INSPECTIONS_VIEW)
  const viewer = await callerIdentity(caller)
  const documents = context.audience === 'office' ? null : await asTenantSystem(caller).withClient((client) => documentBlockers(client, header))
  const inspectorsOf = async (rows: readonly { inspectorWorkerId: string | null; inspectorUserId: string | null }[]) => {
    const reader = context.audience === 'office' ? caller : asTenantSystem(caller)
    return reader.withClient(async (client) => {
      const out: Identity[] = []
      for (const row of rows) out.push(await identityOf(client, inspectorSigner(row)))
      return out
    })
  }
  const inspectionsRows = await caller.withClient((db) => readWorkOrderInspections(db, header.id))
  const newestPassed = [...inspectionsRows].reverse().find((row) => row.status === 'PASSED') ?? null
  const [newestInspector] = newestPassed ? await inspectorsOf([newestPassed]) : [null]
  return caller.withClient(async (db) => {
    const cells = await readCells(db, header.id)
    const docs = documents ?? (await documentBlockers(db, header))
    const rule = await ruleInForce(db, context.tenantId, header.companyId)
    const makers = await makersOf(db, header.id)
    const cellViews = []
    for (const cell of cells) {
      const gate = await cellGate(db, { tenantId: context.tenantId, header, cellId: cell.id, inspection: newestPassed, quantity: null, serialIds: [], releaser: viewer, inspector: newestInspector ?? null, documents: docs, today: today() })
      const counts = (await releasedPerCell(db, [cell.id])).get(cell.id)!
      cellViews.push({
        workOrderSizeId: cell.id,
        colourwayCode: cell.colourwayCode,
        size: cell.size,
        pieces: cell.quantity,
        released: counts.released - counts.reversed,
        labelsPrinted: (await labelsOfCell(db, cell.id)).printed,
        releasable: releasable(gate.facts),
        readySerials: gate.readySerials,
        summary: releaseSummary(gate.checks),
        checks: gate.checks,
        secondPersonReasons: gate.reasons,
      })
    }
    const inspections = []
    for (const [index, row] of inspectionsRows.entries()) {
      inspections.push({ id: row.id, inspectionNumber: row.number, label: inspectionLabel(header.number, index + 1, row.number), status: row.status, lotSize: row.lotSize, released: await releasedFrom(db, row.id), overridden: row.overrideReason !== null, decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null })
    }
    return {
      workOrder: { id: header.id, number: header.number, status: header.status, batchNumber: header.batchNumber, companyId: header.companyId, siteId: header.siteId },
      /** The newest PASSED inspection the cells' gates are read against (null: none yet). */
      inspectionId: newestPassed?.id ?? null,
      inspections,
      cells: cellViews,
      maker: makerCheck(viewer, makers, header.number),
      documents: docs.map((check) => ({ code: check.code, message: check.message })),
      rule: { rule: rule.rule, source: rule.source, words: FOUR_EYES_WORDS[rule.rule], customerListed: cells.some((cell) => rule.partyIds.includes(cell.partyId)) },
    }
  })
}

