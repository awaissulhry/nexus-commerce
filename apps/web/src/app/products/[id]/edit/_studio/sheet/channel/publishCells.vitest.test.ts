/**
 * Build shape v2, P8 — the channel sheet's Status and Action cells: what a cell shows from the stored values, what a
 * pasted, filled, typed or deleted value means (and the refusals: "Pause is a Status: use the Status column"), the
 * editors' options, and the Last publish card's link into the history.
 */
import { describe, expect, it } from 'vitest'
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import { parseHistoryDeepLink } from '@/app/products/_publication/history/runActions'
import {
  ENDED_NEEDS_DELETE, STATUS_COLUMN, STATUS_NOT_LISTED, currentStatusTarget, parseStatusInput, statusCellText, statusCellValue, statusColumn,
  statusEditorChoices, statusSheetColumn,
} from './statusColumn'
import { ACTION_COLUMN, ACTION_NOT_LISTED, DELETE_NEEDS_DELETE, actionCellText, actionCellValue, actionColumn, actionEditorChoices, actionEditorValue,
  parseSendInput } from './actionColumn'
import { publishHistorySearch } from './publishColumn'
import { CellSaveTracker, publishActionModel, sellingStatusModel } from '@/design-system/grid'
import { actionMenuEntries } from './channelActions'

const T0 = '2026-10-04T08:00:00.000Z'
const read = { loaded: true, failed: false, lockedReason: null }

function cell(over: Partial<PublishActionCell> = {}): PublishActionCell {
  return {
    listingId: 'l1', productId: 'p1', sku: 'GALE-M', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '',
    state: 'active', stateReason: null,
    send: { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    status: { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null },
    sendOptions: [
      { mode: 'partial', offered: true, reason: null, warning: null },
      { mode: 'full', offered: true, reason: null, warning: 'Every field Nexus manages is sent again.' },
      { mode: 'delete', offered: true, reason: null, warning: null },
    ],
    statusOptions: [
      { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null },
      { target: 'inactive', offered: true, action: 'pause', reason: null, warning: 'Amazon runs this offer (FBA).', checkedAtSend: null },
      { target: 'ended', offered: true, action: 'end', reason: null, warning: null, checkedAtSend: null },
    ],
    ...over,
  }
}

describe('paste, fill, type and Delete — what a cell received', () => {
  it('Status: the words a person types or pastes, the editor\'s keys, another Status cell (fill), Delete = no change', () => {
    expect(parseStatusInput('inactive')).toEqual({ change: { column: 'status', target: 'inactive' } })
    expect(parseStatusInput('Pause')).toEqual({ change: { column: 'status', target: 'inactive' } })
    expect(parseStatusInput(' relist ')).toEqual({ change: { column: 'status', target: 'active' } })
    expect(parseStatusInput('End listing')).toEqual({ change: { column: 'status', target: 'ended' } })
    expect(parseStatusInput(null)).toEqual({ change: { column: 'status', target: null } })
    expect(parseStatusInput('')).toEqual({ change: { column: 'status', target: null } })
    // Filled from a Status cell: its waiting target, else the state it shows.
    expect(parseStatusInput({ state: 'active', waiting: { target: 'ended', setAt: T0, setByName: 'A' } })).toEqual({ change: { column: 'status', target: 'ended' } })
    expect(parseStatusInput({ state: 'paused' })).toEqual({ change: { column: 'status', target: 'inactive' } })
  })

  it('Status refuses what is not a Status, and says where an Action belongs', () => {
    expect(parseStatusInput('Full update')).toEqual({ refused: 'Full update is an Action: use the Action column' })
    expect(parseStatusInput('Draft')).toEqual({ refused: '"Draft" is not a Status. Choose Active, Inactive or Ended' })
    expect(parseStatusInput({ state: 'mixed' })).toEqual({ refused: 'Mixed is not a Status you can set. Choose Active, Inactive or Ended' })
    expect(parseStatusInput({ mode: 'full' })).toEqual({ refused: 'An Action is not a Status: use the Action column' })
  })

  it('🔴 Action: pasting "pause" is refused — "Pause is a Status: use the Status column"', () => {
    expect(parseSendInput('pause')).toEqual({ refused: 'Pause is a Status: use the Status column' })
    expect(parseSendInput('Inactive')).toEqual({ refused: 'Inactive is a Status: use the Status column' })
    expect(parseSendInput({ state: 'active' })).toEqual({ refused: 'A Status is not an Action: use the Status column' })
    expect(parseSendInput('maybe')).toEqual({ refused: '"maybe" is not an Action. Choose Partial update, Full update or Delete' })
  })

  it('Action: its words and keys, another Action cell (fill), Delete = Partial update', () => {
    expect(parseSendInput('partial_update')).toEqual({ change: { column: 'send', mode: 'partial' } })
    expect(parseSendInput('Full update')).toEqual({ change: { column: 'send', mode: 'full' } })
    expect(parseSendInput('delete')).toEqual({ change: { column: 'send', mode: 'delete' } })
    expect(parseSendInput({ mode: 'delete', setAt: T0 })).toEqual({ change: { column: 'send', mode: 'delete' } })
    expect(parseSendInput(null)).toEqual({ change: { column: 'send', mode: 'partial' } })
  })
})

describe('what the cells show', () => {
  it('a skeleton until the read answers; a row with no listing is Not listed (read-only); a waiting value with who and when', () => {
    expect(statusCellValue(cell(), { ...read, loaded: false })).toBeUndefined()
    expect(statusCellValue(null, read)).toEqual({ state: 'not_listed', reason: STATUS_NOT_LISTED })
    expect(statusCellValue(cell({ status: { target: 'inactive', setAt: T0, setById: 'u', setByName: 'Awais', noLongerApplies: null } }), read))
      .toEqual({ state: 'active', reason: null, waiting: { target: 'inactive', setAt: T0, setByName: 'Awais' }, lockedReason: null })
    expect(actionCellValue(null, read)).toEqual({ mode: 'partial', lockedReason: ACTION_NOT_LISTED })
    expect(actionCellValue(cell({ send: { mode: 'delete', setAt: T0, setById: 'u', setByName: 'Awais', noLongerApplies: null } }), { ...read, lockedReason: 'No role.' }))
      .toEqual({ mode: 'delete', setAt: T0, setByName: 'Awais', lockedReason: 'No role.' })
  })

  it('a waiting value the listing outgrew says so in the cell\'s reason', () => {
    const value = statusCellValue(cell({ state: 'ended', status: { target: 'inactive', setAt: T0, setById: 'u', setByName: 'A', noLongerApplies: 'Ended on eBay' } }), read)
    expect(value?.reason).toBe('The waiting change to Inactive no longer applies: Ended on eBay. Publish skips it.')
  })

  it('copies as the word it shows: the waiting target, else the live state', () => {
    expect(statusCellText({ state: 'active', waiting: { target: 'inactive', setAt: T0, setByName: null } })).toBe('Inactive')
    expect(statusCellText({ state: 'paused' })).toBe('Inactive')
    expect(statusCellText({ state: 'not_listed' })).toBe('Not listed')
  })

  it('the editor opens on the waiting target, else the state\'s own', () => {
    expect(currentStatusTarget(cell({ state: 'paused' }))).toBe('inactive')
    expect(currentStatusTarget(cell({ status: { target: 'ended', setAt: T0, setById: null, setByName: null, noLongerApplies: null } }))).toBe('ended')
    expect(currentStatusTarget(cell({ state: 'mixed' }))).toBeNull()
  })

  it('Ended and Delete are held without products.delete; the FBA warning stays the option\'s note', () => {
    const status = statusEditorChoices(cell(), false)
    expect(status.find(o => o.value === 'ended')).toMatchObject({ heldReason: ENDED_NEEDS_DELETE })
    expect(status.find(o => o.value === 'inactive')).toMatchObject({ note: 'Amazon runs this offer (FBA).' })
    expect(statusEditorChoices(cell(), true).find(o => o.value === 'ended')!.heldReason).toBeUndefined()
    expect(actionEditorChoices(cell(), false).find(o => o.value === 'delete')).toMatchObject({ heldReason: DELETE_NEEDS_DELETE, group: 'Remove' })
  })
})

describe('the two columns', () => {
  const tracker = new CellSaveTracker()
  const inputs: unknown[] = []
  const shared = { cell: () => cell(), read: () => read, canDelete: () => true, tracker, rowIdOf: (row: { id: string }) => row.id }
  const status = statusColumn<{ id: string }>({ ...shared, onInput: (row, input) => inputs.push(['status', row.id, input]) })
  const action = actionColumn<{ id: string }>({ ...shared, onInput: (row, input) => inputs.push(['send', row.id, input]) })

  it('never write the row: the value setter stages the input and tells AG nothing changed', () => {
    const setter = status.valueSetter as (p: unknown) => boolean
    expect(setter({ data: { id: 'r1' }, newValue: 'Pause' })).toBe(false)
    expect((action.valueSetter as (p: unknown) => boolean)({ data: { id: 'r1' }, newValue: 'pause' })).toBe(false)
    expect(inputs).toEqual([
      ['status', 'r1', { change: { column: 'status', target: 'inactive' } }],
      ['send', 'r1', { refused: 'Pause is a Status: use the Status column' }],
    ])
  })

  it('sit in the Publish group, unpinned, and keep AG\'s own Delete off (the sheet resets instead)', () => {
    expect([status.colId, action.colId]).toEqual([STATUS_COLUMN, ACTION_COLUMN])
    expect(status.pinned).toBeUndefined()
    expect(statusSheetColumn<{ group: string; managedBy: string }>()).toMatchObject({ group: 'Publish', managedBy: 'progress' })
    const suppress = status.suppressKeyboardEvent as (p: unknown) => boolean
    expect(suppress({ event: { key: 'Delete' }, editing: false })).toBe(true)
    expect(suppress({ event: { key: 'Enter' }, editing: false })).toBe(false)
  })

  it('open the editor on the cell\'s own value (the cell value is an object)', () => {
    const params = (status.cellEditorParams as (p: unknown) => { value: unknown; options: unknown[] })({ data: { id: 'r1' } })
    expect(params.value).toBe('active')
    expect(params.options).toHaveLength(3)
    expect((action.cellEditorParams as (p: unknown) => { value: unknown })({ data: { id: 'r1' } }).value).toBe('partial')
  })
})

describe('the Last publish card links into the history', () => {
  it('keeps the studio address and adds the Activity tab on that run and SKU', () => {
    const search = publishHistorySearch('?scope=AMAZON&market=IT&account=acc', 'pub-1', 'GALE-M')
    const params = new URLSearchParams(search)
    expect(params.get('scope')).toBe('AMAZON')
    expect(params.get('tab')).toBe('activity')
    expect(parseHistoryDeepLink(search)).toEqual({ view: 'publishes', run: 'pub-1', sku: 'GALE-M' })
    expect(new URLSearchParams(publishHistorySearch('?tab=sheet&sku=OLD', 'pub-2', null)).has('sku')).toBe(false)
  })
})

describe('delete and relist (simplify) — a row Nexus deleted is a row not on the channel', () => {
  const words = 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.'
  const deletion = { at: '2026-10-04T06:00:00.000Z', where: 'Amazon · IT', oldReference: 'B0OLD12345', relistChosenAt: null }
  const already = 'Already deleted on Amazon · IT. To keep it off, leave its Status Not listed.'
  const gone = (over: Partial<PublishActionCell> = {}) => cell({
    state: 'not_listed', stateReason: words, deleted: { ...deletion, sentence: 'Deleted on Amazon · IT on 4 Oct.' },
    create: { target: 'not_listed', source: 'default', defaultTarget: 'not_listed', noRecord: false, sentence: words },
    send: { mode: 'full', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    sendOptions: [
      { mode: 'partial', offered: false, reason: 'A new listing is always sent whole.', warning: null },
      { mode: 'full', offered: true, reason: null, warning: 'A new listing is always sent whole.' },
      { mode: 'delete', offered: false, reason: already, warning: null },
    ],
    statusOptions: [
      { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish lists it again, whole, and it sells.' },
      { target: 'inactive', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish lists it again, whole, but buyers cannot buy it yet.' },
      { target: 'not_listed', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish leaves it out: it stays deleted on the channel.' },
    ],
    ...over,
  })
  const again = () => gone({ status: { target: 'active', setAt: T0, setById: 'u', setByName: 'Awais', noLongerApplies: null },
    create: { target: 'active', source: 'own', defaultTarget: 'not_listed', noRecord: false, sentence: 'Publish lists it again, whole, and it sells.' } })

  it('Status reads Not listed with "deleted 4 Oct" and the delete\'s words; never locked; its default is Not listed', () => {
    const value = statusCellValue(gone(), read)!
    expect(value.create).toMatchObject({ target: 'not_listed', source: 'default', deleted: { on: '4 Oct' } })
    const model = sellingStatusModel(value)
    expect(model).toMatchObject({ kind: 'new', pill: { label: 'Not listed' }, aside: 'deleted 4 Oct', editable: true, locked: false, tooltip: words })
    expect(statusCellText(value)).toBe('Not listed')
    expect(currentStatusTarget(gone())).toBe('not_listed')
  })

  it('its Status editor offers the new-row choices; Active lists it again ("lists again", with who and when)', () => {
    expect(statusEditorChoices(gone(), true).map(o => [o.value, Boolean(o.heldReason)])).toEqual([['active', false], ['inactive', false], ['not_listed', false]])
    expect(parseStatusInput('Active')).toEqual({ change: { column: 'status', target: 'active' } })
    const model = sellingStatusModel(statusCellValue(again(), read))
    expect(model).toMatchObject({ aside: 'lists again', pill: { label: 'Active', glyph: 'clock' } })
    expect(model.tooltip).toMatch(/^Publish lists it again, whole, and it sells\. Set by Awais/)
  })

  it('Action reads Full update (sent whole), quiet while it is left out; Partial update and Delete are held; nothing to reset or copy', () => {
    const value = actionCellValue(gone(), read)!
    expect(value).toMatchObject({ mode: 'full', newRow: true, leftOut: true, deleted: true })
    expect(publishActionModel(value)).toMatchObject({ kind: 'new', label: 'Full update', pill: null, editable: true })
    expect(publishActionModel(value).tooltip).toMatch(/stays deleted\. Set Status to Active to list it again\.$/)
    expect(publishActionModel(actionCellValue(again(), read))).toMatchObject({ kind: 'new', pill: { label: 'Full update', glyph: 'none' } })
    expect(actionCellText(value)).toBe('Full update')
    expect(actionEditorValue(gone())).toBe('full')
    expect(actionEditorChoices(gone(), true).map(o => [o.value, o.heldReason ?? null])).toEqual([['partial', 'A new listing is always sent whole.'], ['full', null], ['delete', already]])
    // Empty, "full update" or a filled Full update change nothing on it; Delete and Partial update go to the server (refused there).
    expect(parseSendInput('', gone())).toEqual({ skip: true })
    expect(parseSendInput('full update', gone())).toEqual({ skip: true })
    expect(parseSendInput(value, cell())).toEqual({ skip: true })
    expect(parseSendInput('delete', gone())).toEqual({ change: { column: 'send', mode: 'delete' } })
    // "Deleted" and "Keep deleted" are no Action words any more.
    expect(parseSendInput('Deleted', gone())).toEqual({ refused: '"Deleted" is not an Action. Choose Partial update, Full update or Delete' })
  })
})

// ── New listings (Owner 2026-10-04) ───────────────────────────────────────────────────────────────────────────────

const CHECK = 'Nexus checks this eBay account\'s out-of-stock option when you choose Inactive and again when Publish sends.'
function newCell(over: Partial<PublishActionCell> = {}): PublishActionCell {
  return cell({
    listingId: 'new:p1:EBAY:IT:acc:', channel: 'EBAY', state: 'not_listed',
    send: { mode: 'full', setAt: null, setById: null, setByName: null, noLongerApplies: null },
    create: { target: 'active', source: 'default', defaultTarget: 'active', noRecord: true, sentence: 'Publish creates it and it sells.' },
    sendOptions: [
      { mode: 'partial', offered: false, reason: 'A new listing is always sent whole.', warning: null },
      { mode: 'full', offered: true, reason: null, warning: 'A new listing is always sent whole.' },
      { mode: 'delete', offered: false, reason: 'Nothing to delete yet. To leave it out, set Status to Not listed.', warning: null },
    ],
    statusOptions: [
      { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null, sentence: 'Publish creates it and it sells.' },
      { target: 'inactive', offered: true, action: null, reason: null, warning: null, checkedAtSend: CHECK, sentence: 'Publish creates it, but buyers cannot buy it yet.' },
      { target: 'not_listed', offered: true, action: null, reason: null, warning: 'Publish leaves the whole family out here.', checkedAtSend: null, sentence: 'Publish leaves it out.' },
    ],
    ...over,
  })
}

describe('new listings — a row not on the channel yet', () => {
  it('Status: never locked — the effective choice with the "new" mark; the editor offers Active · Inactive · Not listed with the eBay check', () => {
    const row = newCell()
    const value = statusCellValue(row, read)!
    expect(value.create).toMatchObject({ target: 'active', source: 'default' })
    const model = sellingStatusModel(value)
    expect(model).toMatchObject({ kind: 'new', editable: true, locked: false, aside: 'new' })
    expect(statusCellText(value)).toBe('Active')
    expect(currentStatusTarget(row)).toBe('active')
    const options = statusEditorChoices(row, true)
    expect(options.map(o => o.value)).toEqual(['active', 'inactive', 'not_listed'])
    expect(options[1].note).toBe(`Publish creates it, but buyers cannot buy it yet. ${CHECK}`)
    expect(options[2].note).toContain('Publish leaves the whole family out here.')
    // Inactive chosen: the eBay check rides the cell's tooltip too.
    const chosen = newCell({ status: { target: 'inactive', setAt: T0, setById: 'u1', setByName: 'Awais', noLongerApplies: null },
      create: { target: 'inactive', source: 'own', defaultTarget: 'active', noRecord: false, sentence: 'Publish creates it, but buyers cannot buy it yet.' } })
    const tip = sellingStatusModel(statusCellValue(chosen, read)).tooltip
    expect(tip).toContain(CHECK)
    expect(tip).toMatch(/Set by Awais/)
  })

  it('Action: Full update (sent whole), editable; the editor opens on it with Partial update and Delete held; quiet when Status is Not listed', () => {
    const row = newCell()
    const value = actionCellValue(row, read)!
    expect(value).toMatchObject({ mode: 'full', newRow: true, leftOut: false })
    expect(publishActionModel(value)).toMatchObject({ kind: 'new', label: 'Full update', pill: { glyph: 'none' }, editable: true })
    expect(actionCellText(value)).toBe('Full update')
    expect(actionEditorValue(row)).toBe('full')
    expect(actionEditorChoices(row, true).map(o => [o.value, Boolean(o.heldReason)])).toEqual([['partial', true], ['full', false], ['delete', true]])
    const out = newCell({ create: { target: 'not_listed', source: 'own', defaultTarget: 'active', noRecord: false, sentence: 'Publish leaves it out.' } })
    expect(publishActionModel(actionCellValue(out, read)).pill).toBeNull()
  })

  it('paste and fill: "Not listed" works; Full update on a new row is a no-op; "Create" is no word any more; Delete on it leaves it', () => {
    expect(parseStatusInput('Not listed')).toEqual({ change: { column: 'status', target: 'not_listed' } })
    expect(parseStatusInput('Create')).toEqual({ refused: '"Create" is not a Status. Choose Active, Inactive or Ended' })
    expect(parseSendInput('Full update', newCell())).toEqual({ skip: true })
    expect(parseSendInput('create')).toEqual({ refused: '"create" is not an Action. Choose Partial update, Full update or Delete' })
    expect(parseSendInput(actionCellValue(newCell(), read), cell())).toEqual({ skip: true })
    expect(parseSendInput('', newCell())).toEqual({ skip: true })
    // A filled Status from a new row copies its choice.
    expect(parseStatusInput(statusCellValue(newCell({ create: { target: 'inactive', source: 'own', defaultTarget: 'active', noRecord: false, sentence: '' } }), read)))
      .toEqual({ change: { column: 'status', target: 'inactive' } })
  })

  it('Action ▾: Not listed appears for ticked new rows; Active counts them as listings Publish creates; Ended is refused on them with a reason', () => {
    const rows = [{ sku: 'GALE', cell: newCell() }, { sku: 'GALE-M', cell: newCell({ listingId: 'new:p2:EBAY:IT:acc:' }) }, { sku: 'GALE-S', cell: cell() }]
    const entries = actionMenuEntries(rows, { publish: true, delete: true })
    expect(entries.filter(e => e.group === 'Status').map(e => e.id)).toEqual(['status:active', 'status:inactive', 'status:not_listed', 'status:ended'])
    const active = entries.find(e => e.id === 'status:active')!
    expect(active.label).toBe('Active — 3 of 3')
    expect(active.note).toBe('Includes 2 new listings: Publish creates them Active.')
    const notListed = entries.find(e => e.id === 'status:not_listed')!
    expect(notListed).toMatchObject({ allowed: 2, disabled: false })
    expect(notListed.note).toMatch(/^1 not allowed: On the channel already/)
    expect(entries.find(e => e.id === 'status:ended')!.note).toMatch(/2 not allowed: Not on the channel yet: choose Active, Inactive or Not listed\./)
    // No new row ticked: no Not listed item.
    expect(actionMenuEntries([{ sku: 'GALE-S', cell: cell() }], { publish: true, delete: true }).some(e => e.id === 'status:not_listed')).toBe(false)
  })
})
