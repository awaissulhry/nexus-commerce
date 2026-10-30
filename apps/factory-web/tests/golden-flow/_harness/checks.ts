import { expect, test } from '@playwright/test'
import pg from 'pg'
import type { Capture, Flow } from './flow'

/**
 * The end checks of the browser golden flow (PLAN §4.7), read from the run's own database (the stack's throwaway one,
 * as its owner: reads only) and from what every browser context asked the API:
 *
 *   audit     every write a screen made (a 2xx POST/PUT/PATCH/DELETE through the web's API proxy) left at least one
 *             AuditLog row with its request id; the few unsafe calls that write nothing are listed with their reason
 *   ledger    the stock ledger reconciles: no stock key below zero at any location; every move of the run that changes
 *             the site's stock value has exactly one valuation of the same quantity and sign; every hide of the run's
 *             receipts holds what came in less what went out
 *   numbers   DDT and invoice numbers have no gap: each fiscal series the run used gave exactly the numbers from its
 *             next value at the start to its next value now, each on a document of that number, and the series as a
 *             whole has no hole
 *   floor     no answer to a floor context carries a cost, margin or price field
 *   links     no answer to a supplier's link carries a price, cost, margin, amount or total; the customer's link answers
 *             carry no cost or margin, and the prices they carry are of the customer's own documents (every party named
 *             in them is the customer)
 *   worker    nothing waits in the outbox; no worker handler failed its last try
 */

type Json = Record<string, any>
const FISCAL_KINDS = ['DDT', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE']

/** Unsafe calls that write nothing by design (no command, so no audit row), each with its reason. */
const NOT_WRITES: readonly { readonly path: RegExp; readonly when?: (capture: Capture) => boolean; readonly why: string }[] = [
  { path: /^\/local-files\?/, why: 'the bytes of a presigned upload go to the local file store (the FAKE R2), not a command' },
  { path: /^\/auth\/office\/sign-out$/, why: 'signing out ends the session cookie' },
  { path: /^\/auth\/office\/sign-in$/, when: (capture) => (capture.body as Record<string, unknown> | undefined)?.status === 'totp_required', why: 'the password step of the sign-in asks for the code and writes nothing' },
  { path: /^\/shipping\/shipments\/[0-9a-f-]+\/ddt\/preview(\/pdf)?$/, why: 'the DDT as it would be (the SAMPLE draft): nothing stored, no number used' },
  { path: /^\/compliance\/certificates\/gate$/, why: 'a question to the certificate gate (the lapse check on a chosen day): it answers, it writes nothing' },
]
const notAWrite = (capture: Capture) => NOT_WRITES.some((rule) => rule.path.test(capture.path) && (!rule.when || rule.when(capture)))

async function query<T = Json>(flow: Flow, sql: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: flow.adminUrl })
  await client.connect()
  try {
    return (await client.query(sql, values)).rows as T[]
  } finally {
    await client.end()
  }
}

/** Every key path of a JSON value whose last key matches `pattern`. */
export function keyPaths(value: unknown, pattern: RegExp, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => keyPaths(item, pattern, `${at}[${index}]`))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Json).flatMap(([key, item]) => [...(pattern.test(key) ? [`${at}.${key}`] : []), ...keyPaths(item, pattern, `${at}.${key}`)])
}

/** Every party id a JSON value names (`partyId` fields and `party: { id }` objects). */
function partiesNamed(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(partiesNamed)
  if (!value || typeof value !== 'object') return []
  const entries = Object.entries(value as Json)
  return entries.flatMap(([key, item]) => [
    ...(key === 'partyId' && typeof item === 'string' ? [item] : []),
    ...(key === 'party' && item && typeof item === 'object' && typeof (item as Json).id === 'string' ? [(item as Json).id as string] : []),
    ...partiesNamed(item),
  ])
}

const describe = (capture: Capture) => `${capture.stage} ${capture.context}: ${capture.method} ${capture.path}`

export const endChecks = {
  /** Before the first stage: where each fiscal series stands. */
  async before(flow: Flow): Promise<void> {
    if (flow.state.numberingAtStart) return
    const series = await query(flow, `SELECT id, kind::text AS kind, code, "nextValue" AS next FROM "NumberSeries" WHERE kind::text = ANY($1)`, [FISCAL_KINDS])
    flow.state.numberingAtStart = Object.fromEntries(series.map((row) => [row.id, row.next]))
  },

  async after(flow: Flow): Promise<void> {
    await flow.settle()

    await test.step('audit: every write a screen made left its audit rows', async () => {
      const writes = flow.captures.filter((capture) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(capture.method) && capture.status >= 200 && capture.status < 300)
      const counted = writes.filter((capture) => !notAWrite(capture))
      const ids = counted.map((capture) => capture.requestId).filter((id): id is string => Boolean(id))
      const audited = new Set((await query<{ requestId: string }>(flow, 'SELECT DISTINCT "requestId" FROM "AuditLog" WHERE "requestId" = ANY($1)', [ids])).map((row) => row.requestId))
      // A repeat of a write (same Idempotency-Key) answers from the first one's receipt: its audit rows are the first's.
      const auditedKeys = new Set(counted.filter((capture) => capture.idempotencyKey && capture.requestId && audited.has(capture.requestId)).map((capture) => capture.idempotencyKey))
      const unaudited = counted.filter((capture) => !(capture.requestId && audited.has(capture.requestId)) && !(capture.idempotencyKey && auditedKeys.has(capture.idempotencyKey))).map(describe)
      test.info().annotations.push({ type: 'audit', description: `${counted.length} writes through the screens, ${counted.length - unaudited.length} audited; ${writes.length - counted.length} that write nothing by design (uploads to the file store, the sign-in’s password step, the DDT preview, the gate’s lapse check) not counted` })
      expect(writes.length, 'the screens made writes').toBeGreaterThan(0)
      expect(unaudited, 'writes without an audit row').toEqual([])
    })

    await test.step('ledger: the stock ledger reconciles', async () => {
      const negative = await query(
        flow,
        `WITH flows AS (
           SELECT "tenantId", "siteId", "toLocationId" AS location, "itemId", "itemColourId", "lotId", "hideId", "baseQuantity" AS q FROM "StockMove" WHERE "toLocationId" IS NOT NULL
           UNION ALL
           SELECT "tenantId", "siteId", "fromLocationId", "itemId", "itemColourId", "lotId", "hideId", -"baseQuantity" FROM "StockMove" WHERE "fromLocationId" IS NOT NULL)
         SELECT location, "itemId", "lotId", "hideId", sum(q)::text AS balance FROM flows GROUP BY 1, 2, 3, 4, "tenantId", "siteId", "itemColourId" HAVING sum(q) < 0`,
      )
      expect(negative, 'stock keys below zero').toEqual([])
      const moves = await query(
        flow,
        `SELECT m.id, m.reason::text AS reason, m."baseQuantity"::text AS quantity, (m."toLocationId" IS NOT NULL) AS inward,
                count(v.id)::int AS valuations, coalesce(sum(v.quantity), 0)::text AS valued
           FROM "StockMove" m LEFT JOIN "StockValuation" v ON v."moveId" = m.id AND v."tenantId" = m."tenantId"
          WHERE m."createdAt" >= $1 AND m."createdAt" <= now() AND ((m."fromLocationId" IS NULL) <> (m."toLocationId" IS NULL))
          GROUP BY m.id`,
        // The run's: made since the flow began and not after now (the base seed dates its own story ahead).
        [flow.startedAt],
      )
      const unvalued = moves.filter((move) => move.valuations !== 1 || Math.abs(Number(move.valued)) !== Number(move.quantity) || Math.sign(Number(move.valued)) !== (move.inward ? 1 : -1))
      expect(moves.length, 'the run moved stock').toBeGreaterThan(0)
      expect(unvalued.map((move) => `${move.reason} ${move.id}: ${move.valuations} valuation(s), ${move.valued} for ${move.inward ? '+' : '-'}${move.quantity}`), 'moves without their one valuation').toEqual([])
      const hides = await query(
        flow,
        `SELECT h.code, h.state::text AS state, h.area::text AS area,
                coalesce((SELECT sum(CASE WHEN m."toLocationId" IS NOT NULL AND m."fromLocationId" IS NULL THEN m."baseQuantity" WHEN m."fromLocationId" IS NOT NULL AND m."toLocationId" IS NULL THEN -m."baseQuantity" ELSE 0 END) FROM "StockMove" m WHERE m."hideId" = h.id), 0)::text AS onhand
           FROM "Hide" h WHERE h."createdAt" >= $1 AND h."createdAt" <= now()`,
        [flow.startedAt],
      )
      const wrong = hides.filter((hide) => (hide.state === 'CONSUMED' ? Number(hide.onhand) !== 0 : Number(hide.onhand) < 0 || Number(hide.onhand) > Number(hide.area)))
      test.info().annotations.push({ type: 'ledger', description: `${moves.length} value-changing moves of the run, each valued once; ${hides.length} hides of the run reconcile` })
      expect(wrong.map((hide) => `${hide.code} ${hide.state}: on hand ${hide.onhand} of ${hide.area}`), 'hides whose ledger does not add up').toEqual([])
    })

    await test.step('numbers: DDT and invoice numbers have no gap', async () => {
      const start = flow.state.numberingAtStart as Record<string, number>
      const series = await query(flow, `SELECT id, kind::text AS kind, code, "nextValue" AS next, "startValue" AS first FROM "NumberSeries" WHERE kind::text = ANY($1)`, [FISCAL_KINDS])
      const problems: string[] = []
      const used: string[] = []
      for (const row of series) {
        const allocations = await query(flow, `SELECT value, formatted, "recordType" AS type, "recordId" AS record FROM "NumberAllocation" WHERE "seriesId" = $1 ORDER BY value`, [row.id])
        const values = allocations.map((entry) => entry.value as number)
        for (let index = 1; index < values.length; index++) if (values[index] !== values[index - 1] + 1) problems.push(`${row.kind} ${row.code}: ${values[index - 1]} then ${values[index]}`)
        // The run's numbers: from the series' next value when the flow began (the seed dates its own documents ahead).
        const from = start[row.id] ?? row.first
        const ours = allocations.filter((entry) => (entry.value as number) >= from)
        const expected = Array.from({ length: row.next - from }, (_, index) => from + index)
        if (JSON.stringify(ours.map((entry) => entry.value)) !== JSON.stringify(expected)) problems.push(`${row.kind} ${row.code}: the run took ${ours.map((entry) => entry.value).join(', ') || 'nothing'}, the series moved ${from} → ${row.next}`)
        for (const entry of ours) {
          const table = entry.type === 'Ddt' ? '"Ddt"' : entry.type === 'Invoice' ? '"Invoice"' : null
          if (!table) continue
          const [found] = await query(flow, `SELECT number FROM ${table} WHERE id = $1`, [entry.record])
          if (found?.number !== entry.formatted) problems.push(`${row.kind} ${entry.formatted}: the ${entry.type} carries ${found?.number ?? 'nothing'}`)
        }
        if (ours.length > 0) used.push(`${row.kind} ${ours.map((entry) => entry.formatted).join(', ')}`)
      }
      test.info().annotations.push({ type: 'numbers', description: used.join('; ') || 'no fiscal number taken' })
      expect(used.length, 'the run issued fiscal documents').toBeGreaterThan(0)
      expect(problems, 'gaps in the fiscal series').toEqual([])
    })

    await test.step('floor: no cost, margin or price in what a tablet reads', async () => {
      const floor = flow.captures.filter((capture) => capture.kind === 'floor' && capture.body !== undefined)
      const found = floor.flatMap((capture) => keyPaths(capture.body, /cost|margin|price/i).map((path) => `${describe(capture)} ${path}`))
      test.info().annotations.push({ type: 'floor', description: `${floor.length} floor answers read, none with a cost, margin or price field` })
      expect(floor.length, 'the tablets read answers').toBeGreaterThan(0)
      expect(found, 'cost, margin or price fields on the floor').toEqual([])
    })

    await test.step("links: prices only on the party's own document", async () => {
      const links = flow.captures.filter((capture) => capture.kind === 'link' && capture.body !== undefined)
      const supplier = links.filter((capture) => capture.context.startsWith('link-supplier'))
      const customer = links.filter((capture) => capture.context.startsWith('link-customer'))
      const supplierPrices = supplier.flatMap((capture) => keyPaths(capture.body, /price|cost|margin|amount|total/i).map((path) => `${describe(capture)} ${path}`))
      const customerCosts = customer.flatMap((capture) => keyPaths(capture.body, /cost|margin/i).map((path) => `${describe(capture)} ${path}`))
      const own = flow.state.party?.id as string | undefined
      const others = customer.flatMap((capture) =>
        keyPaths(capture.body, /price|amount|total/i).length === 0 ? [] : partiesNamed(capture.body).filter((party) => party !== own).map((party) => `${describe(capture)} names party ${party}`),
      )
      test.info().annotations.push({ type: 'links', description: `${supplier.length} supplier and ${customer.length} customer link answers read` })
      expect(supplier.length + customer.length, 'the links were read').toBeGreaterThan(0)
      expect(supplierPrices, 'prices on the supplier’s link').toEqual([])
      expect(customerCosts, 'costs or margins on the customer’s links').toEqual([])
      expect(others, 'another party’s document on the customer’s links').toEqual([])
    })

    await test.step('worker: nothing waits, nothing failed', async () => {
      const waiting = await query(flow, `SELECT type FROM "OutboxEvent" WHERE status <> 'PUBLISHED'`)
      expect(waiting.map((row) => row.type), 'events not published').toEqual([])
      const worker = await flow.control<{ failures: string[]; retried: string[] }>('GET', '/worker')
      if (worker.retried.length > 0) test.info().annotations.push({ type: 'worker', description: `retried: ${worker.retried.join(' | ')}` })
      expect(worker.failures, 'handlers that failed their last try').toEqual([])
    })

    if (flow.problems.length > 0) test.info().annotations.push({ type: 'page errors', description: flow.problems.join(' | ') })
  },
}
