import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, NOW, PREFIX } from '../../library/demo'
import { OPERATIONS, SHOULDER } from '../fixtures'
import { OperationRecordView, type OperationRecordViewModel } from './view/OperationRecordView'

/**
 * SCR-049 the operation record — made-up data only: a shoulder seam at 6.2 min used in five routings, two with other
 * minutes (a draft that may take the library value, a released one that stays frozen), an unused finishing operation.
 * Role cases: the Owner, a product developer (keeps the library and routings), quality (reads).
 */

const base: OperationRecordViewModel = {
  prefix: PREFIX,
  can: canFor('owner'),
  tab: 'definition',
  operation: { status: 'ready', value: SHOULDER },
  save: { state: 'idle', at: null },
  busy: false,
  notice: null,
  changed: null,
  refused: null,
  dialog: null,
}
const unused: OperationRecordViewModel = { ...base, operation: { status: 'ready', value: { ...OPERATIONS[4]!, instructions: null, createdAt: NOW, createdById: null, whereUsed: [] } } }

export const designScreen = defineDesignScreen<OperationRecordViewModel>({
  screen: 'SCR-049-operation',
  title: 'Operation record',
  view: OperationRecordView,
  cases: [
    { id: 'definition', label: 'Definition (Owner)', model: base, note: 'The code is frozen once a routing copied it, said under the field; names in each floor language.' },
    { id: 'definition-unused', label: 'Definition: not used yet', model: unused, note: 'The code still changes.' },
    { id: 'definition-quality', label: 'Definition: quality (reads)', model: { ...base, can: canFor('quality') }, note: 'Fields drawn as text, never greyed inputs.' },
    { id: 'minutes', label: 'Minutes', model: { ...base, tab: 'minutes' }, note: 'A new SMV goes to new routings; routings keep their own minutes.' },
    { id: 'where-used', label: 'Where used', model: { ...base, tab: 'whereused' }, note: 'Only draft steps that differ can take the library value; released and obsolete rows say why on their box.' },
    { id: 'where-used-selected', label: 'Where used: a draft selected', model: { ...base, tab: 'whereused', selected: [SHOULDER.whereUsed[0]!.stepId] }, note: 'Update 1 to the library value.' },
    { id: 'where-used-confirm', label: 'Update to the library value', model: { ...base, tab: 'whereused', selected: [SHOULDER.whereUsed[0]!.stepId], updateOpen: true }, note: 'Old → new minutes per step before the click.' },
    { id: 'where-used-developer', label: 'Where used: product developer', model: { ...base, can: canFor('developer'), tab: 'whereused', selected: [SHOULDER.whereUsed[0]!.stepId] } },
    { id: 'where-used-quality', label: 'Where used: quality (no routing right)', model: { ...base, can: canFor('quality'), tab: 'whereused', selected: [SHOULDER.whereUsed[0]!.stepId] }, note: 'The update is held: changing a routing needs product.routing.manage.' },
    { id: 'where-used-none', label: 'Where used: none', model: { ...unused, tab: 'whereused' } },
    { id: 'saved', label: 'Just saved', model: { ...base, save: { state: 'idle', at: NOW }, notice: { key: 'operation.notice.updated', tone: 'success', params: { count: 1 } } } },
    { id: 'refused', label: 'A code change refused', model: { ...base, save: { state: 'failed', at: null }, notice: { key: 'problem.write.invalid', tone: 'danger' }, refused: { key: 'problem.write.invalid', reload: false, paths: ['code'], messages: ['Routings copied the code DEMO-CUC-SPALLA: it no longer changes. Make a new operation instead.'] } } },
    { id: 'archived', label: 'Archived', model: { ...base, operation: { status: 'ready', value: { ...SHOULDER, status: 'ARCHIVED' } } } },
    { id: 'archive-dialog', label: 'Archive', model: { ...base, dialog: 'archive' } },
    { id: 'changed', label: 'Changed meanwhile', model: { ...base, changed: { at: NOW } } },
    { id: 'loading', label: 'Loading', model: { ...base, operation: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, operation: { status: 'error', problem: 'problem.read.unavailable' } } },
    { id: 'not-found', label: 'Not found', model: { ...base, operation: { status: 'notFound' } } },
    { id: 'no-permission', label: 'No access (sales)', model: { ...base, can: canFor('sales'), operation: { status: 'forbidden' } } },
  ],
})
