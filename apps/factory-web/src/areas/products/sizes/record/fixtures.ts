import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, NOW, PREFIX } from '../../library/demo'
import { failed, ready } from '../../library/model'
import { EU_SCALE, NEW_SCALE, STYLES_ON_EU } from '../fixtures'
import { ScaleRecordView, type ScaleRecordViewModel } from './view/ScaleRecordView'

/**
 * SCR-049 a size scale — made-up data only: the EU men's scale 44–64 with chest and height per size (64 has no height
 * yet), used by four styles (its order and used codes stay), and a women's scale no style uses yet. Role cases: the
 * Owner, a product developer, quality and sales (read).
 */

const base: ScaleRecordViewModel = {
  prefix: PREFIX,
  can: canFor('owner'),
  tab: 'sizes',
  scale: { status: 'ready', value: EU_SCALE },
  styles: ready({ styles: STYLES_ON_EU, count: STYLES_ON_EU.length }),
  save: { state: 'idle', at: null },
  busy: false,
  notice: null,
  changed: null,
  refused: null,
  dialog: null,
}
const fresh: ScaleRecordViewModel = { ...base, scale: { status: 'ready', value: NEW_SCALE }, styles: ready({ styles: [], count: 0 }) }

export const designScreen = defineDesignScreen<ScaleRecordViewModel>({
  screen: 'SCR-049-scale',
  title: 'Size scale',
  view: ScaleRecordView,
  cases: [
    { id: 'sizes', label: 'Sizes with body measures (Owner)', model: base, note: 'Chest and height per size, as the PPE label prints them; 64 still lacks a height (said under the table). The order stays: styles use the scale.' },
    { id: 'sizes-new', label: 'Sizes: a scale no style uses', model: fresh, note: 'The order may change (↑ ↓); no measures yet.' },
    { id: 'sizes-quality', label: 'Sizes: quality (reads)', model: { ...base, can: canFor('quality') }, note: 'Edit held with its reason.' },
    { id: 'size-dialog', label: 'A size: label and measures', model: { ...base, dialog: { kind: 'size', sizeId: EU_SCALE.sizes[4]!.id } }, note: 'Code locked (in use); measures per point with min ≤ max; a point keeps the scale\'s unit.' },
    { id: 'size-dialog-free', label: 'A size of a new scale', model: { ...fresh, dialog: { kind: 'size', sizeId: NEW_SCALE.sizes[0]!.id } }, note: 'The code may change; add a measurement point (chest, waist …).' },
    { id: 'add-sizes', label: 'Add sizes', model: { ...base, dialog: { kind: 'add' } }, note: 'At the end or before a size (the order of a used scale stays otherwise).' },
    { id: 'rename', label: 'Rename', model: { ...base, dialog: { kind: 'rename' } }, note: 'The code stays once styles use the scale.' },
    { id: 'points', label: 'Measurement points', model: { ...base, tab: 'points' } },
    { id: 'points-none', label: 'Measurement points: none', model: { ...fresh, tab: 'points' } },
    { id: 'where-used', label: 'Where used', model: { ...base, tab: 'whereused' } },
    { id: 'where-used-none', label: 'Where used: none', model: { ...fresh, tab: 'whereused' } },
    { id: 'where-used-failed', label: 'Where used: could not load', model: { ...base, tab: 'whereused', styles: failed('problem.read.unavailable') } },
    { id: 'archived', label: 'Archived', model: { ...base, scale: { status: 'ready', value: { ...EU_SCALE, status: 'ARCHIVED' } } } },
    { id: 'archive-dialog', label: 'Archive', model: { ...base, dialog: { kind: 'archive' } } },
    { id: 'saved', label: 'Just saved', model: { ...base, save: { state: 'idle', at: NOW }, notice: { key: 'scale.notice.added', tone: 'success', params: { count: 2 } } } },
    { id: 'refused', label: 'A reorder refused', model: { ...base, save: { state: 'failed', at: null }, notice: { key: 'problem.write.state', tone: 'danger' }, refused: { key: 'problem.write.state', reload: true, paths: [], messages: ['4 style(s) use this scale: its order stays (their ranges keep it). Add sizes before a size instead.'] } } },
    { id: 'changed', label: 'Changed meanwhile', model: { ...base, changed: { at: NOW } } },
    { id: 'loading', label: 'Loading', model: { ...base, scale: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, scale: { status: 'error', problem: 'problem.read.unavailable' } } },
    { id: 'not-found', label: 'Not found', model: { ...base, scale: { status: 'notFound' } } },
    { id: 'no-permission', label: 'No access', model: { ...base, can: { ...canFor('sales'), styles: false }, scale: { status: 'forbidden' } } },
  ],
})
