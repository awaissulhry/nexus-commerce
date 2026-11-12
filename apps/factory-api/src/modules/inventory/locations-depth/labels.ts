import type { Prisma } from '@nexus/factory-db'
import { PRINT_LABELS, PRINT_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { kindProfile } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { binLabel, LOCATION_LABEL_KIND, LOCATION_RECORD, labelCodeProblems, normalizeLabelCode, suggestedLabelCode, type BinLabel } from '@nexus/factory-domain/inventory/locations-depth/labels'
import { INVENTORY_LOCATIONS_MANAGE, INVENTORY_LOCATIONS_VIEW } from '@nexus/factory-domain/inventory/permissions'
import type { LabelLanguage } from '@nexus/factory-domain/labels/model'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { binLabelFacts, binLabelsPdf, queueBinLabel } from '../../../platform/print/layouts/bin'
import { mayAt, officeContextOf, stockContextOf } from '../ledger/access'
import type { PlaceView } from './contract'
import { pathOf, PLACE_SELECT, placeIn, placeViewOf, visiblePlace, type PlaceRow } from './places'

/**
 * Bin labels (B-W2b-289; SCM-178; design warehouse.locations › Location › Labels: the label and its print history; band
 * "Print labels"; tab "Bin labels PDF"). A place's label code (Location.labelCode, unique in the tenant, in capitals) is
 * what the factory's phone or tablet camera reads to confirm a put-away, a move or a count (Owner Q4 = A):
 *
 *   PUT  /inventory/locations/:locationId/label-code  {version, labelCode?}: gives (left out: the suggested code), changes
 *        or takes off (null) the code (office, inventory.locations.manage); a changed code answers how many labels were
 *        printed with the old one (they no longer scan)
 *   GET  /inventory/locations/:locationId/label        the label as it prints now (its code, or the suggested one) and
 *        its print history (inventory.locations.view; the jobs need print.view)
 *   POST /inventory/locations/labels/print             {printerId, locationIds, copies, language}: one print job per place
 *        on a label printer of their site (print.labels there); a place without a code is given its suggested code first
 *        (one command), an outside or transit place or one of another site is refused in words and the others go
 *   POST /inventory/locations/labels/pdf               the same labels as one PDF (the browser's print), for any printer
 *   GET  /inventory/locations/scan?code=               the place a scanned code names (office and floor: a floor device
 *        finds only its own site's places); a code no place carries is not found
 *
 * Events: inventory.location_label_changed per place given, changed or cleared.
 */

const PRINT_JOB_SELECT = { id: true, printerId: true, status: true, copies: true, lastError: true, createdAt: true, printedAt: true, printer: { select: { code: true } } } as const

function labelChanged(emit: CommandTools['emit'], row: PlaceRow, before: string | null): void {
  const change = row.labelCode === null ? 'CLEARED' : before === null ? 'SET' : 'CHANGED'
  emit({ type: 'inventory.location_label_changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { locationId: row.id, code: row.code, labelCode: row.labelCode, change } })
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** Which place carries this code already (any site of the tenant the database lets the caller see), or null. */
async function carrier(tx: Pick<CommandTx, 'location'>, labelCode: string, otherThan: string): Promise<{ code: string; site: { code: string } } | null> {
  return tx.location.findFirst({ where: { labelCode, id: { not: otherThan } }, select: { code: true, site: { select: { code: true } } } })
}

const taken = (labelCode: string, other: { code: string; site: { code: string } } | null) =>
  new ConflictError(other ? `Label code ${labelCode} is on location ${other.code} of site ${other.site.code} already: a scan names one place.` : `Label code ${labelCode} is taken: a scan names one place.`)

/** Gives one place its code inside a command (checked: free in the tenant, a place that carries a label). */
async function writeCode(tools: CommandTools, current: PlaceRow, labelCode: string | null, bump: boolean): Promise<PlaceRow> {
  const { tx, audit, emit } = tools
  if (labelCode !== null) {
    const other = await carrier(tx, labelCode, current.id)
    if (other) throw taken(labelCode, other)
  }
  const row = await tx.location.update({ where: { id: current.id }, data: { labelCode, ...(bump ? { version: { increment: 1 } } : {}) }, select: PLACE_SELECT })
  audit({ action: 'inventory.locations.labelCode', recordType: 'Location', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { labelCode: current.labelCode }, after: { labelCode: row.labelCode } })
  labelChanged(emit, row, current.labelCode)
  return row
}

function labelledOnly(row: Pick<PlaceRow, 'code' | 'kind' | 'status'>): string | null {
  if (row.status !== 'ACTIVE') return `Location ${row.code} is archived: it gets no label.`
  if (!kindProfile(row.kind).labelled) return `Location ${row.code} is not a place on the floor (an outside or transit place): it gets no bin label.`
  return null
}

/** PUT /inventory/locations/:locationId/label-code. */
export async function setLabelCode(caller: CommandCaller, locationId: string, body: { readonly version: number; readonly labelCode?: string | null | undefined }, idempotencyKey?: string): Promise<{ location: PlaceView; printed: number }> {
  officeContextOf(caller)
  const before = await visiblePlace(caller, locationId, INVENTORY_LOCATIONS_MANAGE)
  const wanted = body.labelCode === null ? null : body.labelCode === undefined ? suggestedLabelCode(before.site.code, before.code) : normalizeLabelCode(body.labelCode)
  if (wanted !== null) {
    const problems = labelCodeProblems(wanted)
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, [{ path: 'body/labelCode', message: problems[0]!.message }])
    const refusal = labelledOnly(before)
    if (refusal) throw new ValidationError(refusal, [{ path: 'location', message: refusal }])
  }
  if (before.labelCode === wanted) return { location: placeViewOf(before), printed: 0 }
  try {
    const { result } = await command(
      caller,
      { name: 'inventory.locations.labelCode', idempotencyKey, input: { locationId, ...body }, record: { type: 'Location', id: locationId, expectedVersion: body.version } },
      async (tools) => {
        const current = await placeIn(tools.tx, locationId)
        if (current.labelCode === wanted) return { location: placeViewOf(current), printed: 0 }
        // Labels printed with the old code no longer scan once it changes (design: "Printed labels show the old code").
        const printed = current.labelCode === null ? 0 : await tools.tx.printJob.count({ where: { recordType: LOCATION_RECORD, recordId: locationId, labelKind: LOCATION_LABEL_KIND, scanId: current.labelCode } })
        const row = await writeCode(tools, current, wanted, false)
        return { location: placeViewOf(row), printed }
      },
    )
    return result
  } catch (error) {
    if (isUniqueViolation(error) && wanted !== null) throw taken(wanted, null)
    throw error
  }
}

/** GET /inventory/locations/:locationId/label. */
export async function locationLabel(caller: CommandCaller, locationId: string, query: { readonly language?: LabelLanguage | undefined }) {
  const context = stockContextOf(caller)
  const row = await visiblePlace(caller, locationId)
  const code = row.labelCode ?? suggestedLabelCode(row.site.code, row.code)
  return caller.withClient(async (client) => {
    const path = await pathOf(client, row)
    const facts = await binLabelFacts(client, row, code, path)
    const seesJobs = context.audience === 'system' || can(actorOf(context), PRINT_VIEW, { companyId: row.companyId, siteId: row.siteId })
    const jobs = seesJobs
      ? await client.printJob.findMany({ where: { recordType: LOCATION_RECORD, recordId: row.id, labelKind: LOCATION_LABEL_KIND }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50, select: PRINT_JOB_SELECT })
      : []
    return {
      location: placeViewOf(row),
      code,
      suggested: row.labelCode === null,
      labelled: kindProfile(row.kind).labelled,
      label: (({ fields, ...rest }) => ({ ...rest, fields: [...fields] }))(binLabel(facts, query.language ?? 'it')),
      jobs: jobs.map((job) => ({ jobId: job.id, printerId: job.printerId, printerCode: job.printer.code, state: job.status, copies: job.copies, lastError: job.lastError, at: toUtcIso(job.createdAt), printedAt: job.printedAt ? toUtcIso(job.printedAt) : null })),
    }
  })
}

interface Picked {
  readonly ready: PlaceRow[]
  readonly refused: { locationId: string; code: string; message: string }[]
}

/** The places asked, the caller's to label (inventory.locations.view; a code given needs manage), in code order. */
async function pickPlaces(caller: CommandCaller, locationIds: readonly string[], siteId: string | null): Promise<Picked> {
  const context = stockContextOf(caller)
  const ids = [...new Set(locationIds)]
  const rows = await caller.withClient((client) => client.location.findMany({ where: { id: { in: ids } }, select: PLACE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] }))
  const seen = rows.filter((row) => mayAt(context, INVENTORY_LOCATIONS_VIEW, row))
  if (seen.length === 0) throw new NotFoundError('Location not found.')
  const ready: PlaceRow[] = []
  const refused: Picked['refused'] = []
  for (const row of seen) {
    const refusal = labelledOnly(row) ?? (siteId !== null && row.siteId !== siteId ? `Location ${row.code} is at site ${row.site.code}: print its label on a printer of that site.` : null)
    if (refusal) refused.push({ locationId: row.id, code: row.code, message: refusal })
    else ready.push(row)
  }
  return { ready, refused }
}

/**
 * One command: every ready place without a code gets its suggested one (a code another place carries is refused in words
 * for that place; the others go). Office only (inventory.locations.manage at each place's site) when a code is given.
 */
async function giveMissingCodes(caller: CommandCaller, picked: Picked, idempotencyKey: string | undefined): Promise<Picked> {
  const missing = picked.ready.filter((row) => row.labelCode === null)
  if (missing.length === 0) return picked
  const context = stockContextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError(`${missing.map((row) => row.code).join(', ')}: no label code yet; the office gives one first.`)
  for (const row of missing) if (!mayAt(context, INVENTORY_LOCATIONS_MANAGE, row)) throw new ForbiddenError(`Location ${row.code} has no label code yet, and giving one needs inventory.locations.manage.`)
  const { result } = await command(caller, { name: 'inventory.locations.labelCodes', idempotencyKey: idempotencyKey ? `${idempotencyKey}:codes` : undefined, input: { locationIds: missing.map((row) => row.id) } }, async (tools) => {
    const given: PlaceRow[] = []
    const refused: Picked['refused'] = []
    const inBatch = new Set<string>()
    for (const row of missing) {
      const current = await placeIn(tools.tx, row.id)
      if (current.labelCode !== null) {
        given.push(current)
        continue
      }
      const code = suggestedLabelCode(current.site.code, current.code)
      const other = inBatch.has(code) ? { code: '(another place of this print)', site: { code: current.site.code } } : await carrier(tools.tx, code, current.id)
      if (other) {
        refused.push({ locationId: current.id, code: current.code, message: `Its suggested label code ${code} is on location ${other.code} of site ${other.site.code}: give it a code of its own first.` })
        continue
      }
      inBatch.add(code)
      given.push(await writeCode(tools, current, code, true))
    }
    return { given: given.map((row) => row.id), refused }
  })
  const fresh = await caller.withClient((client) => client.location.findMany({ where: { id: { in: picked.ready.map((row) => row.id) } }, select: PLACE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] }))
  const refusedIds = new Set(result.refused.map((entry) => entry.locationId))
  return { ready: fresh.filter((row) => row.labelCode !== null && !refusedIds.has(row.id)), refused: [...picked.refused, ...result.refused] }
}

/** POST /inventory/locations/labels/print. */
export async function printLabels(caller: CommandCaller, body: { readonly printerId: string; readonly locationIds: readonly string[]; readonly copies: number; readonly language: LabelLanguage }, idempotencyKey?: string) {
  const context = stockContextOf(caller)
  const printer = await caller.withClient((client) => client.printer.findUnique({ where: { id: body.printerId }, select: { id: true, companyId: true, siteId: true } }))
  if (!printer || (context.audience !== 'system' && !can(actorOf(context), PRINT_LABELS, { companyId: printer.companyId, siteId: printer.siteId }))) throw new NotFoundError('Printer not found.')
  const picked = await giveMissingCodes(caller, await pickPlaces(caller, body.locationIds, printer.siteId), idempotencyKey)
  const jobs: { locationId: string; labelCode: string; jobId: string; state: 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED' }[] = []
  for (const row of picked.ready) {
    const facts = await caller.withClient(async (client) => binLabelFacts(client, row, row.labelCode!, await pathOf(client, row)))
    const job = await queueBinLabel(caller, { printerId: printer.id, locationId: row.id, facts, copies: body.copies, language: body.language }, idempotencyKey ? `${idempotencyKey}:${row.id}` : undefined)
    jobs.push({ locationId: row.id, labelCode: row.labelCode!, jobId: job.id, state: job.status })
  }
  return { jobs, refused: picked.refused }
}

/** POST /inventory/locations/labels/pdf. */
export async function labelsPdf(caller: CommandCaller, body: { readonly locationIds: readonly string[]; readonly widthMm: number; readonly heightMm: number; readonly copies: number; readonly language: LabelLanguage }, idempotencyKey?: string): Promise<{ pdf: Buffer; fileName: string; refused: number }> {
  const picked = await giveMissingCodes(caller, await pickPlaces(caller, body.locationIds, null), idempotencyKey)
  if (picked.ready.length === 0) {
    throw new ValidationError('None of these places gets a bin label.', picked.refused.map((entry) => ({ path: `body/locationIds/${body.locationIds.indexOf(entry.locationId)}`, message: entry.message })))
  }
  const labels: BinLabel[] = []
  for (const row of picked.ready) labels.push(binLabel(await caller.withClient(async (client) => binLabelFacts(client, row, row.labelCode!, await pathOf(client, row))), body.language))
  const pdf = await binLabelsPdf(labels, { widthMm: body.widthMm, heightMm: body.heightMm }, body.copies)
  const fileName = labels.length === 1 ? `${labels[0]!.scanId.replace(/[^A-Z0-9._-]/g, '_')}.pdf` : `bin-labels-${labels.length}.pdf`
  return { pdf, fileName, refused: picked.refused.length }
}

/** GET /inventory/locations/scan?code=: the place a scan names. */
export async function scanLocation(caller: CommandCaller, query: { readonly code: string }): Promise<{ location: PlaceView; path: string[] }> {
  const context = stockContextOf(caller)
  const code = normalizeLabelCode(query.code)
  const row = await caller.withClient((client) => client.location.findFirst({ where: { labelCode: code } as Prisma.LocationWhereInput, select: PLACE_SELECT }))
  if (!row || !mayAt(context, INVENTORY_LOCATIONS_VIEW, row)) throw new NotFoundError(`No place carries label ${code}.`)
  const path = await caller.withClient((client) => pathOf(client, row))
  return { location: placeViewOf(row), path }
}
