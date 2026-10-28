import type { Prisma } from '@nexus/factory-db'
import { PRINT_MANAGE, PRINT_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import type { PrintRelayKind } from '../../adapters/print-relay/port'
import { command, type CommandCaller } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import type { PrinterView } from './contract'
import { printerMachine, printerProblems, type PrinterKind, type PrinterStatus } from './rules'
import { processPrintRelays } from './service'

/**
 * The printers of each site (plan A1 §3.9; GAP-007): listed by every audience that prints (a floor device sees its own
 * site's, without where the relay reaches them), added and changed by print.manage (name, relay target, label stock,
 * pause, archive). A printer's kind never changes; a printer is archived, never deleted.
 */

const COMMON = {
  id: true,
  companyId: true,
  siteId: true,
  code: true,
  name: true,
  kind: true,
  relay: true,
  dpi: true,
  labelWidthMm: true,
  labelHeightMm: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PrinterSelect
const OFFICE = { ...COMMON, relayTarget: true } as const satisfies Prisma.PrinterSelect

export type PrinterRow = Prisma.PrinterGetPayload<{ select: typeof COMMON }> & { relayTarget?: string }
type OfficeRow = Prisma.PrinterGetPayload<{ select: typeof OFFICE }>

/** What each audience's role may read of a printer: the floor role has no grant on relayTarget. */
export const printerSelect = (context: RequestContext): Prisma.PrinterSelect => (context.audience === 'floor' ? COMMON : OFFICE)

export function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

export function printerView(row: PrinterRow): PrinterView {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    code: row.code,
    name: row.name,
    kind: row.kind,
    relay: row.relay,
    ...(row.relayTarget === undefined ? {} : { relayTarget: row.relayTarget }),
    dpi: row.dpi,
    labelWidthMm: row.labelWidthMm,
    labelHeightMm: row.labelHeightMm,
    status: row.status,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const audited = (row: OfficeRow) => ({
  siteId: row.siteId,
  code: row.code,
  name: row.name,
  kind: row.kind,
  relay: row.relay,
  relayTarget: row.relayTarget,
  dpi: row.dpi,
  labelWidthMm: row.labelWidthMm,
  labelHeightMm: row.labelHeightMm,
  status: row.status,
})

/** The printer as the caller's role sees it; another site's (a floor device) or another tenant's is not found. */
export async function readPrinter(caller: CommandCaller, printerId: string): Promise<PrinterRow> {
  const context = contextOf(caller)
  if (!isUuid(printerId)) throw new NotFoundError('Printer not found.')
  const row = (await caller.withClient((client) => client.printer.findUnique({ where: { id: printerId }, select: printerSelect(context) }))) as PrinterRow | null
  if (!row) throw new NotFoundError('Printer not found.')
  return row
}

/** The site's printers the caller may see, by site and code (archived ones only when asked). */
export async function listPrinters(caller: CommandCaller, query: { siteId?: string | undefined; includeArchived?: boolean | undefined }): Promise<PrinterView[]> {
  const context = contextOf(caller)
  const where: Prisma.PrinterWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PRINT_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.PrinterWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.includeArchived ? {} : { status: { not: 'ARCHIVED' } },
    ],
  }
  const rows = (await caller.withClient((client) =>
    client.printer.findMany({ where, select: printerSelect(context), orderBy: [{ siteId: 'asc' }, { code: 'asc' }], take: 500 }),
  )) as PrinterRow[]
  return rows.map(printerView)
}

function mayManage(caller: CommandCaller, scope: { companyId: string; siteId: string }): void {
  if (!can(actorOf(contextOf(caller)), PRINT_MANAGE, scope)) throw new ForbiddenError()
}

/** A FAKE printer only where the fake relay exists (local and test): production has no relay until the Owner picks one. */
function relayProblems(relay: PrintRelayKind): Issue[] {
  return processPrintRelays().relayFor(relay) ? [] : [{ path: 'body/relay', message: `No ${relay} print relay serves this environment.` }]
}

export interface CreatePrinter {
  readonly siteId: string
  readonly code: string
  readonly name: string
  readonly kind: PrinterKind
  readonly relay: PrintRelayKind
  readonly relayTarget: string
  readonly dpi?: number | null | undefined
  readonly labelWidthMm?: number | null | undefined
  readonly labelHeightMm?: number | null | undefined
}

/** print.createPrinter: a printer on a site the caller manages. */
export async function createPrinter(caller: CommandCaller, input: CreatePrinter, idempotencyKey?: string): Promise<PrinterView> {
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: input.siteId }, select: { id: true, companyId: true, status: true } }))
  if (!site) throw new NotFoundError('Site not found.')
  mayManage(caller, { companyId: site.companyId, siteId: site.id })
  const shape = { kind: input.kind, relayTarget: input.relayTarget, dpi: input.dpi ?? null, labelWidthMm: input.labelWidthMm ?? null, labelHeightMm: input.labelHeightMm ?? null }
  const problems = [...printerProblems(shape), ...relayProblems(input.relay)]
  if (problems.length > 0) throw new ValidationError('The printer is not valid.', problems)
  const taken = await caller.withClient((client) => client.printer.findFirst({ where: { siteId: site.id, code: input.code }, select: { id: true } }))
  if (taken) throw new ConflictError(`The site already has a printer ${input.code}.`)

  const { result } = await command(caller, { name: 'print.createPrinter', idempotencyKey, input }, async ({ tx, audit, now, context }) => {
    const id = newId()
    const row = await tx.printer.create({
      data: { id, companyId: site.companyId, siteId: site.id, code: input.code, name: input.name, relay: input.relay, ...shape, createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null },
      select: OFFICE,
    })
    audit({ recordType: 'Printer', recordId: id, companyId: row.companyId, siteId: row.siteId, after: audited(row) })
    return printerView(row)
  })
  return result
}

export interface UpdatePrinter {
  readonly version: number
  readonly name?: string | undefined
  readonly relayTarget?: string | undefined
  readonly dpi?: number | null | undefined
  readonly labelWidthMm?: number | null | undefined
  readonly labelHeightMm?: number | null | undefined
  readonly status?: PrinterStatus | undefined
}

/** print.updatePrinter: its name, relay target, label stock, or status (paused, active again, archived for good). */
export async function updatePrinter(caller: CommandCaller, printerId: string, input: UpdatePrinter, idempotencyKey?: string): Promise<PrinterView> {
  const before = (await readPrinter(caller, printerId)) as OfficeRow
  mayManage(caller, { companyId: before.companyId, siteId: before.siteId })
  if (input.status !== undefined && input.status !== before.status) assertTransition(printerMachine, before.status, input.status)
  const changes = {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.relayTarget === undefined ? {} : { relayTarget: input.relayTarget }),
    ...(input.dpi === undefined ? {} : { dpi: input.dpi }),
    ...(input.labelWidthMm === undefined ? {} : { labelWidthMm: input.labelWidthMm }),
    ...(input.labelHeightMm === undefined ? {} : { labelHeightMm: input.labelHeightMm }),
    ...(input.status === undefined ? {} : { status: input.status }),
  }
  const problems = printerProblems({ ...before, ...changes })
  if (problems.length > 0) throw new ValidationError('The printer is not valid.', problems)
  const { result } = await command(
    caller,
    { name: 'print.updatePrinter', idempotencyKey, input: { printerId, ...input }, record: { type: 'Printer', id: printerId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const row = await tx.printer.update({ where: { id: printerId }, data: changes, select: OFFICE })
      audit({ recordType: 'Printer', recordId: printerId, companyId: row.companyId, siteId: row.siteId, before: audited(before), after: audited(row) })
      return printerView(row)
    },
  )
  return result
}
