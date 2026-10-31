import type { DefectClass } from '@nexus/factory-domain/quality/defects/rules'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import type { NcrSource } from '@nexus/factory-domain/quality/ncr/rules'
import { decimalText } from '@nexus/factory-domain/views/exports'
import { listNcrs, type ListQuery } from '../../../modules/quality/ncr/reads'
import { defineExportSource } from '../source'

/**
 * Quality › Nonconformances (`/quality/ncr`, the list mode; the board mode has no list frame): the export of the list
 * as the screen shows it. The address is the list's own (apps/factory-web areas/quality/ncr model.ts ncrAddressOf and
 * ncrQueryOf): `?view=open|mine|critical|supplier|waiting|overdue|closed|all` (nothing: open), `?q=` (number or title,
 * at most 80 characters), `?site=<uuid>`. Read through the module's listNcrs (quality.ncr.view, its companies and
 * sites). The module answers at most its list limit (200, newest first, with `truncated`) and has no cursor: the file
 * holds those rows. No money. The owner is named as the screen names them (an office person, inside the NCR list).
 */

type Summary = Awaited<ReturnType<typeof listNcrs>>['items'][number]
type Row = Summary & { readonly siteCode: string | null; readonly ownerName: string | null }
type Query = Omit<ListQuery, 'ownerId'> & { readonly ownerId?: 'me' }

const VIEWS = ['open', 'mine', 'critical', 'supplier', 'waiting', 'overdue', 'closed', 'all'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))
/** The file's language, from the words given for it (`lang`: ours, not the catalogue's). */
const langOf = (words: (code: string) => string): 'it' | 'en' => (words('lang') === 'it' ? 'it' : 'en')
const zoneOf = (zone: string | null, words: (code: string) => string): string | null => {
  if (!zone) return null
  const said = words(`zone.${zone}`)
  return said === `zone.${zone}` ? zone : said
}

function quantityOf(row: Row, words: (code: string) => string): string {
  const lang = langOf(words)
  const affected = `${decimalText(row.quantityAffected, lang)} ${words(`uom.${row.uom}`)}`
  return row.quantitySuspect && Number(row.quantitySuspect) > 0 ? fill(words('quantity.withSuspect'), { affected, suspect: decimalText(row.quantitySuspect, lang) }) : affected
}

export const ncrs = defineExportSource<Query, Row>({
  listKey: 'quality.ncr',
  permission: QUALITY_NCR_VIEW,
  query(address) {
    const asked = address.get('view') ?? ''
    const view = (VIEWS as readonly string[]).includes(asked) ? (asked as (typeof VIEWS)[number]) : 'open'
    const q = (address.get('q') ?? '').slice(0, 80).trim() || undefined
    const site = address.get('site') ?? ''
    const base: Query = { ...(q ? { q } : {}), ...(UUID.test(site) ? { siteId: site } : {}) }
    if (view === 'mine') return { ...base, ownerId: 'me' }
    if (view === 'critical') return { ...base, severity: 'CRITICAL' as DefectClass }
    if (view === 'supplier') return { ...base, source: 'SUPPLIER' as NcrSource }
    if (view === 'waiting') return { ...base, waiting: true }
    if (view === 'overdue') return { ...base, overdue: true }
    if (view === 'closed') return { ...base, stage: 'CLOSED' }
    if (view === 'all') return { ...base, open: false }
    return base
  },
  async read(caller, query) {
    const page = await listNcrs(caller, query)
    const siteIds = [...new Set(page.items.map((row) => row.siteId))]
    const ownerIds = [...new Set(page.items.flatMap((row) => (row.ownerId ? [row.ownerId] : [])))]
    const { sites, owners } = await caller.withClient(async (client) => ({
      sites: new Map(siteIds.length === 0 ? [] : (await client.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true } })).map((site) => [site.id, site.code])),
      owners: new Map(ownerIds.length === 0 ? [] : (await client.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName])),
    }))
    return { rows: page.items.map((row) => ({ ...row, siteCode: sites.get(row.siteId) ?? null, ownerName: row.ownerId ? (owners.get(row.ownerId) ?? null) : null })), next: null }
  },
  columns: {
    number: { value: (row) => row.number },
    site: { value: (row) => row.siteCode },
    title: { value: (row) => row.title },
    stage: { value: (row, words) => words(`stage.${row.stage}`) },
    severity: { value: (row, words) => words(`severity.${row.severity}`) },
    quantity: { value: (row, words) => quantityOf(row, words) },
    due: { value: (row, words) => (row.stage !== 'OPEN' || !row.containmentDueAt ? null : row.containmentOverdue || Date.parse(row.containmentDueAt) <= Date.now() ? words('due.overdue') : { at: row.containmentDueAt }) },
    owner: { value: (row, words) => (!row.ownerId ? words('common.nobody') : (row.ownerName ?? words('common.unknownPerson'))) },
    source: { value: (row, words) => [words(`source.${row.source}`), row.sourceType ? words(`recordType.${row.sourceType}`) : null].filter(Boolean).join(' · ') },
    defect: {
      value: (row, words) => {
        const zone = zoneOf(row.zone, words)
        if (!row.defect) return zone
        return [row.defect.code, langOf(words) === 'it' ? row.defect.labelIt : row.defect.labelEn, zone].filter(Boolean).join(' · ')
      },
    },
    style: { value: (row) => (row.style ? [row.style.code, row.colourway?.code, row.size].filter(Boolean).join(' · ') : null) },
    lot: { value: (row) => row.lot?.code ?? row.serial ?? null },
    supplier: { value: (row) => row.supplier?.name ?? null },
    age: { value: (row, words) => (row.ageDays === 0 ? words('age.today') : fill(words(`age.days_${row.ageDays === 1 ? 'one' : 'other'}`), { count: row.ageDays })) },
  },
  words: {
    it: {
      lang: 'it',
      'common.nobody': 'Ancora nessuno',
      'common.unknownPerson': "Un'altra persona",
      'stage.OPEN': 'Aperta',
      'stage.CONTAINED': 'Contenuta',
      'stage.DECIDED': 'Decisa',
      'stage.CLOSED': 'Chiusa',
      'stage.CANCELLED': 'Annullata',
      'severity.CRITICAL': 'Critica',
      'severity.MAJOR': 'Maggiore',
      'severity.MINOR': 'Minore',
      'source.INSPECTION': 'Ispezione',
      'source.BUNDLE': 'Scarto di pacco',
      'source.COMPLAINT': 'Reclamo',
      'source.RETURN': 'Reso',
      'source.SUPPLIER': 'Fornitore',
      'source.AUDIT': 'Audit',
      'source.OTHER': 'Altro',
      'recordType.Inspection': 'Ispezione',
      'recordType.Bundle': 'Pacco',
      'recordType.OperationScan': 'Lettura',
      'recordType.WorkOrder': 'Ordine di lavoro',
      'recordType.GarmentSerial': 'Capo',
      'recordType.Lot': 'Lotto',
      'recordType.Hide': 'Pelle',
      'recordType.GoodsReceipt': 'Entrata merci',
      'recordType.ReceiptDiscrepancy': 'Differenza di entrata',
      'recordType.SupplierClaim': 'Reclamo al fornitore',
      'recordType.QualityHold': 'Blocco',
      'recordType.ReturnAuthorisation': 'Reso',
      'recordType.ReturnLine': 'Riga di reso',
      'recordType.Complaint': 'Reclamo',
      'recordType.PpeRegisterEntry': 'Voce del registro DPI',
      'recordType.ReworkOrder': 'Ordine di rilavorazione',
      'recordType.RepairOrder': 'Riparazione',
      'recordType.Shipment': 'Spedizione',
      'recordType.SalesOrder': 'Ordine di vendita',
      'recordType.PurchaseOrder': "Ordine d'acquisto",
      'recordType.Style': 'Modello',
      'recordType.Nonconformance': 'Non conformità',
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
      'quantity.withSuspect': '{affected} · {suspect} sospetti',
      'due.overdue': 'Contenimento in ritardo',
      'age.today': 'Oggi',
      'age.days_one': '{count} giorno',
      'age.days_other': '{count} giorni',
      'zone.FRONT': 'Davanti',
      'zone.BACK': 'Dietro',
      'zone.COLLAR': 'Colletto',
      'zone.SHOULDER': 'Spalla',
      'zone.SHOULDER_L': 'Spalla sinistra',
      'zone.SHOULDER_R': 'Spalla destra',
      'zone.SLEEVE_L': 'Manica sinistra',
      'zone.SLEEVE_R': 'Manica destra',
      'zone.ELBOW_L': 'Gomito sinistro',
      'zone.ELBOW_R': 'Gomito destro',
      'zone.CUFF': 'Polsino',
      'zone.CHEST': 'Petto',
      'zone.BACK_PROTECTOR': 'Tasca paraschiena',
      'zone.WAIST': 'Vita',
      'zone.HIP_L': 'Anca sinistra',
      'zone.HIP_R': 'Anca destra',
      'zone.SEAT': 'Seduta',
      'zone.KNEE_L': 'Ginocchio sinistro',
      'zone.KNEE_R': 'Ginocchio destro',
      'zone.LEG_L': 'Gamba sinistra',
      'zone.LEG_R': 'Gamba destra',
      'zone.ZIP': 'Cerniera',
      'zone.POCKET': 'Tasca',
      'zone.LINING': 'Fodera',
      'zone.LABEL': 'Etichetta',
    },
    en: {
      lang: 'en',
      'common.nobody': 'Nobody yet',
      'common.unknownPerson': 'Someone else',
      'stage.OPEN': 'Open',
      'stage.CONTAINED': 'Contained',
      'stage.DECIDED': 'Decided',
      'stage.CLOSED': 'Closed',
      'stage.CANCELLED': 'Cancelled',
      'severity.CRITICAL': 'Critical',
      'severity.MAJOR': 'Major',
      'severity.MINOR': 'Minor',
      'source.INSPECTION': 'Inspection',
      'source.BUNDLE': 'Bundle reject',
      'source.COMPLAINT': 'Complaint',
      'source.RETURN': 'Return',
      'source.SUPPLIER': 'Supplier',
      'source.AUDIT': 'Audit',
      'source.OTHER': 'Other',
      'recordType.Inspection': 'Inspection',
      'recordType.Bundle': 'Bundle',
      'recordType.OperationScan': 'Scan',
      'recordType.WorkOrder': 'Work order',
      'recordType.GarmentSerial': 'Garment',
      'recordType.Lot': 'Lot',
      'recordType.Hide': 'Hide',
      'recordType.GoodsReceipt': 'Goods receipt',
      'recordType.ReceiptDiscrepancy': 'Receipt discrepancy',
      'recordType.SupplierClaim': 'Supplier claim',
      'recordType.QualityHold': 'Hold',
      'recordType.ReturnAuthorisation': 'Return',
      'recordType.ReturnLine': 'Return line',
      'recordType.Complaint': 'Complaint',
      'recordType.PpeRegisterEntry': 'PPE register entry',
      'recordType.ReworkOrder': 'Rework order',
      'recordType.RepairOrder': 'Repair',
      'recordType.Shipment': 'Shipment',
      'recordType.SalesOrder': 'Sales order',
      'recordType.PurchaseOrder': 'Purchase order',
      'recordType.Style': 'Style',
      'recordType.Nonconformance': 'Nonconformance',
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
      'quantity.withSuspect': '{affected} · {suspect} suspect',
      'due.overdue': 'Containment overdue',
      'age.today': 'Today',
      'age.days_one': '{count} day',
      'age.days_other': '{count} days',
      'zone.FRONT': 'Front',
      'zone.BACK': 'Back',
      'zone.COLLAR': 'Collar',
      'zone.SHOULDER': 'Shoulder',
      'zone.SHOULDER_L': 'Left shoulder',
      'zone.SHOULDER_R': 'Right shoulder',
      'zone.SLEEVE_L': 'Left sleeve',
      'zone.SLEEVE_R': 'Right sleeve',
      'zone.ELBOW_L': 'Left elbow',
      'zone.ELBOW_R': 'Right elbow',
      'zone.CUFF': 'Cuff',
      'zone.CHEST': 'Chest',
      'zone.BACK_PROTECTOR': 'Back protector pocket',
      'zone.WAIST': 'Waist',
      'zone.HIP_L': 'Left hip',
      'zone.HIP_R': 'Right hip',
      'zone.SEAT': 'Seat',
      'zone.KNEE_L': 'Left knee',
      'zone.KNEE_R': 'Right knee',
      'zone.LEG_L': 'Left leg',
      'zone.LEG_R': 'Right leg',
      'zone.ZIP': 'Zip',
      'zone.POCKET': 'Pocket',
      'zone.LINING': 'Lining',
      'zone.LABEL': 'Label',
    },
  },
})
