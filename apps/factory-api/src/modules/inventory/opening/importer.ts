import { businessDate } from '@nexus/factory-domain/core/time'
import type { Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import type { RowIssue } from '@nexus/factory-domain/imports/importer'
import { importedLineValues, openingStockImporter } from '@nexus/factory-domain/inventory/opening/importer'
import { lotGroupProblems, planOpeningRow, REPORT_COLUMNS } from '@nexus/factory-domain/inventory/opening/rules'
import { INVENTORY_OPENING_IMPORT, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { QUALITY_LOTS_TEST } from '@nexus/factory-domain/quality/lab/permissions'
import { serverClock } from '../../../core/time'
import type { ImportAdapter } from '../../../platform/imports/registry'
import { importedLines, readOpeningFacts } from './facts'
import { postOpeningLine } from './post'

/**
 * The opening stock import's adapter (factory-domain inventory/opening; platform/imports; B-W1-35, SCM-288, QHS-029):
 *
 *   authorize  a company's import only (opening stock is a company's); a sheet that maps a report column also needs
 *              quality.lots.test over the company (recording a chromium VI result is the lab step's permission).
 *   load       the lines already posted (their first move's idempotency key): the plan answers UNCHANGED when the row
 *              says the same, an error when it says something else, never a second posting.
 *   check      every other row against what it names (facts.ts) and the rows of its lot in the batch, for the person
 *              (the starter in the dry run, the applier at the apply): the site must be one their role reaches with
 *              inventory.opening.import.
 *   write      post.ts, one line in the batch's command.
 *
 * Running and applying it needs inventory.opening.import; seeing its plans inventory.stock.view. The registry lists this
 * adapter, so it imports only the registry's types (no load-order cycle).
 */

const line = (values: Readonly<Record<string, unknown>>): string => String(values.line)

export const openingStockImportAdapter: ImportAdapter = Object.freeze({
  importer: openingStockImporter,
  permission: INVENTORY_OPENING_IMPORT,
  viewPermission: INVENTORY_STOCK_VIEW,

  authorize(actor, job, columns) {
    const issues: Issue[] = []
    if (job.companyId === null) issues.push({ path: 'companyId', message: "Opening stock is a company's: start the import for one company." })
    const report = REPORT_COLUMNS.find((column) => columns.includes(column))
    if (report && job.companyId !== null && !can(actor, QUALITY_LOTS_TEST, { companyId: job.companyId })) {
      issues.push({ path: `column/${report}`, message: "This sheet brings chromium VI reports: recording them needs quality.lots.test over the import's company (the lab step's permission)." })
    }
    return issues
  },

  async load(client, keys, scope) {
    if (scope.companyId === null) return []
    const posted = await importedLines(client, scope.companyId, keys.map(line))
    return [...posted.values()].map((imported) => ({
      id: imported.moves[0]!.lotId ?? imported.moves[0]!.id,
      values: importedLineValues(imported.line, { ...imported, quantities: imported.moves.map((move) => move.quantity) }),
    }))
  },

  async check(client, rows, scope, actor) {
    const companyId = scope.companyId
    if (companyId === null) return rows.map(() => [{ message: "Opening stock is a company's: start the import for one company." }])
    const posted = await importedLines(client, companyId, rows.map((row) => line(row.values)))
    // A line posted before is the plan's (UNCHANGED, or an error): its facts are not judged again.
    const fresh = rows.filter((row) => !posted.has(line(row.values)))
    if (fresh.length === 0) return rows.map(() => [])
    const company = await client.company.findUniqueOrThrow({ where: { id: companyId }, select: { tenantId: true } })
    const facts = await readOpeningFacts(
      client,
      fresh.map((row) => row.values),
      { tenantId: company.tenantId, companyId, today: businessDate(serverClock.now()), reaches: (site) => can(actor, INVENTORY_OPENING_IMPORT, { companyId: site.companyId, siteId: site.id }) },
    )
    const group = lotGroupProblems(fresh)
    const answers = new Map(fresh.map((row, index) => [row, [...planOpeningRow(row.values, facts[index]!).problems, ...group[index]!] as RowIssue[]]))
    return rows.map((row) => answers.get(row) ?? [])
  },

  async write(tools, row, scope) {
    if (row.action !== 'CREATE' || scope.companyId === null) throw new Error('The opening stock import only adds lines of a company.')
    return postOpeningLine(tools, line(row.key), row.values, scope.companyId)
  },
} satisfies ImportAdapter)
