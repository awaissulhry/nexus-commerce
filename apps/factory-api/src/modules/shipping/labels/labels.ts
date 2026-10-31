import { PRINT_LABELS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { LABEL_CONTENT_TYPES, type CarrierLabel } from '@nexus/factory-domain/ports/carrier'
import {
  buyFieldProblems,
  buyStateProblems,
  isLabelled,
  labelFileName,
  labelFormatsFor,
  labelRequestOf,
  parcelsToLabel,
  partialProblem,
  voidProblems,
  type LabelParcel,
  type ParcelOutcome,
} from '@nexus/factory-domain/shipping/labels/labels'
import { SHIPPING_LABELS_BUY, SHIPPING_LABELS_VOID } from '@nexus/factory-domain/shipping/labels/permissions'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { putGeneratedFile, recordGeneratedFile, type Callers, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { readPrinter } from '../../../platform/print/printers'
import { assertMay, shippingContextOf } from '../access'
import { tenantOf } from '../cells'
import { officeShipment } from '../shipments/shipments'
import { lockedStatus, readShipment, type ShipmentHeader } from '../store'
import { carrierProblem, isCarrierRefusal, type CarrierRuntime } from './carrier'
import { labelFilesOf, labelsView, latestStatuses, readLabelFacts, readLabelParcels, readTracking, shipmentAccountId, statusMap, type LabelsView } from './store'
import { collectedProblems, voidAllPlan, voidAllProblems, voidOutcomeWords } from '@nexus/factory-domain/shipping/shipments/void'

/**
 * Carrier labels (B-W1-48; LOG-025, LOG-032, LOG-059; A2 SCR-067 in the office, SCR-098 on the floor).
 *
 *   buy     office, shipping.labels.buy (it spends the company's money). The facts are read and checked (409: PACKED,
 *           carried by a carrier, a live DDT, the company's own usable Sendcloud account; 400: the sender, the
 *           recipient, the service, each parcel weighed). Then, OUTSIDE any transaction, per parcel without a label:
 *           the label through the gateway (carrier.create_label, its reference = the parcel and its version, so a repeat
 *           gets the same label and is never charged twice), its files (carrier.label_document: the PDF, and ZPL when the
 *           site has a label printer) and their bytes in the file store (files.put). A parcel that fails anywhere keeps
 *           no label and says why; the others go on. Then ONE command on the Shipment (its version bump locks the row)
 *           records what was bought: each parcel's tracking number, provider id and labelledAt, its StoredFiles, audit
 *           rows, the events. A parcel labelled meanwhile by another buy keeps its label (the surplus one is voided). A
 *           shipment that changed meanwhile (no longer PACKED) records nothing: its new labels are voided and it is a 409.
 *   void    office, shipping.labels.void, only before the goods leave: the carrier cancels it (carrier.void_label), then
 *           one command clears the parcel's label: the parcel can change again (weight, sizes, contents).
 *   print   office and floor (shipping.pack, and print.labels on the printer's site): the labels' ZPL as print jobs to
 *           the site's label printer (default: the shipping settings'); a PDF label prints from the browser.
 *   read    office and floor (shipping.pack): the parcels, their labels, files and print state, and today's cut-off.
 */

export interface BuyBody {
  readonly version?: number | undefined
  /** Only these parcels (default: every parcel without a label). */
  readonly parcelIds?: readonly string[] | undefined
}

export interface BuyAnswer extends LabelsView {
  readonly outcomes: ParcelOutcome[]
  readonly problem: string | null
}

interface Bought {
  readonly parcel: LabelParcel
  readonly label: CarrierLabel
  readonly files: readonly PreparedGeneratedFile[]
}

const issuesOf = (problems: readonly Issue[]) => problems.map((problem) => problem.message).join(' ')

/** The shipment the office may see (else 404) and act on, with its Sendcloud account id (an internal column). */
async function officeLabelShipment(caller: CommandCaller, shipmentId: string, permission: typeof SHIPPING_LABELS_BUY | typeof SHIPPING_LABELS_VOID) {
  const shipment = await officeShipment(caller, shipmentId, permission)
  const integrationAccountId = await caller.withClient((client) => shipmentAccountId(client, shipment.id))
  return { ...shipment, integrationAccountId }
}

/** Voids labels bought but not recorded (best effort; the ledger keeps every call). */
async function voidQuietly(carrier: CarrierRuntime, caller: CommandCaller, accountId: string, labels: readonly CarrierLabel[], onError?: (error: unknown) => void): Promise<void> {
  for (const label of labels) {
    try {
      await carrier.voidLabel(caller, accountId, label.providerId)
    } catch (error) {
      onError?.(error)
    }
  }
}

/** shipping.labels.buy: buys the labels of the shipment's parcels that have none (see the file's comment). */
export async function buyLabels(runtime: { carrier: CarrierRuntime; files: FilesRuntime }, caller: CommandCaller, shipmentId: string, body: BuyBody, idempotencyKey?: string, onError?: (error: unknown) => void): Promise<{ created: boolean; answer: BuyAnswer }> {
  const { carrier, files } = runtime
  const shipment = await officeLabelShipment(caller, shipmentId, SHIPPING_LABELS_BUY)
  // A stale version is refused before anything is bought (the command would refuse it after).
  if (body.version !== undefined && body.version !== shipment.version) throw new StaleVersionError('Shipment', shipment.id, shipment.version, body.version)
  const read = await caller.withClient((client) => readLabelFacts(client, shipment, carrier.environment))
  const state = buyStateProblems(read.facts)
  if (state.length > 0) throw new InvalidStateError(issuesOf(state))
  const unknown = (body.parcelIds ?? []).filter((id) => !read.parcels.some((parcel) => parcel.id === id))
  if (unknown.length > 0) throw new NotFoundError('Parcel not found in this shipment.')
  const todo = parcelsToLabel(read.parcels).filter((parcel) => body.parcelIds === undefined || body.parcelIds.includes(parcel.id))
  const fields = buyFieldProblems(read.facts, todo)
  if (fields.length > 0) throw new ValidationError(fields.length === 1 ? fields[0]!.message : 'The labels cannot be bought as the shipment stands.', fields)
  const accountId = read.accountId!
  if (todo.length === 0) {
    return { created: false, answer: { ...(await caller.withClient((client) => labelsView(client, shipment, serverClock.now()))), outcomes: [], problem: null } }
  }

  // Outside any transaction: the carrier and the file store, parcel by parcel.
  const formats = labelFormatsFor(read.labelPrinter?.kind ?? null)
  const outcomes: ParcelOutcome[] = []
  const bought: Bought[] = []
  for (const parcel of todo) {
    try {
      const label = await carrier.createLabel(caller, accountId, labelRequestOf(read.facts, parcel))
      const prepared: PreparedGeneratedFile[] = []
      for (const format of formats) {
        const document = await carrier.labelDocument(caller, accountId, label.providerId, format)
        if (prepared.some((file) => file.contentType === LABEL_CONTENT_TYPES[document.format])) continue
        prepared.push(
          await putGeneratedFile(files, caller, {
            companyId: shipment.companyId,
            recordType: 'Parcel',
            recordId: parcel.id,
            kind: document.format === 'PDF' ? 'DOCUMENT' : 'ATTACHMENT',
            originalName: labelFileName(shipment.number, parcel.seq, label.trackingNumber, document.format),
            contentType: LABEL_CONTENT_TYPES[document.format],
            body: document.body,
            visibility: ['FLOOR'],
            floorSiteId: shipment.siteId,
          }),
        )
      }
      bought.push({ parcel, label, files: prepared })
      outcomes.push({ parcelId: parcel.id, seq: parcel.seq, ok: true })
    } catch (error) {
      onError?.(error)
      const why = error instanceof DomainError ? error.message : carrierProblem(error)
      // The reference stays the parcel's until it changes: a label already made is answered again, never bought twice.
      outcomes.push({ parcelId: parcel.id, seq: parcel.seq, ok: false, problem: isCarrierRefusal(error) ? why : `${why} Buy again: a label already made is reused, not bought twice.` })
    }
  }
  const problem = partialProblem(outcomes)
  if (bought.length === 0) {
    throw new DomainError(
      'conflict',
      problem!,
      outcomes.flatMap((outcome) => (outcome.ok ? [] : [{ path: `parcels/${outcome.seq}`, message: outcome.problem }])),
    )
  }

  let surplus: CarrierLabel[] = []
  try {
    await command(
      caller,
      { name: 'shipping.buyLabels', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
      async (tools) => {
        const current = await lockedStatus(tools, shipment.id, ['PACKED'], 'carrier labels are recorded')
        const recorded = await recordBought(tools, current, accountId, bought)
        surplus = recorded.surplus
        return { recorded: recorded.parcels }
      },
    )
  } catch (error) {
    // The shipment is no longer PACKED (unpacked, cancelled): its new labels are cancelled at the carrier, so nobody
    // pays for unused labels, and its parcels take new references (a re-buy must not get a cancelled label back).
    // Any other failure keeps them at the carrier: the next buy sends the same references and gets them back.
    if (!(error instanceof InvalidStateError)) throw error
    await voidQuietly(carrier, caller, accountId, bought.map((entry) => entry.label), onError)
    await retireReferences(caller, shipment.id, bought.map((entry) => entry.parcel.id)).catch((retire) => onError?.(retire))
    throw new InvalidStateError(`${error.message} The labels just bought were voided at Sendcloud.`)
  }
  if (surplus.length > 0) await voidQuietly(carrier, caller, accountId, surplus, onError)
  const after = await caller.withClient(async (client) => labelsView(client, (await readShipment(client, shipment.id))!, serverClock.now()))
  return { created: true, answer: { ...after, outcomes, problem } }
}

/** Inside the buy's command: each bought label on its parcel, with its files; the shipment's carrier and account. */
async function recordBought(tools: CommandTools, shipment: ShipmentHeader, accountId: string, bought: readonly Bought[]): Promise<{ parcels: string[]; surplus: CarrierLabel[] }> {
  const parcels: string[] = []
  const surplus: CarrierLabel[] = []
  for (const entry of bought) {
    const row = await tools.tx.parcel.findFirst({ where: { id: entry.parcel.id, shipmentId: shipment.id }, select: { id: true, trackingNumber: true, carrierParcelId: true } })
    if (!row || row.carrierParcelId === entry.label.providerId) continue
    if (isLabelled({ trackingNumber: row.trackingNumber, providerId: row.carrierParcelId })) {
      surplus.push(entry.label)
      continue
    }
    await tools.tx.parcel.update({
      where: { id: row.id },
      data: { trackingNumber: entry.label.trackingNumber, carrierParcelId: entry.label.providerId, labelledAt: tools.now, version: { increment: 1 } },
      select: { id: true },
    })
    const fileIds: string[] = []
    for (const file of entry.files) fileIds.push((await recordGeneratedFile(tools, file, { action: 'shipping.storeLabel', details: { parcelId: row.id, trackingNumber: entry.label.trackingNumber } })).id)
    tools.audit({
      action: 'shipping.buyLabel',
      recordType: 'Parcel',
      recordId: row.id,
      companyId: shipment.companyId,
      siteId: shipment.siteId,
      before: { trackingNumber: null },
      after: { shipmentId: shipment.id, seq: entry.parcel.seq, trackingNumber: entry.label.trackingNumber, providerId: entry.label.providerId, carrierCode: entry.label.carrierCode, serviceCode: shipment.serviceCode, accountId, fileIds },
    })
    parcels.push(row.id)
  }
  const carrierName = shipment.carrierName ?? bought.find((entry) => entry.label.carrierName)?.label.carrierName ?? null
  const current = await tools.tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { integrationAccountId: true } })
  if (parcels.length > 0 && (current.integrationAccountId === null || (shipment.carrierName === null && carrierName !== null))) {
    await tools.tx.shipment.update({ where: { id: shipment.id }, data: { integrationAccountId: current.integrationAccountId ?? accountId, ...(shipment.carrierName === null && carrierName !== null ? { carrierName } : {}) }, select: { id: true } })
  }
  tools.audit({ action: 'shipping.buyLabels', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { labelled: parcels, surplus: surplus.length } })
  tools.emit({ type: 'shipment.labels_bought', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, bought: parcels.length, failed: bought.length - parcels.length } })
  tools.emit({ type: 'shipment.packing_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, status: shipment.status, change: 'parcels' } })
  return { parcels, surplus }
}

/**
 * After labels bought for parcels were voided unrecorded: the parcels' versions move on (while the shipment is a DRAFT
 * or PACKED), so their next buy sends new references. A cancelled or shipped shipment buys no label again.
 */
async function retireReferences(caller: CommandCaller, shipmentId: string, parcelIds: readonly string[]): Promise<void> {
  await command(caller, { name: 'shipping.retireLabelReferences', input: { shipmentId, parcelIds } }, async (tools) => {
    const shipment = await readShipment(tools.tx, shipmentId)
    if (shipment?.status === 'DRAFT' || shipment?.status === 'PACKED') {
      await tools.tx.parcel.updateMany({ where: { id: { in: [...parcelIds] }, shipmentId, trackingNumber: null }, data: { version: { increment: 1 } } })
    }
    tools.audit({ action: 'shipping.retireLabelReferences', recordType: 'Shipment', recordId: shipmentId, companyId: shipment?.companyId ?? null, siteId: shipment?.siteId ?? null, after: { parcelIds, status: shipment?.status ?? null } })
    return { retired: parcelIds.length }
  })
}

// ---- void -------------------------------------------------------------------------------------------------------------

/**
 * shipping.labels.void: voids a parcel's label before the goods leave. The carrier first (a refusal changes nothing:
 * 409 with its words), then one command on the Shipment clears the parcel's tracking number, provider id and label
 * time. Its files stay (the record's history) but are no longer its label's.
 */
export async function voidLabel(carrier: CarrierRuntime, caller: CommandCaller, shipmentId: string, parcelId: string, body: { version?: number | undefined; reason: string }, idempotencyKey?: string) {
  const shipment = await officeLabelShipment(caller, shipmentId, SHIPPING_LABELS_VOID)
  const parcel = isUuid(parcelId)
    ? await caller.withClient((client) => client.parcel.findFirst({ where: { id: parcelId, shipmentId: shipment.id }, select: { id: true, seq: true, trackingNumber: true, carrierParcelId: true, labelledAt: true } }))
    : null
  if (!parcel) throw new NotFoundError('Parcel not found.')
  const problems = voidProblems(shipment.status, { seq: parcel.seq, trackingNumber: parcel.trackingNumber, providerId: parcel.carrierParcelId })
  if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
  // B-W2a-48 (LOG-028): the carrier has the parcel already: said before the carrier is called.
  const latest = await caller.withClient(async (client) => statusMap(latestStatuses(await readTracking(client, shipment.id))))
  const collected = collectedProblems({ seq: parcel.seq, latest: latest.get(parcel.id) ?? null })
  if (collected.length > 0) throw new InvalidStateError(collected.join(' '))

  let outcome: 'CANCELLED' | 'QUEUED' | 'NOT_SENT' = 'NOT_SENT'
  if (parcel.carrierParcelId !== null) {
    if (!shipment.integrationAccountId) throw new InvalidStateError('The shipment names no Sendcloud connection: its label cannot be voided from here.')
    try {
      outcome = await carrier.voidLabel(caller, shipment.integrationAccountId, parcel.carrierParcelId)
    } catch (error) {
      const why = carrierProblem(error)
      throw new ConflictError(isCarrierRefusal(error) ? `The label of parcel ${parcel.seq} stays: ${why}` : `The label of parcel ${parcel.seq} was not voided: ${why} Try again.`)
    }
  }

  const { result } = await command(
    caller,
    { name: 'shipping.voidLabel', idempotencyKey, input: { shipmentId, parcelId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = await lockedStatus(tools, shipment.id, ['DRAFT', 'PACKED'], 'a label is voided')
      const row = await tools.tx.parcel.findFirst({ where: { id: parcel.id, shipmentId: shipment.id }, select: { trackingNumber: true, carrierParcelId: true } })
      if (!row || row.carrierParcelId !== parcel.carrierParcelId || row.trackingNumber !== parcel.trackingNumber) throw new ConflictError(`The label of parcel ${parcel.seq} changed meanwhile: read the shipment again.`)
      await tools.tx.parcel.update({ where: { id: parcel.id }, data: { trackingNumber: null, carrierParcelId: null, labelledAt: null, version: { increment: 1 } }, select: { id: true } })
      tools.audit({
        action: 'shipping.voidLabel',
        recordType: 'Parcel',
        recordId: parcel.id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { trackingNumber: parcel.trackingNumber, providerId: parcel.carrierParcelId, labelledAt: parcel.labelledAt?.toISOString() ?? null },
        after: { trackingNumber: null, carrier: outcome },
        reason: body.reason,
      })
      tools.emit({ type: 'shipment.label_voided', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, parcelId: parcel.id, seq: parcel.seq, queued: outcome === 'QUEUED' } })
      tools.emit({ type: 'shipment.packing_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, status: current.status, change: 'parcels' } })
      return { voided: parcel.id, carrier: outcome }
    },
  )
  const view = await caller.withClient(async (client) => labelsView(client, (await readShipment(client, shipment.id))!, serverClock.now()))
  return { ...view, voided: { parcelId: result.voided, seq: parcel.seq, carrier: result.carrier, words: voidOutcomeWords(result.carrier) } }
}

/**
 * B-W2a-48 (LOG-028; design pop-up "Void labels"): shipping.labels.void, every labelled parcel of a shipment that has not
 * left, in one go. A parcel the carrier already has keeps its label (said in words, nothing sent for it). The others
 * are cancelled at the carrier one by one OUTSIDE any transaction (a refusal keeps that parcel's label with the
 * carrier's words, the rest go on), then ONE command on the Shipment (its version as read) clears the labels the
 * carrier cancelled, with the reason on each audit row. Nothing cancelled: 409 with every parcel's words.
 */
export async function voidAllLabels(carrier: CarrierRuntime, caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; reason: string }, idempotencyKey?: string) {
  const shipment = await officeLabelShipment(caller, shipmentId, SHIPPING_LABELS_VOID)
  const facts = await caller.withClient(async (client) => {
    const rows = await client.parcel.findMany({ where: { shipmentId: shipment.id }, select: { id: true, seq: true, trackingNumber: true, carrierParcelId: true, labelledAt: true }, orderBy: { seq: 'asc' } })
    const latest = statusMap(latestStatuses(await readTracking(client, shipment.id)))
    return { rows, latest }
  })
  const parcels = facts.rows.map((row) => ({ parcelId: row.id, seq: row.seq, labelled: isLabelled({ trackingNumber: row.trackingNumber, providerId: row.carrierParcelId }), latest: facts.latest.get(row.id) ?? null }))
  const problems = voidAllProblems(shipment.status, parcels)
  if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
  if (body.version !== undefined && body.version !== shipment.version) throw new StaleVersionError('Shipment', shipment.id, shipment.version, body.version)
  const plan = voidAllPlan(parcels)
  const rowOf = new Map(facts.rows.map((row) => [row.id, row]))
  const outcomes: { parcelId: string; seq: number; ok: boolean; carrier: 'CANCELLED' | 'QUEUED' | 'NOT_SENT' | null; problem: string | null }[] = plan.kept.map((entry) => ({ parcelId: entry.parcelId, seq: entry.seq, ok: false, carrier: null, problem: entry.problem }))
  const cancelled: { parcelId: string; seq: number; carrier: 'CANCELLED' | 'QUEUED' | 'NOT_SENT'; trackingNumber: string | null; providerId: string | null; labelledAt: Date | null }[] = []
  for (const parcel of plan.toVoid) {
    const row = rowOf.get(parcel.parcelId)!
    let outcome: 'CANCELLED' | 'QUEUED' | 'NOT_SENT' = 'NOT_SENT'
    if (row.carrierParcelId !== null) {
      if (!shipment.integrationAccountId) {
        outcomes.push({ parcelId: row.id, seq: row.seq, ok: false, carrier: null, problem: 'The shipment names no Sendcloud connection: its label cannot be voided from here.' })
        continue
      }
      try {
        outcome = await carrier.voidLabel(caller, shipment.integrationAccountId, row.carrierParcelId)
      } catch (error) {
        const why = carrierProblem(error)
        outcomes.push({ parcelId: row.id, seq: row.seq, ok: false, carrier: null, problem: isCarrierRefusal(error) ? `The label of parcel ${row.seq} stays: ${why}` : `The label of parcel ${row.seq} was not voided: ${why} Try again.` })
        continue
      }
    }
    cancelled.push({ parcelId: row.id, seq: row.seq, carrier: outcome, trackingNumber: row.trackingNumber, providerId: row.carrierParcelId, labelledAt: row.labelledAt })
    outcomes.push({ parcelId: row.id, seq: row.seq, ok: true, carrier: outcome, problem: null })
  }
  if (cancelled.length === 0) throw new ConflictError(outcomes.map((outcome) => outcome.problem).filter(Boolean).join(' ') || 'No label was voided.')

  await command(
    caller,
    { name: 'shipping.voidLabels', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id } },
    async (tools) => {
      const current = await lockedStatus(tools, shipment.id, ['DRAFT', 'PACKED'], 'labels are voided')
      for (const entry of cancelled) {
        const row = await tools.tx.parcel.findFirst({ where: { id: entry.parcelId, shipmentId: shipment.id }, select: { trackingNumber: true, carrierParcelId: true } })
        // Changed meanwhile (bought again, voided by another): the carrier's answer stands, the row is left as it is now.
        if (!row || row.carrierParcelId !== entry.providerId || row.trackingNumber !== entry.trackingNumber) continue
        await tools.tx.parcel.update({ where: { id: entry.parcelId }, data: { trackingNumber: null, carrierParcelId: null, labelledAt: null, version: { increment: 1 } }, select: { id: true } })
        tools.audit({
          action: 'shipping.voidLabel',
          recordType: 'Parcel',
          recordId: entry.parcelId,
          companyId: current.companyId,
          siteId: current.siteId,
          before: { trackingNumber: entry.trackingNumber, providerId: entry.providerId, labelledAt: entry.labelledAt?.toISOString() ?? null },
          after: { trackingNumber: null, carrier: entry.carrier, all: true },
          reason: body.reason,
        })
        tools.emit({ type: 'shipment.label_voided', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, parcelId: entry.parcelId, seq: entry.seq, queued: entry.carrier === 'QUEUED' } })
      }
      tools.audit({ action: 'shipping.voidLabels', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { voided: cancelled.map((entry) => entry.seq), kept: outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.seq) }, reason: body.reason })
      tools.emit({ type: 'shipment.packing_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, status: current.status, change: 'parcels' } })
      return { voided: cancelled.length }
    },
  )
  const view = await caller.withClient(async (client) => labelsView(client, (await readShipment(client, shipment.id))!, serverClock.now()))
  return {
    ...view,
    outcomes: outcomes.sort((a, b) => a.seq - b.seq).map((outcome) => ({ ...outcome, words: outcome.carrier ? voidOutcomeWords(outcome.carrier) : null })),
    problem: outcomes.some((outcome) => !outcome.ok) ? `${cancelled.length} of ${outcomes.length} labels were voided; see each parcel.` : null,
  }
}

// ---- print and read ---------------------------------------------------------------------------------------------------

/** The most bytes one ZPL label may have. */
const MAX_ZPL_BYTES = 512 * 1024

/** The shipment a packer may see (office within its grants, a floor device at its own site), else 404. */
async function packerShipment(caller: CommandCaller, shipmentId: string) {
  const context = shippingContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_PACK, SHIPPING_PACK, shipment)
  return { context, shipment: shipment! }
}

/** shipping.pack: the shipment's parcels, labels, files, print state and today's cut-off. */
export async function getLabels(caller: CommandCaller, shipmentId: string): Promise<LabelsView> {
  const { context, shipment } = await packerShipment(caller, shipmentId)
  // B-W2b-19: the office also reads the voided labels (their audit rows); a floor device reads no audit.
  return caller.withClient((client) => labelsView(client, shipment, serverClock.now(), context.audience === 'office'))
}

export interface PrintBody {
  readonly parcelIds?: readonly string[] | undefined
  readonly printerId?: string | undefined
  readonly copies?: number | undefined
}

/**
 * shipping.pack + print.labels: queues the labels' ZPL (each labelled parcel, or those named) for the site's label
 * printer, one print job per parcel (recordType Parcel, label kind CARTON, the tracking number as its scan id); the
 * worker hands them to the printer's relay. The ZPL is read from the file store (files.read; a floor device's read runs
 * as its tenant's system after the checks above).
 */
export async function printLabels(files: FilesRuntime, callers: Callers, shipmentId: string, body: PrintBody, idempotencyKey?: string) {
  const caller = callers.caller
  const { context, shipment } = await packerShipment(caller, shipmentId)
  const settings = await caller.withClient((client) => client.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { labelPrinterId: true } }))
  const printerId = body.printerId ?? settings?.labelPrinterId ?? null
  if (!printerId) throw new ValidationError('No label printer.', [{ path: 'body/printerId', message: "Choose a label printer, or set the site's (shipping settings); a PDF label prints from the browser." }])
  const printer = await readPrinter(caller, printerId)
  if (!can(actorOf(context), PRINT_LABELS, { companyId: printer.companyId, siteId: printer.siteId })) throw new ForbiddenError()
  if (printer.siteId !== shipment.siteId) throw new ValidationError('Not a printer of this site.', [{ path: 'body/printerId', message: "Choose a label printer of the shipment's site." }])
  if (printer.kind !== 'LABEL_ZPL') throw new ValidationError('This printer prints PDFs.', [{ path: 'body/printerId', message: 'Choose a label printer (ZPL); a PDF label prints from the browser.' }])
  if (printer.status !== 'ACTIVE') throw new InvalidStateError(`This printer is ${printer.status.toLowerCase()}; it takes no jobs now.`)
  const copies = body.copies ?? 1

  const rows = await caller.withClient((client) => readLabelParcels(client, shipment.id))
  const unknown = (body.parcelIds ?? []).filter((id) => !rows.some((row) => row.id === id))
  if (unknown.length > 0) throw new NotFoundError('Parcel not found in this shipment.')
  const chosen = rows.filter((row) => (body.parcelIds === undefined || body.parcelIds.includes(row.id)) && row.trackingNumber !== null && row.labelledAt !== null)
  if (chosen.length === 0) throw new InvalidStateError('No parcel of this shipment has a carrier label to print: buy the labels first.')
  const labelFiles = await caller.withClient((client) => labelFilesOf(client, chosen))
  const store = context.audience === 'office' ? caller : callers.system(tenantOf(context))
  const zpl: { parcelId: string; seq: number; trackingNumber: string; text: string }[] = []
  for (const row of chosen) {
    const fileId = labelFiles.get(row.id)?.find((file) => file.format === 'ZPL')?.fileId
    if (!fileId) throw new InvalidStateError(`The label of parcel ${row.seq} was kept as a PDF only (the site had no label printer when it was bought): print its PDF from the browser.`)
    const object = await store.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: { storeAccountId: true, storageKey: true } }))
    const bytes = object ? await files.storage.read(store, object.storeAccountId, object.storageKey, MAX_ZPL_BYTES) : null
    if (!bytes) throw new InvalidStateError(`The label file of parcel ${row.seq} is missing from the file store: void the label and buy it again.`)
    zpl.push({ parcelId: row.id, seq: row.seq, trackingNumber: row.trackingNumber!, text: bytes.toString('utf8') })
  }

  const { result } = await command(caller, { name: 'shipping.printLabels', idempotencyKey, input: { shipmentId, ...body } }, async ({ tx, audit, emit, now, context: inside }) => {
    const current = await tx.printer.findUnique({ where: { id: printer.id }, select: { status: true } })
    if (current?.status !== 'ACTIVE') throw new InvalidStateError('This printer takes no jobs now.')
    const requester =
      inside.audience === 'floor'
        ? { requestedById: inside.actorId, deviceId: inside.deviceId, createdById: inside.actorId }
        : inside.audience === 'office'
          ? { requestedById: inside.actorId, deviceId: null, createdById: inside.actorId }
          : { requestedById: null, deviceId: null, createdById: null }
    const jobs: { jobId: string; parcelId: string; seq: number; status: string }[] = []
    for (const label of zpl) {
      const id = newId()
      await tx.printJob.create({
        data: {
          id,
          companyId: printer.companyId,
          siteId: printer.siteId,
          printerId: printer.id,
          recordType: 'Parcel',
          recordId: label.parcelId,
          payloadKind: 'ZPL',
          // A carrier label goes on the carton (the print screens know the factory's label kinds).
          labelKind: 'CARTON',
          scanId: label.trackingNumber,
          zpl: label.text,
          copies,
          ...requester,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      })
      audit({ recordType: 'PrintJob', recordId: id, companyId: printer.companyId, siteId: printer.siteId, after: { printerId: printer.id, recordType: 'Parcel', recordId: label.parcelId, payloadKind: 'ZPL', scanId: label.trackingNumber, copies, shipmentId: shipment.id } })
      emit({ type: 'print.job_queued', subject: id, companyId: printer.companyId, siteId: printer.siteId, payload: { jobId: id, printerId: printer.id, payloadKind: 'ZPL' } })
      jobs.push({ jobId: id, parcelId: label.parcelId, seq: label.seq, status: 'QUEUED' })
    }
    return { jobs }
  })
  return result
}
