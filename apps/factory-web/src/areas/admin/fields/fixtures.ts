import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_BOX, DEMO_COMPANIES, DEMO_CUSTOMER_FIELDS, DEMO_GRADES, DEMO_NOW, DEMO_ORDER_FIELDS, DEMO_READ_AT, demoEditor } from './demo'
import { draftOfField, newDraft, newListDraft, newValueDraft, withDraft } from './model'
import { FieldsView, type FieldsViewModel } from './view/FieldsView'

/**
 * SCR-164 Admin › Platform › Fields & lists (B-W2b-431) — made-up data only (PLAN §3.1). Cases: Orders with a field of
 * every type beside the form preview, the band's Add field and its pop-up (the type gallery, a money field with its grain,
 * a select with no list yet, a refusal), a field's own dialog, rows selected with Archive · Restore · Move held with why,
 * archived fields shown, a search with no match, cells being saved and one refused, a customer's fields shared with
 * suppliers, a reader without fields.manage, Picklists (values with their look, values selected, an archived list, no
 * list yet, New list, New value, Icon and colour), loading, still loading, an error, offline, and no permission.
 */

const grains = ['price', 'cost'] as const
const BOX = DEMO_ORDER_FIELDS[0]!
const MONEY = DEMO_ORDER_FIELDS[5]!

function model(overrides: Partial<FieldsViewModel> = {}): FieldsViewModel {
  return {
    access: 'open',
    load: { status: 'ready' },
    editor: demoEditor(),
    recordType: 'ORDER',
    tab: 'fields',
    archived: false,
    listId: null,
    readAt: DEMO_READ_AT,
    now: DEMO_NOW,
    live: 'live',
    grains: [...grains],
    companies: [...DEMO_COMPANIES],
    marks: {},
    notice: null,
    busy: false,
    dialog: null,
    ...overrides,
  }
}

const reader = (overrides: Partial<FieldsViewModel> = {}) => model({ editor: demoEditor({ canManage: false }), grains: ['price'], ...overrides })
const typed = (patch: Parameters<typeof withDraft>[1]) => withDraft(newDraft('terms'), patch, new Set(grains))

export const designScreen = defineDesignScreen<FieldsViewModel>({
  screen: 'SCR-164',
  title: 'Fields & lists: custom fields and picklists per record type, the form preview, Add field to …',
  view: FieldsView,
  cases: [
    { id: 'orders', label: 'Orders: custom fields and the form preview', model: model(), note: 'Labels in Italian and English edited in place, Required and Portal switched in the row (each saves by itself), who sees each field, how many orders hold a value; Enter opens a field. The preview shows the form by section; try the controls, nothing is saved.' },
    { id: 'add-field', label: 'Add field to Orders: the type gallery', model: model({ dialog: { kind: 'field', mode: 'new', fieldId: null, draft: newDraft('packing'), fault: null } }), note: 'A picture for each type; Add field waits for a type and says so. ⌘Enter saves, Esc closes.' },
    {
      id: 'add-money',
      label: 'Add field: a money field with its grain',
      model: model({ dialog: { kind: 'field', mode: 'new', fieldId: null, draft: typed({ type: 'MONEY', labelIt: 'Prezzo di listino concordato', labelEn: 'Agreed list price', shownInPortal: true }), fault: null } }),
      note: 'A money field is seen only with its grain (the person holds price and cost; the others are held with why). A price may show in the portal, a cost never.',
    },
    {
      id: 'add-select-no-list',
      label: 'Add field: a select with no list yet',
      model: model({ editor: demoEditor({ picklists: [DEMO_GRADES] }), dialog: { kind: 'field', mode: 'new', fieldId: null, draft: typed({ type: 'SELECT', labelIt: 'Colore del filo', labelEn: 'Thread colour' }), fault: null } }),
      note: 'Every list is archived: Make a list first leads to Picklists; Add field says why it waits.',
    },
    {
      id: 'add-refused',
      label: 'Add field: refused by the API',
      model: model({ dialog: { kind: 'field', mode: 'new', fieldId: null, draft: typed({ type: 'TEXT', labelIt: 'Nota', labelEn: 'Packing note', code: 'packing_note' }), fault: 'fault.codeTaken' } }),
      note: 'The API refused the key (taken by an archived field): the refusal in words above the form; the draft stays.',
    },
    { id: 'edit-field', label: 'A field: its own dialog', model: model({ dialog: { kind: 'field', mode: 'edit', fieldId: BOX.id, draft: draftOfField(BOX), fault: null } }), note: 'Type, key, list and company are fixed (a new field changes them); labels, section, required, who sees it and the portal change; Archive keeps its 12 values.' },
    { id: 'edit-money', label: 'A money field: its own dialog', model: model({ dialog: { kind: 'field', mode: 'edit', fieldId: MONEY.id, draft: draftOfField(MONEY), fault: null } }) },
    { id: 'selected', label: 'Rows selected: the bulk actions', model: model({ selected: [DEMO_ORDER_FIELDS[1]!.id, DEMO_ORDER_FIELDS[4]!.id] }), note: 'Archive 2 and Restore; Move up and Move down wait and say why (two sections picked).' },
    { id: 'selected-one', label: 'One row selected: move it', model: model({ selected: [DEMO_ORDER_FIELDS[2]!.id] }) },
    { id: 'archived', label: 'Archived fields shown', model: model({ archived: true }), note: 'An archived field keeps its key and its values; Restore brings it back.' },
    { id: 'no-match', label: 'A search with no match', model: model({ query: 'zzz' }) },
    {
      id: 'saving',
      label: 'Cells being saved, one refused',
      model: model({ marks: { [`${DEMO_ORDER_FIELDS[1]!.id}:labelEn`]: { state: 'saving' }, [`${DEMO_ORDER_FIELDS[2]!.id}:shownInPortal`]: { state: 'saving' }, [`${DEMO_ORDER_FIELDS[3]!.id}:labelIt`]: { state: 'refused', fault: 'fault.stale' } } }),
    },
    { id: 'done', label: 'A field added', model: model({ notice: { key: 'done.added', tone: 'success', params: { field: 'Gift note' } } }) },
    { id: 'customer', label: 'Customers: fields shared with suppliers', model: model({ recordType: 'CUSTOMER', editor: demoEditor({ recordType: 'CUSTOMER', fields: DEMO_CUSTOMER_FIELDS }) }), note: 'A customer and a supplier are one party: the banner says so.' },
    { id: 'empty', label: 'Quotes: no custom field yet', model: model({ recordType: 'QUOTE', editor: demoEditor({ recordType: 'QUOTE', fields: [] }) }), note: 'Add field is the first useful action.' },
    { id: 'read-only', label: 'A reader (fields.view, no fields.manage)', model: reader(), note: 'Everything reads; Add field says why it waits; no selection, no switches.' },
    { id: 'picklists', label: 'Picklists: a list and its values', model: model({ tab: 'picklists', listId: DEMO_BOX.id }), note: 'Value, look (icon and colour), labels and description edited in place, Offered switched in the row; a value no longer offered stays on the orders that hold it.' },
    { id: 'picklists-selected', label: 'Picklists: values selected', model: model({ tab: 'picklists', listId: DEMO_BOX.id, values: { selected: [DEMO_BOX.values[0]!.id, DEMO_BOX.values[2]!.id] } }) },
    { id: 'picklist-archived', label: 'Picklists: an archived list', model: model({ tab: 'picklists', listId: DEMO_GRADES.id }) },
    { id: 'picklists-empty', label: 'Picklists: no list yet', model: model({ tab: 'picklists', editor: demoEditor({ picklists: [] }) }) },
    { id: 'picklists-read-only', label: 'Picklists: a reader', model: reader({ tab: 'picklists', listId: DEMO_BOX.id }) },
    { id: 'new-list', label: 'New list', model: model({ tab: 'picklists', listId: DEMO_BOX.id, dialog: { kind: 'list', draft: { ...newListDraft(), labelIt: 'Tipo di cucitura', labelEn: 'Stitch type', code: 'stitch_type' }, fault: null } }) },
    { id: 'new-value', label: 'New value', model: model({ tab: 'picklists', listId: DEMO_BOX.id, dialog: { kind: 'value', listId: DEMO_BOX.id, draft: { ...newValueDraft(), labelIt: 'Cartone rinforzato', labelEn: 'Strong carton', code: 'STRONG_CARTON', icon: 'shield', colour: '#0e7490' }, fault: null } }) },
    { id: 'look', label: 'Icon and colour of a value', model: model({ tab: 'picklists', listId: DEMO_BOX.id, dialog: { kind: 'look', listId: DEMO_BOX.id, valueId: DEMO_BOX.values[0]!.id }, marks: { [`${DEMO_BOX.values[0]!.id}:look`]: { state: 'saving' } } }) },
    { id: 'rename-list', label: 'Rename a list', model: model({ tab: 'picklists', listId: DEMO_BOX.id, dialog: { kind: 'rename', listId: DEMO_BOX.id, labelIt: 'Tipo di imballo', labelEn: 'Packaging type', fault: null } }) },
    { id: 'loading', label: 'Loading', model: model({ load: { status: 'loading' }, editor: null, readAt: null }) },
    { id: 'slow', label: 'Still loading', model: model({ load: { status: 'loading' }, editor: null, readAt: null, slow: true }) },
    { id: 'error', label: 'The fields could not be read', model: model({ load: { status: 'error', fault: 'fault.read' }, editor: null, readAt: null }) },
    { id: 'offline', label: 'Offline', model: model({ live: 'offline', notice: { key: 'fault.offline', tone: 'warning' } }) },
    { id: 'no-permission', label: 'No permission (no fields.view)', model: model({ access: 'refused', editor: null }) },
  ],
})
