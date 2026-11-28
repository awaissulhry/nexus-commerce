import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { MAX_BLOCK_SIZE } from '@nexus/factory-domain/numbering/blocks'
import { basketsAtPrint, MAX_BASKETS_AT_PRINT } from '@nexus/factory-domain/production/baskets/at-print'
import { shareBasketsAtPrint } from '@nexus/factory-domain/production/order-teams/at-print'
import { MATERIAL_REASON_WORDS, PRINT_REFUSED_WORDS, printProblems, type WorkOrderChecks } from '@nexus/factory-domain/production/print-start/checks'
import { notConfirmedWords, printedAlreadyWords, PRINT_START_ORDER_STATUSES } from '@nexus/factory-domain/production/print-start/prints'
import { beforeRelease } from '@nexus/factory-domain/production/work-orders/bulk'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { allocateScanIds } from '../../../platform/numbering/scan-ids'
import { withGateRecords } from '../../compliance/gates/gate'
import { withCreditHolds } from '../../sales/credit/check'
import { stampOrderPictureForFloor } from '../../sales/orders/floor-picture'
import { checklistOf, readBasics, readReleaseFacts } from '../work-orders/facts'
import { releaseInCommand } from '../work-orders/release'
import { readWorkOrder } from '../work-orders/store'
import { createWorkOrderInCommand, todayOfCommand, type ChangeWorkOrderSource } from '../work-orders/work-orders'
import { basketsAtPrintBySite, designFilesOf, draftGroupsOf, goodsLinesOf, orderNow, printOrder, printsOf, workOrdersOf } from './store'

/**
 * POST /production/orders/:orderId/print-and-start (production.print.start; owb- order workflow, S3 ss2 step 2.2; settles L1, L6,
 * L7, L8; plan.md § 5 A, D, G, H). ONE command on the order (its version bump locks it), all or nothing — a refusal rolls back the
 * work orders and the baskets (withCreditHolds / withGateRecords still write their records after the rollback):
 *
 *   1. refused unless the order is CONFIRMED or IN_PRODUCTION and has no FIRST print ("Printed on … — use Print again…")
 *   2. the OrderPrint FIRST row, FIRST (its pages: each goods line's design page; its cards stay empty — the baskets come after it
 *      in this command, and the FIRST print prints every one of them: print numbers are 1 + the AGAIN rows naming a page or card)
 *   3. the missing DRAFTs, as "Make work orders…" makes them (one per style × site × revision × customer), for the person who prints
 *      (createWorkOrderInCommand, right 'PRINT'); lines with no site where the company has several plants: refused in words
 *   4. today's release checks of every DRAFT, listed at once: law, money, structure, hold refuse (409, each problem an issue
 *      `problem/<CODE>`); a material shortage goes on only with `materialReason` (today's materialOverride.reason)
 *   5. each DRAFT released (releaseInCommand: today's release, moved not changed — its credit gate and compliance gate included)
 *   6. the order picture shared with the floor of each site it released on (stampOrderPictureForFloor: else the floor never sees it)
 *   7. where the site makes baskets at print (ProductionSettings.basketsAtPrint): the baskets of the work orders released here
 *      (basketsAtPrint: one garment a basket, small parts one a cell), `madeAtPrint` true, no cut log entry, the codes from the
 *      tenant's BUNDLE counter in blocks of ≤ 1000 — and NO production.bundle_created (the brand keeper reads it as CUTTING; the
 *      bench's attach emits it when the cuts go on). Elsewhere no basket: the cards say "Basket cards print at cutting on this site".
 *   8. the open OrderTeam rows that split the work take their baskets (shareBasketsAtPrint), in line order
 *   9. ONE audit row on the SalesOrder, the event production.order_print_started (ids only)
 * The order moves to IN_PRODUCTION later, as today (the handler sales.ordersFollowWorkOrders on workorder.released).
 */

export interface PrintAndStartInput {
  readonly version?: number | undefined
  /** Why the work starts with a material short (asked when the checks found a shortage). */
  readonly materialReason?: string | undefined
}

/** A refusal of the print in words (409): its code as `refusal/<CODE>`, or every problem as `problem/<CODE>`. */
function refusedPrint(code: string, words: string): never {
  throw new DomainError('conflict', words, [{ path: `refusal/${code}`, message: words }])
}

/** createWorkOrderInCommand's `change`: the print has no change record to mark APPLIED (its id is never read). */
const NO_CHANGE: ChangeWorkOrderSource = { changeId: 'print-and-start', inCommand: async () => {} }

export async function printAndStart(caller: CommandCaller, orderId: string, body: PrintAndStartInput, idempotencyKey?: string) {
  const { order, context } = await printOrder(caller, orderId)
  const reason = body.materialReason?.trim() ? body.materialReason.trim() : null
  const { result } = await withCreditHolds(caller, idempotencyKey, () =>
    withGateRecords(caller, idempotencyKey, () =>
      command(caller, { name: 'production.printAndStart', idempotencyKey, input: { orderId, ...body }, record: { type: 'SalesOrder', id: order.id, expectedVersion: body.version } }, async (tools) => {
        const { tx } = tools
        const current = await orderNow(tx, order.id)
        // 1. Only a confirmed order, printed once.
        if (!PRINT_START_ORDER_STATUSES.includes(current.status)) refusedPrint('NOT_CONFIRMED', notConfirmedWords(current.status))
        const earlier = (await printsOf(tx, current.id)).find((row) => row.kind === 'FIRST')
        if (earlier) refusedPrint('PRINTED', printedAlreadyWords(businessDate(earlier.createdAt)))

        // 2. The FIRST print, first.
        const lines = await goodsLinesOf(tx, current.id)
        const lineIds = lines.map((line) => line.id)
        const seqOf = new Map(lines.map((line) => [line.id, line.seq]))
        const files = await designFilesOf(tx, lines)
        const printId = newId()
        await tx.orderPrint.create({
          data: { id: printId, companyId: current.companyId, partyId: current.partyId, salesOrderId: current.id, kind: 'FIRST', pages: lines.filter((line) => files.has(line.id)).map((line) => ({ salesOrderLineId: line.id, page: 1 })), cards: [], createdById: context.actorId },
          select: { id: true },
        })

        // 3. The missing DRAFTs, as "Make work orders…" makes them.
        const groups = await draftGroupsOf(tx, current, lines)
        const unsited = groups.find((group) => group.siteId === null)
        if (unsited) refusedPrint('SITE', `Choose the site in Make work orders… first: the lines of ${unsited.styleCode} name no site and the company has several plants.`)
        for (const group of groups) {
          await createWorkOrderInCommand(
            tools,
            context,
            { siteId: group.siteId!, ...(group.styleRevisionId ? { styleRevisionId: group.styleRevisionId } : {}), lines: group.lines.map((line) => ({ salesOrderLineId: line.salesOrderLineId, sizes: [...line.sizes] })) },
            NO_CHANGE,
            'PRINT',
          )
        }

        // 4. Today's release checks of every DRAFT, all problems at once.
        const drafts: { id: string; number: string; siteId: string }[] = []
        const checks: WorkOrderChecks[] = []
        for (const workOrder of await workOrdersOf(tx, lineIds)) {
          const header = (await readWorkOrder(tx, workOrder.id))!
          if (!beforeRelease(header)) continue
          const facts = await readReleaseFacts(tx, await readBasics(tx, header), todayOfCommand(tools))
          checks.push({ workOrderNumber: workOrder.number, checklist: checklistOf(facts, null) })
          drafts.push({ id: workOrder.id, number: workOrder.number, siteId: workOrder.siteId })
        }
        const answer = printProblems(checks)
        const issuesOf = (problems: typeof answer.problems): Issue[] => problems.map((problem) => ({ path: `problem/${problem.code}`, message: problem.workOrderNumber ? `${problem.workOrderNumber}: ${problem.words}` : problem.words }))
        if (answer.refused) throw new DomainError('conflict', PRINT_REFUSED_WORDS.en, issuesOf(answer.problems))
        if (answer.needsMaterialReason && reason === null) throw new DomainError('conflict', MATERIAL_REASON_WORDS.en, issuesOf(answer.problems))

        // 5. Each DRAFT released, today's release (a shortage passes with the reason).
        for (const draft of drafts) await releaseInCommand(tools, context, draft.id, reason ? { materialOverride: { reason } } : {}, { bumpVersion: true })

        // 6. The order picture for the floor of each site it released on.
        const sites = [...new Set(drafts.map((draft) => draft.siteId))]
        for (const siteId of sites) await stampOrderPictureForFloor(tools, { salesOrderId: current.id, siteId, reason: 'Print and start the work: the floor sees the order picture' })

        // 7. The baskets, where the site makes them at print.
        const switches = await basketsAtPrintBySite(tx, sites)
        const releasedHere = new Set(drafts.map((draft) => draft.id))
        const basketed = (await workOrdersOf(tx, lineIds)).filter((workOrder) => releasedHere.has(workOrder.id) && switches.get(workOrder.siteId))
        const made = await makeBasketsInCommand(tools, context, basketed, seqOf)

        // 8. The teams that split the order's work take their baskets, in line order.
        const teams = await tx.orderTeam.findMany({ where: { salesOrderId: current.id, endedAt: null }, select: { id: true, inCharge: true, basketShare: true, bundleIds: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
        const shares = shareBasketsAtPrint(teams.map((team) => ({ orderTeamId: team.id, inCharge: team.inCharge, basketShare: team.basketShare })), made.map((basket) => ({ bundleId: basket.id })))
        for (const team of teams) {
          const taken = shares.get(team.id)
          if (!taken || taken.length === 0) continue
          await tx.orderTeam.update({ where: { id: team.id }, data: { bundleIds: [...team.bundleIds, ...taken], version: { increment: 1 } }, select: { id: true } })
        }

        // 9. One audit row, one event.
        const workOrders = drafts.map((draft) => ({ id: draft.id, number: draft.number }))
        tools.audit({
          action: 'production.printAndStart',
          recordType: 'SalesOrder',
          recordId: current.id,
          companyId: current.companyId,
          after: { printId, workOrders, baskets: made.length, materialReason: reason, teams: Object.fromEntries([...shares].map(([teamId, ids]) => [teamId, ids.length])) },
          ...(reason ? { reason } : {}),
        })
        tools.emit({ type: 'production.order_print_started', subject: current.id, companyId: current.companyId, payload: { salesOrderId: current.id, printId, workOrderIds: workOrders.map((entry) => entry.id), baskets: made.length, partyId: current.partyId } })
        return { printId, orderId: current.id, workOrders, baskets: made.length, version: tools.record!.version }
      }),
    ),
  )
  return result
}

/**
 * Inside the print's command: the baskets of these work orders (just released, at sites that make baskets at print), in line order,
 * with codes from the tenant's BUNDLE counter (blocks of ≤ 1000). No production.bundle_created (see the module's head). The answer:
 * the baskets made, in line order.
 */
async function makeBasketsInCommand(
  tools: CommandTools,
  context: Parameters<typeof allocateScanIds>[0]['context'],
  workOrders: Awaited<ReturnType<typeof workOrdersOf>>,
  seqOf: ReadonlyMap<string, number>,
): Promise<{ id: string; workOrderId: string; workOrderSizeId: string; quantity: number }[]> {
  if (workOrders.length === 0) return []
  const { tx } = tools
  const active = await tx.bundle.groupBy({ by: ['workOrderSizeId'], where: { workOrderId: { in: workOrders.map((workOrder) => workOrder.id) }, status: 'ACTIVE' }, _count: { _all: true } })
  const activeOf = new Map(active.map((row) => [row.workOrderSizeId, row._count._all]))
  const plan = basketsAtPrint({
    switchOn: true,
    workOrders: workOrders.map((workOrder) => ({
      workOrderId: workOrder.id,
      status: workOrder.status as 'RELEASED',
      kind: workOrder.kind as 'SIZE_GRID',
      smallParts: workOrder.smallParts,
      cells: workOrder.cells.map((cell) => ({ workOrderSizeId: cell.id, quantity: cell.quantity, activeBundles: activeOf.get(cell.id) ?? 0 })),
    })),
  })
  if (!plan.ok) {
    const words =
      plan.refusal.code === 'TOO_MANY'
        ? `This print would make ${plan.refusal.count} baskets; one print makes at most ${MAX_BASKETS_AT_PRINT}. Make the work orders in parts (Make work orders…).`
        : plan.refusal.code === 'ALREADY_MADE'
          ? 'A cell of these work orders has baskets already: use Print again… to print their cards.'
          : 'A work order of this order is not released: the baskets are made once it is.'
    refusedPrint(`BASKETS_${plan.refusal.code}`, words)
  }
  // In line order: the order's line seq, then the work order's cell order (basketsAtPrint keeps work order and cell order).
  const siteOf = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder.siteId]))
  const lineOfCell = new Map(workOrders.flatMap((workOrder) => workOrder.cells.map((cell) => [cell.id, cell.salesOrderLineId] as const)))
  const baskets = plan.baskets.map((basket, index) => ({ ...basket, index })).sort((a, b) => (seqOf.get(lineOfCell.get(a.workOrderSizeId) ?? '') ?? 0) - (seqOf.get(lineOfCell.get(b.workOrderSizeId) ?? '') ?? 0) || a.index - b.index)
  const codes: string[] = []
  for (let start = 0; start < baskets.length; start += MAX_BLOCK_SIZE) {
    const count = Math.min(MAX_BLOCK_SIZE, baskets.length - start)
    codes.push(...(await allocateScanIds({ tx, context, now: tools.now }, 'BUNDLE', count)).codes)
  }
  const createdById = context.audience === 'office' ? context.actorId : null
  const rows = baskets.map((basket, index) => ({
    id: newId(),
    siteId: siteOf.get(basket.workOrderId)!,
    workOrderId: basket.workOrderId,
    workOrderSizeId: basket.workOrderSizeId,
    code: codes[index]!,
    quantity: basket.quantity,
    madeAtPrint: true,
    createdAt: tools.now,
    updatedAt: tools.now,
    createdById,
  }))
  await tx.bundle.createMany({ data: rows })
  return rows.map((row) => ({ id: row.id, workOrderId: row.workOrderId, workOrderSizeId: row.workOrderSizeId, quantity: row.quantity }))
}
