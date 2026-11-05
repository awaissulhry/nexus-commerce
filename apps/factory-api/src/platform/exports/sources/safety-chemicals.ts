import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { CHEMICAL_USES, type ChemicalUse } from '@nexus/factory-domain/safety/chemicals/rules'
import { listChemicals } from '../../../modules/safety/chemicals/reads'
import type { ChemicalView } from '../../../modules/safety/chemicals/store'
import { defineExportSource } from '../source'

/**
 * Plant › Health & safety › Chemicals & waste (`/plant/chemicals`, the register of SCR-213; B-W2b-143; design "⋯ Export
 * register"): the chemical register as the list shows it, through the module's own read (safety.view over its companies
 * and sites). The address is the list's: `?siteId=`, `?status=ACTIVE|ARCHIVED|all`, `?tile=withoutSds|toRequest`, `?use=`,
 * `?cabinet=`, `?q=`. The codes stay CLP's (H225, P210); no person, no money.
 */

type Query = { readonly siteId?: string; readonly status?: 'ACTIVE' | 'ARCHIVED' | 'all'; readonly tile?: 'withoutSds' | 'toRequest'; readonly use?: ChemicalUse; readonly cabinet?: string; readonly q?: string }

const UUID = /^[0-9a-f-]{36}$/i

export const safetyChemicals = defineExportSource<Query, ChemicalView>({
  listKey: 'plant.chemicals',
  permission: SAFETY_VIEW,
  query(address) {
    const siteId = address.get('siteId') ?? ''
    const status = address.get('status') ?? ''
    const tile = address.get('tile') ?? ''
    const use = address.get('use') ?? ''
    const cabinet = (address.get('cabinet') ?? '').trim()
    const q = (address.get('q') ?? '').trim()
    return {
      ...(UUID.test(siteId) ? { siteId } : {}),
      ...(status === 'ACTIVE' || status === 'ARCHIVED' || status === 'all' ? { status } : {}),
      ...(tile === 'withoutSds' || tile === 'toRequest' ? { tile } : {}),
      ...((CHEMICAL_USES as readonly string[]).includes(use) ? { use: use as ChemicalUse } : {}),
      ...(cabinet && cabinet.length <= 40 ? { cabinet } : {}),
      ...(q && q.length <= 80 ? { q } : {}),
    }
  },
  async read(caller, query) {
    const answer = await listChemicals(caller, query)
    return { rows: answer.chemicals, next: null }
  },
  columns: {
    name: { value: (row) => row.name },
    supplier: { value: (row) => row.supplier.name },
    use: { value: (row, words) => words(`use.${row.use}`) },
    pictograms: { value: (row) => row.ghsPictograms.join(' ') },
    signalWord: { value: (row, words) => (row.signalWord ? words(`signal.${row.signalWord}`) : null) },
    hazards: { value: (row) => row.hazardStatements.join(' ') },
    precautions: { value: (row) => row.precautionStatements.join(' ') },
    place: { value: (row) => (row.cabinetCode ? `${row.storagePlace} · ${row.cabinetCode}` : row.storagePlace) },
    site: { value: (row) => `${row.site.code} · ${row.site.name}` },
    maxQuantity: { value: (row) => (row.maxQuantity && row.maxQuantityUnit ? `${row.maxQuantity} ${row.maxQuantityUnit.toLowerCase()}` : null) },
    roles: { value: (row) => row.roles.map((role) => role.name).join(', ') },
    ppe: { value: (row) => row.ppe.map((item) => item.name).join(', ') },
    sds: { value: (row, words) => (row.current.length === 0 ? words('sds.none') : row.current.map((sheet) => `${sheet.versionLabel} (${sheet.language}, ${sheet.revisedOn})`).join('; ')) },
    status: { value: (row, words) => words(`status.${row.status}`) },
  },
  words: {
    it: {
      'use.GLUE': 'Colla',
      'use.SOLVENT': 'Solvente',
      'use.PRIMER': 'Primer',
      'use.FINISH': 'Finissaggio',
      'use.EDGE_PAINT': 'Tinta per bordi',
      'use.DYE': 'Colorante',
      'use.CLEANER': 'Detergente',
      'use.OIL': 'Olio',
      'use.OTHER': 'Altro',
      'signal.DANGER': 'Pericolo',
      'signal.WARNING': 'Attenzione',
      'sds.none': 'Nessuna SDS',
      'status.ACTIVE': 'In uso',
      'status.ARCHIVED': 'Archiviata',
    },
    en: {
      'use.GLUE': 'Glue',
      'use.SOLVENT': 'Solvent',
      'use.PRIMER': 'Primer',
      'use.FINISH': 'Finish',
      'use.EDGE_PAINT': 'Edge paint',
      'use.DYE': 'Dye',
      'use.CLEANER': 'Cleaner',
      'use.OIL': 'Oil',
      'use.OTHER': 'Other',
      'signal.DANGER': 'Danger',
      'signal.WARNING': 'Warning',
      'sds.none': 'No SDS',
      'status.ACTIVE': 'In use',
      'status.ARCHIVED': 'Archived',
    },
  },
})
