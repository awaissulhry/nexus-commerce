import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import type { Order } from '../../api'
import type { Role } from '../../_demo/fixtures'
import { LINE_BLK, LINE_RED } from '../../_demo/fixtures'
import { abilitiesOf } from '../../model'
import { rolePermissions } from '../../../../../shell/design-data'
import { ORDER_FILES } from '../overview/fixtures'
import type { OrderRecordModel } from '../record-model'
import type { FileActsState, FileActWindow, OrderFile, OrderFilesGroup, OrderFilesMay, OrderFilesModel, OrderFilesRead } from '../../../../../lib/record-thread/files-view/model'
import { asksState, withAsks } from '../../../../../lib/record-thread/files-view/asks/fixtures'
import { newAskDraft, type AskAbilities } from '../../../../../lib/record-thread/files-view/asks/asks'
import { viewerFilesOf } from '../../../../../lib/record-thread/files-view/use-order-file-viewer'

/**
 * T.1 (order FILES tab, 15-steps) — the Files tab's states the seed lacks, design-only (a fixtures.ts of its own, no screen: the order
 * record's screen lists them): a working order with files in every group and three open asks; a priced ask, the priced papers and a
 * body-data sheet as Sales reads them; a held upload (own card + counted); a document with 5 versions; shipment papers with an
 * annulled DDT inside its shipment and a replaced invoice XML folded; a closed order (no "Ask"); every part failed; the roles Owner,
 * Sales, Production manager, Factory designer and Read-only; the W3 windows (Who can see…, Rename…, Delete…, New version…, Mark as
 * priced?). Made-up data only (Seed Customer One, WO-0041, "Sewing team", "Pattern maker"); never a floor worker's name.
 */

type Base = (role: Role, value: Order, over?: Partial<OrderRecordModel>) => { role: Role; record: OrderRecordModel }

const ORDER = ORDER_FILES.order
const uid = (n: number) => `0190f0e2-8383-7000-8000-${String(n).padStart(12, '0')}`
const w = (en: string, it: string) => ({ en, it })
const file = (n: number, over: Partial<OrderFile>): OrderFile => ({
  id: uid(n),
  name: `file-${n}.pdf`,
  kind: 'DOCUMENT',
  category: null,
  contentType: 'application/pdf',
  sizeBytes: 182_000,
  versionNo: 1,
  at: '2026-11-18T10:00:00Z',
  from: { type: 'SalesOrder', id: ORDER.id, label: ORDER.number },
  line: null,
  audience: 'OFFICE_ONLY',
  bodyData: false,
  alsoOn: [],
  alsoOnOther: 0,
  inThread: null,
  version: 1,
  versions: 1,
  ...over,
})
const LINE_1 = { type: 'SalesOrderLine', id: LINE_BLK, label: `${ORDER.number} · 1` }
const LINE_2 = { type: 'SalesOrderLine', id: LINE_RED, label: `${ORDER.number} · 2` }
const WO_41 = { type: 'WorkOrder', id: uid(900), label: 'WO-0041' }
const SHIPMENT = { type: 'Shipment', id: uid(901), label: 'SH-2026-0012' }
const INVOICE = { type: 'Invoice', id: uid(902), label: 'FT 45/2026' }
const KEPT = { legalHold: false, retainUntil: '2036-12-31T00:00:00Z' }

/** The document with 5 versions (Versions… / Delete… "and its 5 versions"), shared with the customer. */
export const SIZE_SPEC = file(1, { name: 'Size spec SEED-JKT-02.pdf', versionNo: 5, version: 9, versions: 5, audience: 'CUSTOMER_CAN_SEE', audiences: ['CUSTOMER'], inThread: { messageId: uid(800) }, addedBy: { kind: 'PERSON', name: 'Carlo Prova' } })
/** The order confirmation Nexus made, priced (born priced: it keeps its mark). */
const CONFIRMATION = file(2, { name: 'Order confirmation v2.pdf', versionNo: 2, version: 3, versions: 2, made: 'GENERATED', priced: true, bornPriced: true, documentWords: w('Order confirmation', 'Conferma d’ordine'), addedBy: null })
/** The customer's PO, priced (a price holder takes the mark off). */
const CUSTOMER_PO = file(3, { name: 'Customer PO 7781.pdf', priced: true, addedBy: { kind: 'CUSTOMER', name: 'Seed Customer One' } })
const NOTES = file(4, { name: 'Office notes.pdf', addedBy: { kind: 'PERSON', name: 'Alex Demo' } })
const LOGO = file(5, { name: 'Logo embroidery.pdf', category: 'ARTWORK', from: LINE_1, line: { id: LINE_BLK, seq: 1 }, audiences: ['FLOOR'], version: 4 })
const PATTERN = file(6, { name: 'Pattern size 52.pdf', from: LINE_1, line: { id: LINE_BLK, seq: 1 }, askId: 'ask-arrived', addedBy: { kind: 'PERSON', name: 'Paola Disegno' } })
const CARE = file(7, { name: 'Care label IT-EN.png', kind: 'PHOTO', contentType: 'image/png', from: LINE_2, line: { id: LINE_RED, seq: 2 } })
const TECH_PACK = file(8, { name: 'Tech pack SEED-JKT-02.pdf', from: { type: 'TechPack', id: uid(903), label: 'SEED-JKT-02 v3' }, techPack: { named: 2, newer: true } })
const SKETCH = file(9, { name: 'Customer sketch collar.png', kind: 'PHOTO', contentType: 'image/png', from: { type: 'OrderChangeRequest', id: uid(904), label: 'CR-0003' } })
const COLLAR = file(10, { name: 'Collar seam front.jpg', kind: 'PHOTO', contentType: 'image/jpeg', from: WO_41, addedBy: { kind: 'FLOOR', name: 'Sewing team' }, askId: null })
const CUT = file(11, { name: 'Cut panels.jpg', kind: 'PHOTO', contentType: 'image/jpeg', from: WO_41, addedBy: { kind: 'FLOOR', name: null } })
const QC = file(12, { name: 'Inspection report QC-0007.pdf', from: { type: 'Inspection', id: uid(905), label: 'QC-0007' } })
const POD = file(13, { name: 'Proof of delivery SH-2026-0012.pdf', from: SHIPMENT, made: 'POD', addedBy: null })
const DDT = file(14, { name: 'DDT 12-2026.pdf', from: { type: 'Ddt', id: uid(906), label: 'DDT 12/2026', shipment: { id: SHIPMENT.id, label: SHIPMENT.label } }, made: 'GENERATED', documentWords: w('Delivery note', 'Documento di trasporto'), addedBy: null })
const DDT_OLD = file(15, { name: 'DDT 11-2026.pdf', from: { type: 'Ddt', id: uid(907), label: 'DDT 11/2026', state: 'ANNULLED', shipment: { id: SHIPMENT.id, label: SHIPMENT.label } }, made: 'GENERATED', documentWords: w('Delivery note', 'Documento di trasporto'), addedBy: null })
const XML = file(16, { name: 'IT01234567890_FT45.xml', kind: 'FISCAL_ARCHIVE', contentType: 'application/xml', from: INVOICE, fiscal: true, made: 'INVOICE', kept: KEPT, addedBy: null })
const XML_OLD = file(17, { name: 'IT01234567890_FT45_old.xml', kind: 'FISCAL_ARCHIVE', contentType: 'application/xml', from: { ...INVOICE, state: 'REPLACED' }, fiscal: true, made: 'INVOICE', kept: KEPT, addedBy: null })
const CREDIT = file(18, { name: 'NC 3-2026.pdf', from: { type: 'Invoice', id: uid(908), label: 'NC 3/2026' }, made: 'INVOICE', priced: true, bornPriced: true, addedBy: null })
const LABEL = file(19, { name: 'Return label RA-0002.pdf', from: { type: 'ReturnAuthorisation', id: uid(909), label: 'RA-0002' }, made: 'RETURN_LABEL', addedBy: null })
const HELD_ON_HOLD = file(20, { name: 'Lab test report.pdf', kept: { legalHold: true, retainUntil: null } })

const group = (key: string, words: { en: string; it: string }, files: readonly OrderFile[], over: Partial<OrderFilesGroup> = {}): OrderFilesGroup => ({ key, words, files, leftOut: 0, measurementsLeftOut: 0, ...over })

/** A working order with files in every group (the Owner's read: priced papers named), three open asks and a held upload of the reader. */
export const OF_FULL: OrderFilesRead = withAsks({
  order: ORDER,
  groups: [
    group('ORDER', w('Order & thread', 'Ordine e conversazione'), [SIZE_SPEC, CONFIRMATION, CUSTOMER_PO, NOTES, HELD_ON_HOLD]),
    group('LINES', w('Lines & artwork', 'Righe e grafiche'), [LOGO, PATTERN, CARE], { heldCount: 2 }),
    group('TECH_PACK', w('Customer’s tech pack', 'Scheda tecnica del cliente'), [TECH_PACK]),
    group('REQUESTS', w('Requests', 'Richieste'), [SKETCH]),
    group('PRODUCTION', w('Production', 'Produzione'), [COLLAR, CUT], { leftOut: 1 }),
    group('QUALITY', w('Quality', 'Qualità'), [QC]),
    group('SHIPMENTS', w('Shipments & invoices', 'Spedizioni e fatture'), [POD, DDT, DDT_OLD, XML, XML_OLD, CREDIT]),
    group('RETURNS', w('Returns & complaints', 'Resi e reclami'), [LABEL]),
  ],
  total: 20,
  truncated: false,
  held: [{ id: uid(50), name: 'Pattern size 54.pdf', group: 'LINES', at: '2026-11-22T09:40:00Z', reason: 'SCAN_PENDING' }],
})
// The arrived ask answers with the pattern PDF (ringed "For an ask — check it").
const OWN_ASKS: OrderFilesRead = { ...OF_FULL, asks: (OF_FULL.asks ?? []).map((one) => (one.id === 'ask-arrived' && one.answered ? { ...one, answered: { ...one.answered, fileIds: [PATTERN.id] } } : one)) }

/** The same read as a reader WITHOUT prices gets it (Sales, the production manager, the designer): priced papers and the priced ask counted, the body-data sheet locked. */
const NO_PRICES: OrderFilesRead = {
  ...OWN_ASKS,
  groups: OWN_ASKS.groups.map((one) => ({ ...one, files: one.files.filter((entry) => !entry.priced), pricedLeftOut: one.files.filter((entry) => entry.priced).length || undefined, ...(one.key === 'LINES' ? { measurementsLeftOut: 1 } : {}) })),
  asks: (OWN_ASKS.asks ?? []).filter((one) => !one.priced),
  asksLeftOut: (OWN_ASKS.asksLeftOut ?? 0) + 1,
}

const MAY: Readonly<Record<'owner' | 'sales' | 'manager' | 'designer' | 'readOnly', OrderFilesMay>> = {
  owner: { upload: true, delete: true, share: true, ask: true, askCustomer: true },
  sales: { upload: true, delete: false, share: false, ask: true, askCustomer: true },
  manager: { upload: true, delete: false, share: false, ask: true, askCustomer: false },
  designer: { upload: true, delete: false, share: false, ask: true, askCustomer: false },
  readOnly: { upload: false, delete: false, share: false, ask: false, askCustomer: false },
}
const ASK_CAN = (may: OrderFilesMay, over: Partial<AskAbilities> = {}): AskAbilities => ({ ask: may.ask, askCustomer: may.askCustomer, share: may.share, closed: false, readOnly: false, ...over })

/** The tab's container model as the gallery draws it (no actions: doors are named, nothing runs). */
const files = (read: OrderFilesRead | null, may: OrderFilesMay, over: Partial<OrderFilesModel> = {}): OrderFilesModel => ({
  read,
  problem: null,
  selected: [],
  canShare: may.share,
  may,
  versionsHere: true,
  readOnly: false,
  ...(read ? { asks: asksState({ can: ASK_CAN(may) }) } : {}),
  ...over,
})
const acts = (window: FileActWindow | null, over: Partial<FileActsState> = {}): FileActsState => ({ window, busy: false, problem: null, notice: null, party: 'Seed Customer One', ...over })
const item = (one: OrderFile) => ({ id: one.id, name: one.name, version: one.version ?? 1, visibility: one.audiences?.includes('CUSTOMER') ? (['OFFICE', 'PARTNER'] as const) : (['OFFICE'] as const), versions: one.versions ?? 1, versionNo: one.versionNo })
const noMoney = (can: OrderRecordModel['can']): OrderRecordModel['can'] => ({ ...can, price: false, margin: false, cost: false })
const designerCan = abilitiesOf([...(templateOf('designer')?.permissions ?? [])])
const readOnlyCan = abilitiesOf(rolePermissions('read_only'))

export function filesLaneCases(base: Base, production: Order) {
  const tab = (role: Role, model: OrderFilesModel, over: Partial<OrderRecordModel> = {}) => base(role, production, { tab: 'files', files: model, ...over })
  const owner = (model: OrderFilesModel) => tab('owner', model)
  return [
    { id: 'of-empty-owner', label: 'F-OF T.1 · Owner · Files: no files yet — one line, Add files… and Ask for a file… in the head', model: owner(files({ order: ORDER, groups: [], total: 0, truncated: false, asks: [], customerAsks: [] }, MAY.owner)) },
    { id: 'of-full', label: 'F-OF T.1 · Owner · Files: every group — the order’s own (5 versions, a priced confirmation Nexus made, a legal hold), lines (a floor chip, a held upload), tech pack (newer), requests, WO-0041 photos, quality, a shipment with its DDT (an annulled one folded), an invoice XML (the replaced one folded), a credit note, a return label; 3 open asks', model: owner(files(OWN_ASKS, MAY.owner)) },
    { id: 'of-chosen-owner', label: 'F-OF T.1 · Owner · Files: 3 chosen — Download 3 · Who can see 3… · ⋯ Delete 3… · Clear', model: owner(files(OWN_ASKS, MAY.owner, { selected: [SIZE_SPEC.id, NOTES.id, LOGO.id] })) },
    { id: 'of-sales', label: 'F-OF T.1 · Seen as Sales · Files: the priced papers and the priced ask counted, the body-data sheet locked; no Who can see…, no Delete…', model: tab('sales', files(NO_PRICES, MAY.sales), { can: noMoney(base('sales', production).record.can) }) },
    { id: 'of-manager', label: 'F-OF T.1 · Seen as Production manager · Files: reads every group, uploads and asks; no Who can see…, no Delete…', model: tab('manager', files(NO_PRICES, MAY.manager)) },
    { id: 'of-designer', label: 'F-OF T.1 · Seen as Factory designer · Files: may be asked and asks for a file (S3: tasks.manage); no money — the priced papers counted', model: tab('manager', files(NO_PRICES, MAY.designer), { can: noMoney(designerCan) }) },
    { id: 'of-readonly', label: 'F-OF T.1 · Seen as Read-only · Files: reads every row; the ⋯ keeps Versions… only, no Add, no Ask, no bulk act', model: tab('manager', files(NO_PRICES, MAY.readOnly, { readOnly: true, asks: asksState({ can: ASK_CAN(MAY.readOnly, { readOnly: true }) }) }), { can: noMoney(readOnlyCan) }) },
    { id: 'of-closed', label: 'F-OF T.1 · Owner · Files on a closed order: no new ask ("This order is closed: no new asks."); the files and acts stay', model: owner(files(OWN_ASKS, MAY.owner, { asks: asksState({ can: ASK_CAN(MAY.owner, { closed: true }) }) })) },
    // Each part fails on its own line (never a "nothing"): the read, the viewer's file, the ask's pickers.
    { id: 'of-failed', label: 'F-OF T.1 · Files: the read failed — said, with Try again', model: owner(files(null, MAY.owner, { problem: 'read' })) },
    { id: 'of-viewer-failed', label: 'F-OF T.1 · Owner · The viewer: the file could not be opened — Try again (no loop)', model: owner(files(OWN_ASKS, MAY.owner, { viewer: { files: viewerFilesOf([SIZE_SPEC], new Map(), new Set(), new Set([SIZE_SPEC.id])), index: 0, returnTo: null } })) },
    {
      id: 'of-failed-picks',
      label: 'F-OF T.1 · Owner · Ask for a file…: the choices could not be read (Try again); a cut-short list said',
      model: owner(files(OWN_ASKS, MAY.owner, { asks: asksState({ window: { kind: 'ask', draft: { ...newAskDraft('2026-11-25'), words: 'Pattern PDF, size 52', who: 'PERSON' } }, choices: { ...asksState().choices, people: { state: 'failed', items: [] }, truncated: true } }) })),
    },
    { id: 'of-ask-designer', label: 'F-OF T.1 · Owner · Ask for a file… of a person — the Factory designer, Line 1, due 25 Nov (S3: the designer may be asked)', model: owner(files(OWN_ASKS, MAY.owner, { asks: asksState({ window: { kind: 'ask', draft: { ...newAskDraft('2026-11-25'), words: 'Pattern PDF, size 52, with seam allowances', who: 'PERSON', pick: 'user-designer', where: 'SALES_ORDER_LINE', lineId: 'line-1' } }, choices: { ...asksState().choices, people: { state: 'ready', items: [{ id: 'user-carlo', name: 'Carlo Prova' }, { id: 'user-designer', name: 'Paola Disegno (Factory designer)' }] } } }) })) },
    // ---- the W3 windows (F-OF-303) ----
    { id: 'of-who', label: 'F-OF T.1 · Owner · Who can see 3 files: Office only · Office and Seed Customer One (a floor file said read-only)', model: owner(files(OWN_ASKS, MAY.owner, { selected: [SIZE_SPEC.id, NOTES.id, LOGO.id], acts: acts({ kind: 'whoCanSee', items: [item(SIZE_SPEC), item(NOTES), { ...item(LOGO), visibility: ['OFFICE', 'FLOOR'] }], to: 'CUSTOMER' }) })) },
    { id: 'of-rename', label: 'F-OF T.1 · Owner · Rename Size spec: a new version with the new name (v5 keeps the old one)', model: owner(files(OWN_ASKS, MAY.owner, { acts: acts({ kind: 'rename', items: [item(SIZE_SPEC)], name: 'Size spec SEED-JKT-02 final.pdf' }) })) },
    { id: 'of-delete', label: 'F-OF T.1 · Owner · Delete “Size spec” and its 5 versions? — why (required), cannot be undone', model: owner(files(OWN_ASKS, MAY.owner, { acts: acts({ kind: 'delete', items: [item(SIZE_SPEC)], reason: 'Wrong customer’s spec' }) })) },
    { id: 'of-delete-refused', label: 'F-OF T.1 · Owner · Delete refused in the server’s words (a legal hold)', model: owner(files(OWN_ASKS, MAY.owner, { acts: acts({ kind: 'delete', items: [item(NOTES)], reason: 'Duplicate' }, { problem: { key: 'acts.problem.words', params: { detail: 'A legal hold keeps this document: nothing was deleted.' } } }) })) },
    { id: 'of-version', label: 'F-OF T.1 · Owner · New version of Size spec: one file dropped, the name kept → Add as v6', model: owner(files(OWN_ASKS, MAY.owner, { acts: acts({ kind: 'newVersion', items: [item(SIZE_SPEC)], file: { name: 'Size spec SEED-JKT-02 rev6.pdf', sizeBytes: 204_800 }, keepName: true }) })) },
    { id: 'of-priced', label: 'F-OF T.1 · Owner · Mark Office notes as priced? — the floor stops seeing it', model: owner(files(OWN_ASKS, MAY.owner, { acts: acts({ kind: 'priced', items: [item(NOTES)], priced: true }) })) },
    { id: 'of-notice', label: 'F-OF T.1 · Owner · After an act: one notice on the body ("Deleted, with every version.")', model: owner(files(OWN_ASKS, MAY.owner, { acts: acts(null, { notice: { ns: 'record-thread-files-view', key: 'acts.done.deleted', params: { count: 1 }, tone: 'success' } }) })) },
  ]
}
