import { cell } from '../../imports/cells'
import { defineImporter, diffPlan, type ExistingRecord, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { kindChangeProblems } from '../../purchasing/subcontracting/rules'
import { LOCATION_CODE, LOCATION_KINDS } from './rules'

/**
 * The locations import (plan A1 W0-22 imports with a dry run; SCM-176): a sheet of a company's locations, one row per
 * location, matched by its site's code and its own code (an existing location is updated: its name, kind and parent;
 * its code and site never change). A row names its parent by code on the same site; list a parent before the rows
 * inside it (the apply writes the rows in order). The adapter is apps/factory-api modules/inventory/locations/importer.ts.
 * No money column.
 *
 * W2b (B-W2b-25; the B-W2a-25 gap): a workshop's stock location (kind SUBCONTRACTOR, SCM-141) names its workshop by the
 * party's code in the Workshop column, and only that kind does; its workshop never changes, and a location never turns
 * into one or stops being one (factory-domain purchasing/subcontracting `kindChangeProblems`). The adapter's check finds
 * the workshop (a SUBCONTRACTOR party, not archived, of the site's company or every company; one ACTIVE location per
 * workshop and site), as the locations page does.
 */
export const locationsImporter = defineImporter({
  key: 'inventory.locations',
  label: 'Locations',
  description: "A site's locations: warehouses, zones, bins, the goods-in dock, the quarantine shelf, line-side racks. Parents first.",
  columns: {
    site: { label: 'Site', aliases: ['site code', 'sito', 'stabilimento', 'sede'], required: true, type: cell.code({ max: 40, upper: true }), description: "The site's code." },
    code: { label: 'Code', aliases: ['location', 'location code', 'codice', 'ubicazione', 'bin'], required: true, type: cell.code({ max: 40, upper: true }), description: 'The code on the bin label, unique on the site.' },
    name: { label: 'Name', aliases: ['nome', 'descrizione', 'description'], required: true, type: cell.text({ max: 120 }) },
    kind: {
      label: 'Kind',
      aliases: ['type', 'tipo'],
      required: true,
      type: cell.oneOf(LOCATION_KINDS, { magazzino: 'WAREHOUSE', zona: 'ZONE', scaffale: 'BIN', ricevimento: 'RECEIVING', quarantena: 'QUARANTINE', produzione: 'PRODUCTION', spedizione: 'SHIPPING' }),
    },
    parent: { label: 'Parent', aliases: ['parent code', 'inside', 'padre', 'dentro'], type: cell.code({ max: 40, upper: true }), description: "The code of the location it sits inside, on the same site; blank at the top." },
    // W2b (B-W2b-25): after the W1 columns (the layout of older sheets stays).
    workshop: {
      label: 'Workshop',
      aliases: ['terzista', 'laboratorio', 'contoterzista', 'subcontractor', 'workshop code', 'codice terzista'],
      type: cell.code({ max: 24, upper: true }),
      description: "A Subcontractor location's workshop: the subcontractor's party code (only that kind; it never changes).",
    },
  },
  keyColumns: ['site', 'code'],
  validateRow: (values: RowValues): RowIssue[] => {
    const issues: RowIssue[] = []
    if (typeof values.code === 'string' && !LOCATION_CODE.test(values.code)) {
      issues.push({ column: 'code', message: 'Expected upper-case letters, digits, dots, dashes or underscores.' })
    }
    if (values.parent !== undefined && values.parent === values.code) issues.push({ column: 'parent', message: 'A location does not sit inside itself.' })
    return issues
  },
  plan: (values, existing) => planLocationRow(values, existing),
})

/**
 * What one row does (the importer's `plan`): the workshop rules (see above), then the default comparison of the given
 * cells with the location (`diffPlan`).
 */
export function planLocationRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  const refused = (column: string, message: string): RowPlan => ({ action: 'ERROR', errors: [{ column, message }] })
  const kind = values.kind ?? existing?.values.kind ?? null
  if (existing === null) {
    if (kind === 'SUBCONTRACTOR' && values.workshop === undefined) return refused('workshop', "A Subcontractor location is our stock at one workshop: name it (the subcontractor's party code).")
  } else {
    const change = values.kind === undefined ? [] : kindChangeProblems(String(existing.values.kind), String(values.kind))
    if (change.length > 0) return refused('kind', change[0]!.message)
    if (values.workshop !== undefined && kind === 'SUBCONTRACTOR' && values.workshop !== existing.values.workshop) {
      return refused('workshop', `This workshop location stays ${String(existing.values.workshop ?? 'without a workshop')}'s (its workshop never changes): make a new location for another workshop.`)
    }
  }
  if (values.workshop !== undefined && kind !== 'SUBCONTRACTOR') return refused('workshop', 'Only a Subcontractor location names a workshop: leave the cell blank.')
  return diffPlan(locationsImporter, values, existing)
}
