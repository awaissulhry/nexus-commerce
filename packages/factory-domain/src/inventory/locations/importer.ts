import { cell } from '../../imports/cells'
import { defineImporter, type RowIssue, type RowValues } from '../../imports/importer'
import { LOCATION_CODE, LOCATION_KINDS } from './rules'

/**
 * The locations import (plan A1 W0-22 imports with a dry run; SCM-176): a sheet of a company's locations, one row per
 * location, matched by its site's code and its own code (an existing location is updated: its name, kind and parent;
 * its code and site never change). A row names its parent by code on the same site; list a parent before the rows
 * inside it (the apply writes the rows in order). The adapter is apps/factory-api modules/inventory/locations/importer.ts.
 * No money column.
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
})
