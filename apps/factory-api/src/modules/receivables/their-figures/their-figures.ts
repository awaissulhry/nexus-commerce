import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import type { CorrectFiguresBody, RecordFiguresBody } from '@nexus/factory-domain/receivables-figures/contracts'
import { compareFigures, FIGURES_REFUSAL_WORDS, figuresFromJson, figuresOf, figuresProblems, type Comparison, type FiguresRefusal, type OurBooks, type TheirFigures } from '@nexus/factory-domain/receivables-figures/figures'
import { RECEIVABLES_THEIR_FIGURES_MANAGE } from '@nexus/factory-domain/receivables-figures/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertMay, mayOn, officeContextOf, peopleOf, receivablesCommand, today, type Reader } from '../store'
import { ourBooks } from './ours'

/**
 * A B2B customer's own figures against ours (B-W2b-406; FIN-135 "Reconcile with the customer's own figures"; design
 * finance.bank sec:customer-figures; factory-db bank.prisma CustomerStatementFigures). A person types what the customer's
 * statement says as of a day — per order, its payments, its balance — and the comparison with our books, as of the same day
 * and in the same currency, says every difference (factory-domain receivables-figures/figures). Office only; can() on the
 * company AND the customer; every amount is a price (money.price):
 *
 *   GET   /receivables/their-figures?companyId&partyId     receivables.view: the newest figures, each with our balance then
 *                                                          and how many lines differ
 *   GET   /receivables/their-figures/:figuresId            receivables.view: one, with the whole comparison
 *   POST  /receivables/their-figures                       theirFigures.manage: recorded (with the statement's file, when
 *                                                          kept: a file announced for these figures, record type
 *                                                          CustomerStatementFigures, whose record id becomes theirs)
 *   PATCH /receivables/their-figures/:figuresId            theirFigures.manage: a typing mistake corrected at the version
 *                                                          read (never deleted; the company and the customer never change)
 *
 * Each write is ONE command (audit with the figures marked price, event customer_figures.changed). Refusals: 400 at the
 * field (`body/…`), 409 `figures/<CODE>` in words; the database's own guard, if a write ever reaches it, a 409 too.
 */

const COLUMNS = { id: true, companyId: true, partyId: true, asOf: true, currency: true, figures: true, fileId: true, note: true, version: true, createdAt: true, updatedAt: true, createdById: true } as const satisfies Prisma.CustomerStatementFiguresSelect
type FiguresRow = Prisma.CustomerStatementFiguresGetPayload<{ select: typeof COLUMNS }>

const FIGURES_RECORD = 'CustomerStatementFigures'
const day = (value: Date): BusinessDate => businessDate(value, 'UTC')
const refused = (code: FiguresRefusal, path = `figures/${code}`): DomainError => new DomainError('conflict', FIGURES_REFUSAL_WORDS[code], [{ path, message: FIGURES_REFUSAL_WORDS[code] }])

/** The database's own refusal of these figures (its guard: check_violation 'receivables: the customer''s figures …'), as a 409. */
function databaseRefusal(error: unknown): DomainError | null {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string') return null
  if (!/^receivables: (the customer's figures|the file of the customer's figures|the company, customer and creation of the customer's figures)/.test(cause.originalMessage)) return null
  return refused('REFUSED')
}

const comparisonView = (comparison: Comparison) => ({
  balance: { theirs: asMoney('price', comparison.balance.theirs), ours: asMoney('price', comparison.balance.ours), difference: asMoney('price', comparison.balance.difference), state: comparison.balance.state },
  orders: comparison.orders.map((line) => ({
    index: line.index,
    reference: line.theirs?.reference ?? null,
    theirs: asMoney('price', line.theirs?.amount ?? 0),
    ours: line.ours ? { kind: line.ours.kind, id: line.ours.id, number: line.ours.number, invoices: line.ours.invoices.map((invoice) => ({ id: invoice.id, number: invoice.number, open: asMoney('price', invoice.open) })), open: asMoney('price', line.ours.open) } : null,
    state: line.state,
    difference: asMoney('price', line.difference),
  })),
  payments: comparison.payments.map((line) => ({
    index: line.index,
    reference: line.theirs?.reference ?? null,
    date: line.theirs?.date ?? null,
    theirs: asMoney('price', line.theirs?.amount ?? 0),
    ours: line.ours ? { id: line.ours.id, reference: line.ours.reference, receivedOn: line.ours.receivedOn, amount: asMoney('price', line.ours.amount) } : null,
    foundBy: line.foundBy,
    state: line.state,
    difference: asMoney('price', line.difference),
  })),
  paymentsFrom: comparison.paymentsFrom,
  differences: comparison.differences,
})

/** The rows as the screens read them, each compared with our books (read once per customer, day and currency). */
async function viewsOf(db: Reader, context: OfficeContext, rows: readonly FiguresRow[]) {
  if (rows.length === 0) return []
  const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.companyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  const fileIds = rows.flatMap((row) => (row.fileId ? [row.fileId] : []))
  const files = new Map(fileIds.length === 0 ? [] : (await db.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, originalName: true } })).map((row) => [row.id, row.originalName]))
  const people = await peopleOf(db, rows.map((row) => row.createdById))
  const books = new Map<string, OurBooks>()
  const views = []
  // One at a time: a transaction client runs one statement at a time.
  for (const row of rows) {
    const asOf = day(row.asOf)
    const key = `${row.companyId}|${row.partyId}|${asOf}|${row.currency}`
    if (!books.has(key)) books.set(key, await ourBooks(db, { companyId: row.companyId, partyId: row.partyId }, asOf, row.currency))
    const theirs = figuresFromJson(row.figures)
    const comparison = compareFigures(theirs, books.get(key)!)
    views.push({
      figures: {
        id: row.id,
        company: { id: row.companyId, code: companies.get(row.companyId)?.code ?? '', name: companies.get(row.companyId)?.legalName ?? '' },
        customer: { id: row.partyId, code: parties.get(row.partyId)?.code ?? '', name: parties.get(row.partyId)?.legalName ?? '' },
        asOf,
        currency: row.currency,
        theirs: { orders: theirs.orders.length, payments: theirs.payments.length, balance: asMoney('price', theirs.balance) },
        summary: { ours: asMoney('price', comparison.balance.ours), difference: asMoney('price', comparison.balance.difference), differences: comparison.differences, state: comparison.differences === 0 ? ('AGREES' as const) : ('DIFFERS' as const) },
        file: row.fileId ? { id: row.fileId, name: files.get(row.fileId) ?? '' } : null,
        note: row.note,
        createdAt: toUtcIso(row.createdAt),
        createdBy: row.createdById ? { id: row.createdById, name: people.get(row.createdById) ?? null } : null,
        updatedAt: toUtcIso(row.updatedAt),
        can: { correct: mayOn(context, RECEIVABLES_THEIR_FIGURES_MANAGE, row) },
        version: row.version,
      },
      comparison: comparisonView(comparison),
    })
  }
  return views
}

/** GET /receivables/their-figures (receivables.view): the newest first. */
export async function listFigures(caller: CommandCaller, query: { readonly companyId: string; readonly partyId?: string | undefined; readonly limit: number }) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), RECEIVABLES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.CustomerStatementFiguresWhereInput
  return caller.withClient(async (db) => {
    const rows = await db.customerStatementFigures.findMany({
      where: { AND: [scope, { companyId: query.companyId }, query.partyId ? { partyId: query.partyId } : {}] },
      orderBy: [{ asOf: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      select: COLUMNS,
    })
    return { companyId: query.companyId, figures: (await viewsOf(db, context, rows)).map((view) => view.figures) }
  })
}

async function peek(caller: CommandCaller, figuresId: string): Promise<FiguresRow | null> {
  return isUuid(figuresId) ? caller.withClient((db) => db.customerStatementFigures.findUnique({ where: { id: figuresId }, select: COLUMNS })) : null
}

/** GET /receivables/their-figures/:figuresId (receivables.view): with the whole comparison. */
export async function getFigures(caller: CommandCaller, figuresId: string) {
  const context = officeContextOf(caller)
  const row = await peek(caller, figuresId)
  assertMay(context, RECEIVABLES_VIEW, RECEIVABLES_VIEW, row, 'Figures')
  return caller.withClient(async (db) => (await viewsOf(db, context, [row!]))[0]!)
}

type FiguresInput = NonNullable<CorrectFiguresBody['figures']>

/** The typed figures with every amount there (a marked amount is optional in the contract), or the paths that lack one. */
function typedFigures(input: FiguresInput): TheirFigures {
  const issues: Issue[] = []
  const amount = (value: number | undefined, path: string): number => {
    if (value === undefined) issues.push({ path, message: FIGURES_REFUSAL_WORDS.AMOUNT_NEEDED })
    return value ?? 0
  }
  const figures: TheirFigures = {
    orders: input.orders.map((entry, index) => ({ reference: entry.reference, amount: amount(entry.amount, `body/figures/orders/${index}/amount`) })),
    payments: input.payments.map((entry, index) => ({ reference: entry.reference, date: entry.date, amount: amount(entry.amount, `body/figures/payments/${index}/amount`) })),
    balance: amount(input.balance, 'body/figures/balance'),
  }
  if (issues.length > 0) throw new ValidationError(FIGURES_REFUSAL_WORDS.AMOUNT_NEEDED, issues)
  return figuresOf(figures)
}

function checked(input: { asOf: BusinessDate; figures: TheirFigures; note: string | null }): void {
  const problems = figuresProblems(input, today())
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
}

const noteOf = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

const audited = (row: { asOf: BusinessDate; currency: string; figures: TheirFigures; note: string | null; fileId: string | null }) => ({
  asOf: row.asOf,
  currency: row.currency,
  orders: row.figures.orders.length,
  payments: row.figures.payments.length,
  figures: markMoney('price', row.figures),
  note: row.note,
  fileId: row.fileId,
})

async function oneView(tools: Pick<CommandTools, 'tx' | 'context'>, figuresId: string) {
  const row = (await tools.tx.customerStatementFigures.findUnique({ where: { id: figuresId }, select: COLUMNS }))!
  return (await viewsOf(tools.tx, tools.context as OfficeContext, [row]))[0]!
}

/** POST /receivables/their-figures (theirFigures.manage): a customer's figures as of a day, compared at once. */
export async function recordFigures(caller: CommandCaller, body: RecordFiguresBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const scope = { companyId: body.companyId, partyId: body.partyId }
  const found = await caller.withClient(async (db) => ({
    company: await db.company.findUnique({ where: { id: body.companyId }, select: { id: true, currency: true } }),
    party: await db.party.findUnique({ where: { id: body.partyId }, select: { id: true, roles: true } }),
    file: body.fileId ? await db.storedFile.findUnique({ where: { id: body.fileId }, select: { id: true, companyId: true, recordType: true, recordId: true, status: true } }) : null,
  }))
  assertMay(context, RECEIVABLES_VIEW, RECEIVABLES_THEIR_FIGURES_MANAGE, found.company && found.party ? scope : null)
  if (!found.party!.roles.includes('CUSTOMER')) throw refused('NOT_A_CUSTOMER', 'body/partyId')
  const figures = typedFigures(body.figures)
  const note = noteOf(body.note)
  checked({ asOf: body.asOf, figures, note })
  let id = newId()
  if (body.fileId) {
    const file = found.file
    if (!file || file.companyId !== body.companyId || file.recordType !== FIGURES_RECORD) throw refused('NOT_A_FIGURES_FILE', 'body/fileId')
    if (file.status !== 'AVAILABLE') throw refused('FILE_NOT_READY', 'body/fileId')
    if (!isUuid(file.recordId)) throw refused('NOT_A_FIGURES_FILE', 'body/fileId')
    id = file.recordId
  }
  const currency = body.currency ?? found.company!.currency
  try {
    const { result } = await receivablesCommand(caller, { name: 'receivables.figuresRecord', idempotencyKey, input: body }, async (tools) => {
      if (body.fileId && (await tools.tx.customerStatementFigures.findUnique({ where: { id }, select: { id: true } }))) throw refused('FILE_USED', 'body/fileId')
      await tools.tx.customerStatementFigures.create({
        data: { id, companyId: body.companyId, partyId: body.partyId, asOf: new Date(`${body.asOf}T00:00:00.000Z`), currency, figures: figures as unknown as Prisma.InputJsonValue, fileId: body.fileId ?? null, note, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId },
        select: { id: true },
      })
      tools.audit({ action: 'receivables.figuresRecord', recordType: FIGURES_RECORD, recordId: id, companyId: body.companyId, after: { partyId: body.partyId, ...audited({ asOf: body.asOf, currency, figures, note, fileId: body.fileId ?? null }) } })
      tools.emit({ type: 'customer_figures.changed', subject: id, companyId: body.companyId, payload: { figuresId: id, partyId: body.partyId, asOf: body.asOf, action: 'RECORDED', orders: figures.orders.length, payments: figures.payments.length, fileKept: body.fileId != null } })
      return oneView(tools, id)
    })
    return result
  } catch (error) {
    throw databaseRefusal(error) ?? error
  }
}

/** PATCH /receivables/their-figures/:figuresId (theirFigures.manage): a typing mistake corrected at the version read. */
export async function correctFigures(caller: CommandCaller, figuresId: string, body: CorrectFiguresBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const row = await peek(caller, figuresId)
  assertMay(context, RECEIVABLES_VIEW, RECEIVABLES_THEIR_FIGURES_MANAGE, row, 'Figures')
  const before = { asOf: day(row!.asOf), figures: figuresFromJson(row!.figures), note: row!.note }
  const after = { asOf: body.asOf ?? before.asOf, figures: body.figures ? typedFigures(body.figures) : before.figures, note: body.note === undefined ? before.note : noteOf(body.note) }
  checked(after)
  try {
    const { result } = await receivablesCommand(caller, { name: 'receivables.figuresCorrect', idempotencyKey, input: { figuresId, ...body } }, async (tools) => {
      await tools.tx.$queryRaw`SELECT id FROM "CustomerStatementFigures" WHERE id = ${figuresId}::uuid FOR UPDATE`
      const current = await tools.tx.customerStatementFigures.findUnique({ where: { id: figuresId }, select: COLUMNS })
      if (!current) throw new NotFoundError('Figures not found.')
      if (current.version !== body.version) throw new DomainError('conflict', `These figures changed since they were read (version ${body.version}); they are now at version ${current.version}. Read them again.`, [{ path: 'body/version', message: `The current version is ${current.version}.` }])
      await tools.tx.customerStatementFigures.update({
        where: { id: figuresId },
        data: { asOf: new Date(`${after.asOf}T00:00:00.000Z`), figures: after.figures as unknown as Prisma.InputJsonValue, note: after.note, version: current.version + 1, updatedAt: tools.now },
        select: { id: true },
      })
      tools.audit({
        action: 'receivables.figuresCorrect',
        recordType: FIGURES_RECORD,
        recordId: figuresId,
        companyId: current.companyId,
        before: audited({ ...before, currency: current.currency, fileId: current.fileId }),
        after: audited({ ...after, currency: current.currency, fileId: current.fileId }),
      })
      tools.emit({ type: 'customer_figures.changed', subject: figuresId, companyId: current.companyId, payload: { figuresId, partyId: current.partyId, asOf: after.asOf, action: 'CORRECTED', orders: after.figures.orders.length, payments: after.figures.payments.length, fileKept: current.fileId !== null } })
      return oneView(tools, figuresId)
    })
    return result
  } catch (error) {
    throw databaseRefusal(error) ?? error
  }
}
