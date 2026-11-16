import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { PackagingDefault, PackagingType } from './api'
import { typeFormOf, type PackagingModel } from './model'
import { PackagingView } from './view/PackagingView'

/**
 * SCR-657 — Carriers & shipping › Packaging (B-W2b-412 on B-W2b-384; design warehouse.shipping sec sp-packaging). Made-up data
 * only (types "Cartone Demo 60", "Scatola Demo piccola", "Bancale Demo EUR"; style DEMO-JKT-01, scale DEMO-EU).
 */

const uid = (n: number) => `0190f0e2-7423-7000-8000-${String(n).padStart(12, '0')}`

const type = (n: number, over: Partial<PackagingType> = {}): PackagingType => ({ id: uid(n), companyId: uid(9), kind: 'CARTON', name: 'Cartone Demo 60', innerLengthCm: '60.00', innerWidthCm: '40.00', innerHeightCm: '30.00', tareKg: '0.4500', maxWeightKg: '25.0000', palletKind: null, active: true, version: 2, updatedAt: '2026-11-12T09:00:00.000Z', ...over })
const TYPES = [type(1), type(2, { kind: 'BOX', name: 'Scatola Demo piccola', innerLengthCm: '35.00', innerWidthCm: '25.00', innerHeightCm: '12.00', tareKg: '0.1500', maxWeightKg: '8.0000' }), type(3, { kind: 'PALLET', name: 'Bancale Demo EUR', innerLengthCm: '120.00', innerWidthCm: '80.00', innerHeightCm: '14.40', tareKg: '25.0000', maxWeightKg: '1000.0000', palletKind: 'EUR' }), type(4, { name: 'Cartone Demo vecchio', active: false })]
const COSTED = TYPES.map((entry, index) => ({ ...entry, cost: index === 0 ? { perUnit: '1.250000', currency: 'EUR' } : null }))

const def = (n: number, over: Partial<PackagingDefault> = {}): PackagingDefault => ({ id: uid(100 + n), kind: 'CARTON', packagingTypeId: uid(1), packagingTypeName: 'Cartone Demo 60', style: { code: 'DEMO-JKT-01', name: 'Giacca moto Demo' }, sizeScale: null, fromSize: null, toSize: null, active: true, version: 1, ...over })
const DEFAULTS = [def(1), def(2, { style: null, sizeScale: { code: 'DEMO-EU', name: 'Taglie Demo EU' }, fromSize: '44', toSize: '50', packagingTypeId: uid(2), packagingTypeName: 'Scatola Demo piccola', kind: 'BOX' })]

const model = (over: Partial<PackagingModel> = {}): PackagingModel => ({ types: { state: 'ready', value: TYPES }, defaults: { state: 'ready', value: DEFAULTS }, can: { settingsView: true, packaging: true, cost: false }, dialog: null, picks: null, busy: false, problem: null, done: null, ...over })

export const designScreen = defineDesignScreen<PackagingModel>({
  screen: 'SCR-657',
  title: 'Carriers & shipping › Packaging: carton, box and pallet types, the defaults per style or size run',
  view: PackagingView,
  cases: [
    { id: 'types', label: 'The types (one switched off) and the defaults per style or size run; no cost without the cost grain', model: model() },
    { id: 'selected', label: 'Two types picked: Switch off 2', model: model({ selected: [uid(1), uid(2)] }) },
    { id: 'cost', label: 'With the cost grain: the cost per unit', model: model({ types: { state: 'ready', value: COSTED }, can: { settingsView: true, packaging: true, cost: true } }) },
    { id: 'add', label: 'Add a type: a pallet with its kind', model: model({ dialog: { kind: 'type', typeId: null, form: { ...typeFormOf(null, 'PALLET'), name: 'Bancale Demo leggero' }, tried: false } }) },
    { id: 'problems', label: 'Create pressed with problems: two sizes of three, the most weight below its own weight', model: model({ dialog: { kind: 'type', typeId: null, form: { ...typeFormOf(null), name: '', length: '60', width: '40', tare: '2', maxWeight: '1' }, tried: true } }) },
    { id: 'edit', label: 'Edit a type (its kind fixed)', model: model({ dialog: { kind: 'type', typeId: uid(1), form: typeFormOf(TYPES[0]!), tried: false } }) },
    { id: 'default', label: 'Add a default: the type, a style or a size run', model: model({ dialog: { kind: 'default', form: { packagingTypeId: uid(1), styleId: '', sizeScaleId: uid(201), fromSize: '46', toSize: '52' } }, picks: { state: 'ready', value: { styles: [{ id: uid(301), code: 'DEMO-JKT-01', name: 'Giacca moto Demo' }], scales: [{ id: uid(201), code: 'DEMO-EU', name: 'Taglie Demo EU' }] } } }) },
    { id: 'switch-off', label: 'Switch off 2 types: never deleted', model: model({ dialog: { kind: 'active', target: 'types', ids: [uid(1), uid(2)], active: false } }) },
    { id: 'refused', label: 'Refused: a type of that name exists', model: model({ dialog: { kind: 'type', typeId: null, form: { ...typeFormOf(null), name: 'Cartone Demo 60' }, tried: false }, problem: { key: 'packaging.refused.name' } }) },
    { id: 'none', label: 'No packaging yet', model: model({ types: { state: 'ready', value: [] }, defaults: { state: 'ready', value: [] } }) },
    { id: 'read-only', label: 'Without shipping.packaging.manage: every write held with why', model: model({ can: { settingsView: true, packaging: false, cost: false } }) },
    // B-W2b-GF6 (on B-W2b-F56): the card is read with shipping.settings.view, as the page (the administrator reads it as in
    // `read-only`); a role without that right is told so and nothing is read.
    { id: 'no-view', label: 'Without shipping.settings.view: the card says so and nothing is read', model: model({ can: { settingsView: false, packaging: false, cost: false }, types: { state: 'loading' }, defaults: { state: 'loading' } }) },
    { id: 'loading', label: 'Reading', model: model({ types: { state: 'loading' }, defaults: { state: 'loading' } }) },
    { id: 'error', label: 'Could not be read: Try again', model: model({ types: { state: 'error', problem: { key: 'problem.read.unavailable' } }, defaults: { state: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})
