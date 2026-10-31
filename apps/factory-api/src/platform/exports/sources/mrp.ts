import { businessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { decimalText, type ExportLocale } from '@nexus/factory-domain/views/exports'
import { listLocations } from '../../../modules/inventory/locations/locations'
import { officeContextOf } from '../../../modules/planning/access'
import type { LineView } from '../../../modules/planning/contract'
import { shortages } from '../../../modules/planning/readiness/readiness'
import { latestPlan } from '../../../modules/planning/requirements'
import { defineExportSource } from '../source'

/**
 * Planning › What to buy & make (SCR-055, `/planning/mrp`): the export of the list as the screen shows it. The page
 * draws ONE list frame at a time, so both of its lists are this list key:
 *   - the plan's lines (every view but Short on open work orders): the site's latest DONE plan through planning's own
 *     latestPlan (planning.view over the site), filtered and ordered as the screen does (apps/factory-web areas/planning/
 *     mrp model.ts inView, matches, sortLines);
 *   - `?view=shortWo`: Short on open work orders, through planning's own shortages read, searched as the screen does.
 * The address is the screen's (PlanPage.tsx): `?site=` (a site of the screen's company that has a location the person
 * sees, else the first by code, as the screen picks it from GET /inventory/locations), `?view=open|toBuy|late|make|held|
 * inDraft|ordered|setAside|leather|all|shortWo` (default open), `?q=`. Not paged: the whole plan of the site. The
 * expected value is the cost grain (absent from the file without it); the shortage list has no money.
 */

const PLAN_VIEWS = ['open', 'toBuy', 'late', 'make', 'held', 'inDraft', 'ordered', 'setAside', 'leather', 'all', 'shortWo'] as const
type PlanView = (typeof PLAN_VIEWS)[number]
const viewOf = (value: string | null): PlanView => ((PLAN_VIEWS as readonly string[]).includes(value ?? '') ? (value as PlanView) : 'open')

type Shortage = Awaited<ReturnType<typeof shortages>>['rows'][number]
type Row = { readonly kind: 'line'; readonly line: LineView; readonly locale: ExportLocale } | { readonly kind: 'short'; readonly short: Shortage; readonly locale: ExportLocale }

interface Query {
  readonly site: string | null
  readonly view: PlanView
  readonly q: string
}

const decimalValue = (value: string | null | undefined): number => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}
const isShort = (line: LineView) => decimalValue(line.netQuantity) > 0

/** Whether a line belongs to a view (the screen's inView). */
function inView(line: LineView, view: PlanView): boolean {
  switch (view) {
    case 'open':
      return line.decision === 'OPEN' && isShort(line)
    case 'toBuy':
      return line.decision === 'OPEN' && isShort(line) && line.action === 'BUY'
    case 'late':
      return line.decision === 'OPEN' && isShort(line) && line.action === 'BUY' && !!line.orderBy?.passed
    case 'make':
      return line.decision === 'OPEN' && isShort(line) && line.action === 'MAKE'
    case 'held':
      return isShort(line) && decimalValue(line.heldStock) > 0
    case 'inDraft':
      return line.decision === 'ORDERED' && line.purchaseOrder?.status === 'DRAFT'
    case 'ordered':
      return line.decision === 'ORDERED'
    case 'setAside':
      return line.decision === 'IGNORED'
    case 'leather':
      return line.item.kind === 'LEATHER'
    case 'all':
      return true
    case 'shortWo':
      return false
  }
}

/** The screen's search over the material, its colour, the supplier and the orders behind a line. */
function matches(line: LineView, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [line.item.code, line.item.name, line.colour?.code, line.colour?.name, line.supplier?.name, line.supplier?.code, ...line.orders.map((order) => order.number), line.purchaseOrder?.number]
    .filter((text): text is string => !!text)
    .some((text) => text.toLowerCase().includes(needle))
}

/** The screen's order: by supplier (no supplier last), then the order-by day, the need day, the run's own order. */
function sortLines(lines: readonly LineView[]): LineView[] {
  return [...lines].sort((a, b) => {
    const sa = a.supplier?.name ?? '￿'
    const sb = b.supplier?.name ?? '￿'
    if (sa !== sb) return sa.localeCompare(sb)
    const oa = a.orderBy?.date ?? a.needDate
    const ob = b.orderBy?.date ?? b.needDate
    if (oa !== ob) return oa.localeCompare(ob)
    return a.seq - b.seq
  })
}

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
const plural = (key: string, count: number): string => `${key}_${count === 1 ? 'one' : 'other'}`
const qty = (value: string, locale: ExportLocale): string => decimalText(value, locale)

export const mrp = defineExportSource<Query, Row>({
  listKey: 'planning.mrp',
  permission: PLANNING_VIEW,
  query(address) {
    return { site: address.get('site') || null, view: viewOf(address.get('view')), q: address.get('q')?.trim().slice(0, 100) ?? '' }
  },
  async read(caller, query, _cursor, _limit, options) {
    const locale: ExportLocale = options?.locale ?? 'it'
    const context = officeContextOf(caller)
    // The screen's sites: those of its company with a location the person sees, by code; the asked one, else the first.
    const sites = (await listLocations(caller, {})).sites.filter((site) => !context.companyId || site.companyId === context.companyId)
    const siteId = sites.find((site) => site.id === query.site)?.id ?? sites[0]?.id ?? null
    if (!siteId) return { rows: [], next: null }
    if (query.view === 'shortWo') {
      const answer = await shortages(caller, { siteId })
      const q = query.q.toLowerCase()
      const rows = answer.rows.filter((row) => !q || [row.workOrder.number, row.workOrder.style.code, row.workOrder.style.name, row.material.label, row.expected?.purchaseOrderNumber].some((text) => !!text && text.toLowerCase().includes(q)))
      return { rows: rows.map((short) => ({ kind: 'short' as const, short, locale })), next: null }
    }
    const plan = await latestPlan(caller, { siteId })
    const all: readonly LineView[] = plan.lines
    const lines = sortLines(all.filter((line) => inView(line, query.view) && matches(line, query.q)))
    return { rows: lines.map((line) => ({ kind: 'line' as const, line, locale })), next: null }
  },
  columns: {
    // The plan's lines.
    material: {
      value: (row, words) => {
        if (row.kind === 'short') return `${row.short.material.label} · ${words(`short.word.${row.short.word}`)}`
        const { line } = row
        const sub = [words(`plan.action.${line.action}`), line.colour ? `${line.colour.code} ${line.colour.name}` : null, line.item.requiresCrViTest ? words('plan.crVi') : null].filter((part): part is string => !!part)
        return [`${line.item.code} · ${line.item.name}`, ...sub].join(' · ')
      },
    },
    why: {
      value: (row, words) => {
        if (row.kind !== 'line') return null
        const { line, locale } = row
        return fill(words('plan.whyShort'), { gross: qty(line.grossQuantity, locale), usable: qty(line.usableStock, locale), onOrder: qty(line.onOrder, locale), net: qty(line.netQuantity, locale), unit: words(`uom.${line.uom}`) })
      },
    },
    dates: {
      value: (row, words) => {
        if (row.kind === 'short') {
          const { workOrder } = row.short
          const started = workOrder.startedAt ? fill(words('short.started'), { date: businessDate(new Date(workOrder.startedAt)) }) : words('short.notStarted')
          const due = workOrder.dueDate ? fill(words('short.due'), { date: workOrder.dueDate }) : words('short.noDue')
          return `${started} · ${due}`
        }
        const { line } = row
        const orderBy = line.orderBy
          ? line.orderBy.leadTimeDays === null
            ? fill(words('plan.orderByNoLead'), { date: line.orderBy.date })
            : fill(words(plural('plan.orderBy', line.orderBy.leadTimeDays)), { date: line.orderBy.date, count: line.orderBy.leadTimeDays })
          : words('plan.made')
        return `${line.needDate} · ${orderBy}`
      },
    },
    buy: {
      value: (row, words) => {
        if (row.kind !== 'line') return null
        const { line, locale } = row
        const main = `${qty(line.suggestedQuantity, locale)} ${words(`uom.${line.suggestedUom}`)}`
        if (line.estimatedHides !== null && line.suggestedUom !== 'HIDE') return `${main} · ${fill(words(plural('plan.hides', line.estimatedHides)), { count: line.estimatedHides })}`
        return main
      },
    },
    supplier: {
      value: (row, words) => {
        if (row.kind !== 'line') return null
        const { line } = row
        const who = line.supplier ? line.supplier.name : words(line.action === 'BUY' ? 'plan.noSupplier' : 'plan.made')
        return line.orders.length > 0 ? `${who} · ${fill(words('plan.forOrders'), { orders: line.orders.map((order) => order.number).join(', ') })}` : who
      },
    },
    value: {
      grain: 'cost',
      value: (row) => (row.kind === 'line' && row.line.expectedAmount !== undefined && row.line.expectedAmount !== null ? { minor: Number(row.line.expectedAmount), currency: row.line.currency } : null),
    },
    decision: {
      value: (row, words) => {
        if (row.kind !== 'line') return null
        const { line } = row
        if (line.decision === 'IGNORED') return words(`decision.setAside.${line.decisionReason ?? 'OTHER'}`)
        if (line.decision === 'ORDERED') {
          if (!line.purchaseOrder) return words('decision.orderedUnknown')
          if (line.purchaseOrder.status === 'DRAFT') return fill(words('decision.inDraft'), { number: line.purchaseOrder.number })
          return fill(words('decision.ordered'), { number: line.purchaseOrder.number, status: words(`poStatus.${line.purchaseOrder.status}`) })
        }
        return words(line.action === 'MAKE' ? 'decision.toMake' : 'decision.open')
      },
    },
    // Short on open work orders (`?view=shortWo`); `material` and `dates` above answer both lists.
    workOrder: { value: (row) => (row.kind === 'short' ? `${row.short.workOrder.number} · ${row.short.workOrder.style.code} · ${row.short.workOrder.style.name}` : null) },
    short: {
      value: (row, words) => {
        if (row.kind !== 'short') return null
        const { short, locale } = row
        return `${qty(short.short, locale)} ${words(`uom.${short.material.uom}`)} · ${fill(words('short.neededBy'), { date: short.neededBy })}`
      },
    },
    expected: {
      value: (row, words) => {
        if (row.kind !== 'short') return null
        const { expected } = row.short
        return expected ? `${expected.purchaseOrderNumber} · ${fill(words('short.arrives'), { date: expected.date })}` : words('short.nothingOnOrder')
      },
    },
    fix: {
      value: (row, words) => {
        if (row.kind !== 'short') return null
        const { fixes } = row.short
        if (fixes.length === 0) return words('short.noFix')
        return fixes
          .map((fix) => (fix.kind === 'EXPEDITE' && fix.purchaseOrder ? fill(words('short.fix.EXPEDITE'), { number: fix.purchaseOrder.number }) : fix.kind === 'BUY' ? words('short.fix.BUY') : fix.kind === 'MOVE_FIRM' ? words('short.fix.MOVE_FIRM') : null))
          .filter((text): text is string => text !== null)
          .join(' · ')
      },
    },
  },
  words: {
    it: {
      'plan.action.BUY': 'Compra',
      'plan.action.MAKE': 'Produci',
      'plan.crVi': 'test cromo VI',
      'plan.whyShort': '{gross} − {usable} − {onOrder} = {net} {unit}',
      'plan.orderBy_one': 'ordina entro il {date} · {count} giorno di consegna',
      'plan.orderBy_other': 'ordina entro il {date} · {count} giorni di consegna',
      'plan.orderByNoLead': 'ordina entro il {date} · tempi di consegna non registrati',
      'plan.made': 'Prodotto internamente',
      'plan.hides_one': '≈ {count} pelle',
      'plan.hides_other': '≈ {count} pelli',
      'plan.noSupplier': 'Nessun fornitore registrato',
      'plan.forOrders': 'per {orders}',
      'decision.open': 'Aperta',
      'decision.toMake': 'Da produrre',
      'decision.inDraft': 'In bozza {number}',
      'decision.ordered': 'Ordinata {number} ({status})',
      'decision.orderedUnknown': 'Ordinata',
      'decision.setAside.CUSTOMER_SUPPLIES': 'Messa da parte: la fornisce il cliente',
      'decision.setAside.SUBSTITUTE': 'Messa da parte: si usa un sostituto',
      'decision.setAside.STOCK_NOT_IN_SYSTEM': 'Messa da parte: scorta non ancora a sistema',
      'decision.setAside.OTHER': 'Messa da parte',
      'poStatus.DRAFT': 'Bozza',
      'poStatus.SENT': 'Inviato',
      'poStatus.CHANGES_PROPOSED': 'Modifiche proposte',
      'poStatus.CONFIRMED': 'Confermato',
      'poStatus.DECLINED': 'Rifiutato',
      'poStatus.PARTLY_RECEIVED': 'Ricevuto in parte',
      'poStatus.RECEIVED': 'Ricevuto',
      'poStatus.CLOSED': 'Chiuso',
      'poStatus.CANCELLED': 'Annullato',
      'uom.PCS': 'pz',
      'uom.PAIR': 'paio',
      'uom.SET': 'set',
      'uom.M': 'm',
      'uom.CM': 'cm',
      'uom.MM': 'mm',
      'uom.M2': 'm²',
      'uom.DM2': 'dm²',
      'uom.FT2': 'ft²',
      'uom.KG': 'kg',
      'uom.G': 'g',
      'uom.L': 'l',
      'uom.HIDE': 'pelli',
      'uom.SIDE': 'mezze pelli',
      'uom.ROLL': 'rotoli',
      'uom.CONE': 'coni',
      'uom.BOX': 'scatole',
      'short.started': 'Iniziato il {date}',
      'short.notStarted': 'Non iniziato',
      'short.due': 'Consegna {date}',
      'short.noDue': 'Nessuna data di consegna',
      'short.word.NOT_ENOUGH': 'Non basta',
      'short.word.DELAYED': 'In ritardo',
      'short.neededBy': 'serve entro il {date}',
      'short.arrives': 'arriva il {date}, troppo tardi',
      'short.nothingOnOrder': 'Nulla in ordine',
      'short.noFix': 'Nessuna soluzione qui: vedi la riga nella pianificazione',
      'short.fix.BUY': 'Compra',
      'short.fix.EXPEDITE': 'Sollecita {number}',
      'short.fix.MOVE_FIRM': 'Sposta l’ordine fisso',
    },
    en: {
      'plan.action.BUY': 'Buy',
      'plan.action.MAKE': 'Make',
      'plan.crVi': 'chromium VI test',
      'plan.whyShort': '{gross} − {usable} − {onOrder} = {net} {unit}',
      'plan.orderBy_one': 'order by {date} · {count} day lead time',
      'plan.orderBy_other': 'order by {date} · {count} days lead time',
      'plan.orderByNoLead': 'order by {date} · no lead time on record',
      'plan.made': 'Made here',
      'plan.hides_one': '≈ {count} hide',
      'plan.hides_other': '≈ {count} hides',
      'plan.noSupplier': 'No supplier on record',
      'plan.forOrders': 'for {orders}',
      'decision.open': 'Open',
      'decision.toMake': 'To make',
      'decision.inDraft': 'In draft {number}',
      'decision.ordered': 'Ordered {number} ({status})',
      'decision.orderedUnknown': 'Ordered',
      'decision.setAside.CUSTOMER_SUPPLIES': 'Set aside: the customer supplies it',
      'decision.setAside.SUBSTITUTE': 'Set aside: a substitute is used',
      'decision.setAside.STOCK_NOT_IN_SYSTEM': 'Set aside: stock not in the system yet',
      'decision.setAside.OTHER': 'Set aside',
      'poStatus.DRAFT': 'Draft',
      'poStatus.SENT': 'Sent',
      'poStatus.CHANGES_PROPOSED': 'Changes proposed',
      'poStatus.CONFIRMED': 'Confirmed',
      'poStatus.DECLINED': 'Declined',
      'poStatus.PARTLY_RECEIVED': 'Partly received',
      'poStatus.RECEIVED': 'Received',
      'poStatus.CLOSED': 'Closed',
      'poStatus.CANCELLED': 'Cancelled',
      'uom.PCS': 'pcs',
      'uom.PAIR': 'pair',
      'uom.SET': 'set',
      'uom.M': 'm',
      'uom.CM': 'cm',
      'uom.MM': 'mm',
      'uom.M2': 'm²',
      'uom.DM2': 'dm²',
      'uom.FT2': 'ft²',
      'uom.KG': 'kg',
      'uom.G': 'g',
      'uom.L': 'l',
      'uom.HIDE': 'hides',
      'uom.SIDE': 'sides',
      'uom.ROLL': 'rolls',
      'uom.CONE': 'cones',
      'uom.BOX': 'boxes',
      'short.started': 'Started {date}',
      'short.notStarted': 'Not started',
      'short.due': 'Due {date}',
      'short.noDue': 'No due date',
      'short.word.NOT_ENOUGH': 'Not enough',
      'short.word.DELAYED': 'Delayed',
      'short.neededBy': 'needed by {date}',
      'short.arrives': 'arrives {date}, too late',
      'short.nothingOnOrder': 'Nothing on order',
      'short.noFix': 'No fix here yet: see the line in the plan',
      'short.fix.BUY': 'Buy',
      'short.fix.EXPEDITE': 'Expedite {number}',
      'short.fix.MOVE_FIRM': 'Move the firm order',
    },
  },
})
