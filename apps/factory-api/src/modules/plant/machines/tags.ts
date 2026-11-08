import type { Prisma } from '@nexus/factory-db'
import { PRINT_LABELS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { MACHINE_RECORD } from '@nexus/factory-domain/plant/machines/documents'
import { tagOtherSite, tagRetired, type MachineDepthRefusal } from '@nexus/factory-domain/plant/machines/status'
import { MACHINE_TAG_KIND, machineTagZpl, TAG_WORDS, type TagLanguage } from '@nexus/factory-domain/plant/machines/tag'
import { PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { queueModuleLabel } from '../../../platform/print/jobs'
import { officeOf, scopeOf } from '../access'
import { MACHINE_COLUMNS, wordsOf, type MachineRow } from '../store'

/**
 * Print QR tags (B-W2b-136; QHS-164; design plant.machines pop "Print QR tags", record tab "Tag"): the machines' tags sent
 * to a label printer of their site through platform/print (QUEUED → SENT → PRINTED, or FAILED and sent again with
 * POST /print/jobs/:jobId/retry), one print job per machine. Office only:
 *
 *   GET  /plant/machines/tags/printers?siteId=   the ACTIVE label printers where the caller prints labels (print.labels)
 *   POST /plant/machines/tags/print               {printerId, machineIds, copies, language}: one job per machine; a retired
 *        machine or one of another site is refused in words and the others go (plant.view for each machine, print.labels
 *        at the printer's site: queueModuleLabel's own check)
 *   GET  /plant/machines/tags/jobs?ids=           the newest tag job of each machine named (plant.view)
 *
 * The QR holds the asset number (factory-domain plant/machines/tag.ts): a tag printed again is the same tag, the old one
 * keeps working. A sheet printed from the browser (the W2a tag sheet) is not a print job and is not recorded.
 */

const JOB_SELECT = { id: true, recordId: true, printerId: true, status: true, copies: true, lastError: true, createdAt: true, printedAt: true, version: true, printer: { select: { code: true } } } as const

const jobOut = (row: { id: string; recordId: string; printerId: string; status: string; copies: number; lastError: string | null; createdAt: Date; printedAt: Date | null; version: number; printer: { code: string } }) => ({
  machineId: row.recordId,
  jobId: row.id,
  printerId: row.printerId,
  printerCode: row.printer.code,
  state: row.status as 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED',
  copies: row.copies,
  lastError: row.lastError,
  at: toUtcIso(row.createdAt),
  printedAt: row.printedAt ? toUtcIso(row.printedAt) : null,
  version: row.version,
})

/** GET /plant/machines/tags/printers. */
export async function tagPrinters(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const where: Prisma.PrinterWhereInput = {
    AND: [scopeWhere(actorOf(context), PRINT_LABELS, { company: 'companyId', site: 'siteId' }) as Prisma.PrinterWhereInput, query.siteId ? { siteId: query.siteId } : {}, { kind: 'LABEL_ZPL', status: 'ACTIVE' }],
  }
  const rows = await caller.withClient((client) =>
    client.printer.findMany({ where, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, code: true, name: true, siteId: true, labelWidthMm: true, labelHeightMm: true, dpi: true, site: { select: { code: true } } } }),
  )
  return {
    printers: rows
      .filter((row) => row.labelWidthMm !== null && row.labelHeightMm !== null && row.dpi !== null)
      .map((row) => ({ id: row.id, code: row.code, name: row.name, siteId: row.siteId, siteCode: row.site.code, labelWidthMm: row.labelWidthMm!, labelHeightMm: row.labelHeightMm!, dpi: row.dpi! })),
  }
}

export interface PrintTagsBody {
  readonly printerId: string
  readonly machineIds: readonly string[]
  readonly copies: number
  readonly language: TagLanguage
}

/** POST /plant/machines/tags/print. */
export async function printTags(caller: CommandCaller, body: PrintTagsBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const printer = await caller.withClient((client) => client.printer.findUnique({ where: { id: body.printerId }, select: { id: true, siteId: true } }))
  if (!printer) throw new NotFoundError('Printer not found.')
  const ids = [...new Set(body.machineIds)]
  const rows = (await caller.withClient((client) =>
    client.machine.findMany({ where: { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MachineWhereInput, { id: { in: ids } }] }, orderBy: [{ assetNumber: 'asc' }, { id: 'asc' }], select: MACHINE_COLUMNS }),
  )) as MachineRow[]
  if (rows.length === 0) throw new NotFoundError('Machine not found.')
  const jobs: ReturnType<typeof jobOut>[] = []
  const refused: { machineId: string; assetNumber: string; code: string; message: string }[] = []
  const say = (machine: MachineRow, refusal: MachineDepthRefusal) => refused.push({ machineId: machine.id, assetNumber: machine.assetNumber, code: refusal.code, message: refusal.message })
  for (const machine of rows) {
    if (machine.status === 'RETIRED') {
      say(machine, tagRetired(machine.assetNumber))
      continue
    }
    if (machine.siteId !== printer.siteId) {
      say(machine, tagOtherSite(machine.assetNumber))
      continue
    }
    const classWords = wordsOf(machine.machineClass.labelI18n)
    const tag = {
      assetNumber: machine.assetNumber,
      typeWords: classWords[body.language] ?? (body.language === 'it' ? machine.machineClass.labelIt : machine.machineClass.labelEn),
      placeWords: [machine.site.code, machine.station ? machine.station.code : null].filter(Boolean).join(' · '),
      scanWords: TAG_WORDS[body.language].scan,
    }
    const view = await queueModuleLabel(
      caller,
      { printerId: printer.id, recordType: MACHINE_RECORD, recordId: machine.id, copies: body.copies, labelKind: MACHINE_TAG_KIND, scanId: machine.assetNumber, zplFor: (stock) => machineTagZpl(tag, stock, body.copies) },
      idempotencyKey ? `${idempotencyKey}:${machine.id}` : undefined,
    )
    jobs.push({ machineId: machine.id, jobId: view.id, printerId: view.printerId, printerCode: '', state: view.status, copies: view.copies, lastError: view.lastError, at: view.createdAt, printedAt: view.printedAt, version: view.version })
  }
  const codes = await caller.withClient((client) => client.printer.findUnique({ where: { id: printer.id }, select: { code: true } }))
  return { jobs: jobs.map((job) => ({ ...job, printerCode: codes?.code ?? '' })), refused }
}

/** GET /plant/machines/tags/jobs?ids=. */
export async function tagJobs(caller: CommandCaller, query: { readonly ids: readonly string[] }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const visible = (await client.machine.findMany({ where: { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MachineWhereInput, { id: { in: [...query.ids] } }] }, select: { id: true } })).map((row) => row.id)
    if (visible.length === 0) return { jobs: [] }
    const rows = await client.printJob.findMany({ where: { recordType: MACHINE_RECORD, recordId: { in: visible }, labelKind: MACHINE_TAG_KIND }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: JOB_SELECT })
    const newest = new Map<string, (typeof rows)[number]>()
    for (const row of rows) if (!newest.has(row.recordId)) newest.set(row.recordId, row)
    return { jobs: [...newest.values()].map(jobOut) }
  })
}
