import { cell } from '../../imports/cells'
import { defineImporter, diffPlan, type ExistingRecord, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { kindChangeProblems } from '../../purchasing/subcontracting/rules'
// B-W2b-289 (SCM-177): the kinds' rules (an outside or transit place stays one; a customer's or transit place at the top).
import { LOCATION_KIND_PROFILES, retypeProblems } from '../locations-depth/kinds'
import { LOCATION_CODE, LOCATION_KINDS, type LocationKind } from './rules'

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
 *
 * W2b-5 (B-W2b-289; SCM-177; the lead's B-W2b-277 follow-up): a CUSTOMER location (our stock at a customer or brand) names
 * its party in the same column, by the party's code; the adapter checks it as the locations page does (a CUSTOMER or BRAND
 * party, not archived, of the site's company or every company: platform/imports/importers/locations-customer.ts). A
 * customer's or transit place sits at the top of the site's tree (no parent), and a customer's, workshop's or transit
 * place never turns into another kind, nor another kind into one.
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
      type: cell.oneOf(LOCATION_KINDS, {
        magazzino: 'WAREHOUSE',
        zona: 'ZONE',
        scaffale: 'BIN',
        ricevimento: 'RECEIVING',
        quarantena: 'QUARANTINE',
        produzione: 'PRODUCTION',
        spedizione: 'SHIPPING',
        // B-W2b-289
        terzista: 'SUBCONTRACTOR',
        cliente: 'CUSTOMER',
        transito: 'TRANSIT',
        prelievo: 'PICK_FACE',
        scorta: 'BULK',
      }),
    },
    parent: { label: 'Parent', aliases: ['parent code', 'inside', 'padre', 'dentro'], type: cell.code({ max: 40, upper: true }), description: "The code of the location it sits inside, on the same site; blank at the top." },
    // W2b (B-W2b-25): after the W1 columns (the layout of older sheets stays).
    workshop: {
      label: 'Workshop',
      aliases: ['terzista', 'laboratorio', 'contoterzista', 'subcontractor', 'workshop code', 'codice terzista'],
      type: cell.code({ max: 24, upper: true }),
      description: "A Subcontractor location's workshop, or a Customer location's customer or brand: the party's code (only those kinds; it never changes).",
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
    // W2b-5 (B-W2b-277, schema wave 36; B-W2b-289): a CUSTOMER location (our stock at a customer or brand) names its party in
    // the same column; the export writes it, so the re-import keeps it UNCHANGED.
    if (kind === 'CUSTOMER' && values.workshop === undefined) return refused('workshop', "A Customer location is our stock at one customer or brand: name it (the customer's party code).")
  } else {
    const change = values.kind === undefined ? [] : kindChangeProblems(String(existing.values.kind), String(values.kind))
    if (change.length > 0) return refused('kind', change[0]!.message)
    // B-W2b-289: a customer's or transit place stays one, and no place turns into one.
    const fixed = values.kind === undefined || values.kind === existing.values.kind ? [] : retypeProblems(String(existing.values.kind) as LocationKind, String(values.kind) as LocationKind, { hasParent: false, children: 0 })
    if (fixed.length > 0) return refused('kind', fixed[0]!.message)
    if (values.workshop !== undefined && kind === 'SUBCONTRACTOR' && values.workshop !== existing.values.workshop) {
      return refused('workshop', `This workshop location stays ${String(existing.values.workshop ?? 'without a workshop')}'s (its workshop never changes): make a new location for another workshop.`)
    }
    if (values.workshop !== undefined && kind === 'CUSTOMER' && values.workshop !== existing.values.workshop) {
      return refused('workshop', `This customer location stays ${String(existing.values.workshop ?? 'without a party')}'s (its party never changes): make a new location for another customer.`)
    }
  }
  // B-W2b-289: a customer's or transit place sits at the top of the site's tree.
  if (typeof kind === 'string' && kind in LOCATION_KIND_PROFILES && LOCATION_KIND_PROFILES[kind as LocationKind].atTop && values.parent !== undefined && values.parent !== null) {
    return refused('parent', 'A Customer or Transit location sits at the top of the site: leave the parent blank.')
  }
  if (values.workshop !== undefined && kind !== 'SUBCONTRACTOR' && kind !== 'CUSTOMER') return refused('workshop', 'Only a Subcontractor location names a workshop (and a Customer location its customer): leave the cell blank.')
  return diffPlan(locationsImporter, values, existing)
}
