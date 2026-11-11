import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { demoStyle, recordModel, REVISIONS } from '../../demo/fixtures'
import type { StyleRecordViewModel } from '../record-model'
import { StyleRecordView } from '../view/StyleRecordView'
import { demoAssign, demoGate, demoLifecycle, demoPrivateLabel, demoRanges, demoStyleType, demoTexts, demoWhereUsed, depthModel } from './demo/fixtures'
import { failed, ready, type StyleDepthModel } from './model'
import { depthSlots } from './slots'
// B-W2b-283 (FU1:01): the Overview's Markets, cases `w2b-283-*`.
import { MARKET_CASES } from './markets/fixtures'
import type { MarketsModel } from './markets/model'
import { MarketsCard } from './markets/view/MarketsCard'

/**
 * SCR-342 — Style › Overview & variants in depth (B-W2b-237; design products.styles rec:Style style.ov.identity,
 * style.ov.side, style.ov.matrix and pop:styles.gtin), inside the Style studio, made-up data only (./demo.ts on the
 * styles' demo jacket DEMO-JKT-01). The identity's product type, names per language and private-label mark; the side
 * panel's lifecycle with what it allows, the completeness % of the release gate and where the style is used; the matrix's
 * GTIN cell and Assign GTINs (preview, then confirm; the GS1 gate closed). Every pop-up and every state.
 */

interface Case {
  studio: StyleRecordViewModel
  depth: StyleDepthModel
  /** B-W2b-283: the Overview's Markets (absent: not drawn). */
  markets?: MarketsModel
}

const style = demoStyle()
const owner = (depth: Partial<StyleDepthModel> = {}, studio: Partial<StyleRecordViewModel> = {}): Case => ({ studio: recordModel('owner', studio), depth: depthModel('owner', depth) })
const variants = (depth: Partial<StyleDepthModel> = {}, role: 'owner' | 'sales' = 'owner'): Case => ({ studio: recordModel(role, { tab: 'variants' }), depth: depthModel(role, depth) })
const assign = (extra: Partial<StyleDepthModel['assign']>, depth: Partial<StyleDepthModel> = {}): Case =>
  variants({ dialog: { kind: 'assign' }, assign: { ranges: ready(demoRanges()), rangeId: demoRanges().ranges[0]!.id, preview: ready(demoAssign(style)), done: null, problem: null, ...extra }, ...depth })

const View = ({ model }: { model: Case }) => {
  const value = model.studio.style.status === 'ready' ? model.studio.style.value : style
  return createElement(StyleRecordView, { model: model.studio, depth: { ...depthSlots(model.depth, undefined, value.skus), markets: model.markets ? createElement(MarketsCard, { model: model.markets }) : null /* B-W2b-283 */ } })
}

const archivedStyle = { status: 'ready' as const, value: demoStyle({ status: 'ARCHIVED' }) }

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-342',
  title: 'Style › Overview & variants in depth',
  view: View,
  cases: [
    { id: 'owner', label: 'Overview (owner)', model: owner(), note: 'In production (a new revision for the spec; a draft is open, so everything may change now), the product type with a default it differs from, names in three languages plus the English name from the style, our own collection, completeness 70 % with the first open item linked, used by quotes, orders, work orders, stock, price lists, sample rounds and a certificate.' },
    { id: 'private-label', label: 'A private-label style', model: owner({ privateLabel: ready(demoPrivateLabel({ brand: true, others: true })) }), note: 'Made for a brand and sold under its name: only its people see it in the portal, it sends the declaration; other customers’ open quote and order are named.' },
    { id: 'sold-ours', label: 'Sold under our name… (pop-up)', model: owner({ privateLabel: ready(demoPrivateLabel({ brand: true })), dialog: { kind: 'soldUnderOurName', value: true } }), note: 'What changes, in words: our name on its labels, we send the declaration, the portal still offers it to the brand only.' },
    { id: 'own-held', label: 'Own collection: Sold under our name held', model: owner(), note: 'Without a brand the switch is held with why: the brand is chosen in Identity.' },
    { id: 'text-new', label: 'Add a language', model: owner({ dialog: { kind: 'text', language: null }, textDraft: { language: 'es', name: 'Chaqueta Touring Demo', shortDescription: 'Chaqueta de turismo en piel.', longDescription: '' } }), note: 'A language not written yet, its name and descriptions; ⌘↵ saves.' },
    { id: 'text-edit', label: 'Change the German names', model: owner({ dialog: { kind: 'text', language: 'de' } }), note: 'Save is held until something changes.' },
    { id: 'text-problems', label: 'Add a language: problems at their fields', model: owner({ dialog: { kind: 'text', language: null }, textDraft: { language: 'deutsch schweiz', name: '', shortDescription: 'Zwei\tSpalten', longDescription: '' } }), note: 'Not a language code; the name missing; a tab in the one-line description. Save says the first.' },
    { id: 'text-taken', label: 'Add a language: written already', model: owner({ dialog: { kind: 'text', language: null }, textDraft: { language: 'fr', name: 'Veste', shortDescription: '', longDescription: '' } }), note: 'French has its names: change them instead.' },
    { id: 'text-remove', label: 'Remove the French names', model: owner({ dialog: { kind: 'removeText', language: 'fr' } }), note: 'Says what a French reader gets instead.' },
    { id: 'text-refused', label: 'Names refused by the API', model: owner({ dialog: { kind: 'text', language: 'de' }, problem: 'text.problem.meanwhile' }), note: 'Someone changed them meanwhile: read again, said above the buttons.' },
    { id: 'names-empty', label: 'No names in other languages', model: owner({ texts: ready(demoTexts({ empty: true })) }), note: 'Every reader gets the style’s name until a language is added.' },
    { id: 'discontinued', label: 'Discontinued (blocked)', model: owner({ lifecycle: ready(demoLifecycle('DISCONTINUED', { replaced: true })), texts: ready(demoTexts({ refused: true })) }), note: 'Nothing of it changes: every kind of change held with why; names held; it may be revived (a move back asks why); the replacing style linked.' },
    { id: 'concept', label: 'Concept (edit freely)', model: owner({ lifecycle: ready(demoLifecycle('CONCEPT', { released: false })), gate: ready(demoGate()) }), note: 'Every kind of change allowed; the moves offered.' },
    { id: 'no-draft', label: 'In production, no draft open', model: owner({ lifecycle: ready(demoLifecycle('IN_PRODUCTION', { draft: false })) }, { revisionId: REVISIONS[1]!.id }), note: 'The spec needs a new revision first; names and season still change.' },
    { id: 'phase-out', label: 'Phasing out', model: owner({ lifecycle: ready(demoLifecycle('PHASE_OUT', { replaced: true })) }), note: 'Replaced by DEMO-JKT-02 (a link); Change the replacing style…' },
    { id: 'move', label: 'Move to Phasing out (pop-up)', model: owner({ dialog: { kind: 'move', to: 'PHASE_OUT' }, replacements: { query: 'evo', found: [{ id: '0190f0e2-7777-7000-8000-000000000102', code: 'DEMO-JKT-02', name: 'Giacca Touring Demo Evo' }] }, moveDraft: { reason: '', replacedById: '0190f0e2-7777-7000-8000-000000000102' } }), note: 'From → to, what the new state allows, the reason (optional forward) and the replacing style found by code or name.' },
    { id: 'move-back', label: 'Move back (the reason first)', model: owner({ lifecycle: ready(demoLifecycle('PHASE_OUT', { replaced: true })), dialog: { kind: 'move', to: 'IN_PRODUCTION' }, moveDraft: { reason: '', replacedById: null } }), note: 'A move back asks why: Move is held until it is written.' },
    { id: 'move-refused', label: 'Into production without a released revision', model: owner({ lifecycle: ready(demoLifecycle('APPROVED', { released: false })), dialog: { kind: 'move', to: 'IN_PRODUCTION' } }), note: 'The move held with the API’s refusal in our words.' },
    { id: 'replacement', label: 'The replacing style (pop-up)', model: owner({ lifecycle: ready(demoLifecycle('PHASE_OUT')), dialog: { kind: 'replacement' }, replacements: { query: 'evo', found: [{ id: '0190f0e2-7777-7000-8000-000000000102', code: 'DEMO-JKT-02', name: 'Giacca Touring Demo Evo' }] } }) },
    { id: 'type-missing', label: 'The type asks for fields not filled', model: owner({ type: ready(demoStyleType({ missing: ['nameI18n', 'gender'] })) }), note: 'Counted in the release check; the type links to Products › Settings.' },
    { id: 'type-none', label: 'No product type', model: owner({ type: ready(demoStyleType({ none: true })) }) },
    { id: 'type-dialog', label: 'Change the product type (pop-up)', model: owner({ dialog: { kind: 'type' } }), note: 'The types of its kind of garment its company may use; Save held until another is picked.' },
    { id: 'where-used', label: 'Where it is used (pop-up)', model: owner({ dialog: { kind: 'whereUsed', group: 'QUOTES' } }), note: 'One kind at a time, each record a link, open first; never a price.' },
    { id: 'where-used-wo', label: 'Where it is used: work orders', model: owner({ dialog: { kind: 'whereUsed', group: 'WORK_ORDERS' } }) },
    { id: 'where-used-none', label: 'Used nowhere yet', model: owner({ whereUsed: ready(demoWhereUsed({ none: true })) }) },
    { id: 'gate-ready', label: 'Completeness 100 %', model: owner({ gate: ready(demoGate({ ready: true })) }) },
    { id: 'gate-released', label: 'Score at release', model: owner({ gate: ready(demoGate({ released: true })) }, { revisionId: REVISIONS[1]!.id }), note: 'A released revision shows the score stored at its release.' },
    { id: 'production', label: 'Production manager', model: { studio: recordModel('production'), depth: depthModel('production') }, note: 'Quotes, orders and price lists are not in the role: not mentioned, only "3 kinds of record are not in your role".' },
    { id: 'sales', label: 'Sales (reads only)', model: { studio: recordModel('sales'), depth: depthModel('sales') }, note: 'Move to…, Change…, Add a language and the switch held with why.' },
    { id: 'archived', label: 'Archived style', model: owner({ archived: true, lifecycle: ready(demoLifecycle('IN_PRODUCTION', { archived: true })) }, { style: archivedStyle }), note: 'Every change held: reactivate it first.' },
    { id: 'offline', label: 'Offline', model: owner({ online: false }), note: 'Every change held: it waits for the connection.' },
    { id: 'notice', label: 'After a move', model: owner({ notice: { key: 'lifecycle.notice.moved', tone: 'success', params: { state: 'IN_PRODUCTION' } } }) },
    { id: 'loading', label: 'Loading', model: owner({ lifecycle: { status: 'loading' }, type: { status: 'loading' }, texts: { status: 'loading' }, privateLabel: { status: 'loading' }, whereUsed: { status: 'loading' }, gate: { status: 'loading' } }) },
    { id: 'error', label: 'Each part failed', model: owner({ lifecycle: failed('fault.unavailable'), type: failed('fault.unavailable'), texts: failed('fault.read.forbidden'), privateLabel: failed('fault.unavailable'), whereUsed: failed('fault.unavailable'), gate: failed('fault.unavailable') }), note: 'Each part says why with Try again; the rest of the record stays usable.' },
    { id: 'variants', label: 'Colourways & sizes: the matrix', model: variants(), note: 'What the cells show: On / off, SKU, GTIN; Assign 19 GTINs…' },
    { id: 'variants-gtin', label: 'The matrix showing GTINs', model: variants({ matrixShow: 'gtin' }), note: 'A SKU switched on without a GTIN says "no GTIN".' },
    { id: 'variants-sku', label: 'The matrix showing SKU codes', model: variants({ matrixShow: 'sku' }) },
    { id: 'assign', label: 'Assign GTINs (preview)', model: assign({}), note: 'The range, the next free GTIN, what is left; per SKU the number it gets; one number passed over (on a SKU already); never reused.' },
    { id: 'assign-gate', label: 'Assign GTINs: the GS1 gate closed', model: assign({ ranges: ready(demoRanges({ closed: true })), preview: ready(demoAssign(style, { closed: true })) }), note: 'The Owner’s GS1 prefix first: the preview shows, no confirm button.' },
    { id: 'assign-short', label: 'Assign GTINs: the range runs short', model: assign({ preview: ready(demoAssign(style, { short: 2 })) }) },
    { id: 'assign-no-range', label: 'Assign GTINs: no range', model: assign({ ranges: ready(demoRanges({ none: true })), rangeId: null, preview: null }) },
    { id: 'assign-loading', label: 'Assign GTINs: reading the range', model: assign({ ranges: { status: 'loading' }, rangeId: null, preview: null }) },
    { id: 'assign-refused', label: 'Assign GTINs: refused meanwhile', model: assign({}, { problem: 'gtin.problem.again' }), note: 'The range moved meanwhile: the preview was made again.' },
    { id: 'assign-done', label: 'Assign GTINs: given', model: assign({ preview: null, done: demoAssign(style, { dryRun: false }) }) },
    { id: 'variants-sales', label: 'Colourways & sizes (sales)', model: variants({}, 'sales'), note: 'Assign GTINs held: the role does not give GTINs.' },
    // B-W2b-283 (FU1:01): the markets the style is sold in.
    ...MARKET_CASES.map((entry) => ({ id: entry.id, label: entry.label, model: { ...owner(), markets: entry.markets }, ...(entry.note ? { note: entry.note } : {}) })),
  ],
})
