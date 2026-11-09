import { defineDesignScreen } from '../design-screen'
import { DsProductLab, type DsProductLabModel } from './view/DsProductLab'

/**
 * The product parts lab (`/design/ds-product-parts`, B-W2b-207): VersionCompare, RuleBuilder, SizeColumns (with SizeFill)
 * and GarmentZoneMap in the gallery's language through `useDsLabels()`. Light and dark, 1440 and 390, Italian and English
 * are the gallery's own switches. Made-up data.
 */
export const designScreen = defineDesignScreen<DsProductLabModel>({
  screen: 'ds-product-parts',
  title: 'Product DS parts (B-W2b-207)',
  view: DsProductLab,
  cases: [
    { id: 'parts', label: 'Every part', model: {}, note: 'Everything works: Use as change note fills the note; edit the rule and save it; type, paste or clear a size value; fill a row from the base size; pick a zone.' },
    { id: 'compare-same', label: 'Compare: the same versions', model: { show: 'compare', compare: 'same' }, note: 'Nothing differs: said in words, the note held.' },
    { id: 'compare-decided', label: 'Compare: a decided change', model: { show: 'compare', compare: 'decided' }, note: 'The unchanged lines shown; the note held with the page’s reason.' },
    { id: 'rule-incomplete', label: 'Rule: a condition not finished', model: { show: 'rules', rule: 'incomplete' }, note: 'Apply held, naming the first incomplete condition.' },
    { id: 'rule-options', label: 'Rule: an option rule', model: { show: 'rules', rule: 'options' }, note: 'One of several options, yes / no, and the outcome in the preview.' },
    { id: 'rule-offline', label: 'Rule: offline', model: { show: 'rules', rule: 'offline' }, note: 'The rows stay editable; Apply held with the page’s reason.' },
    { id: 'rule-readonly', label: 'Rule: read only', model: { show: 'rules', rule: 'readonly' }, note: 'Drawn as words, not greyed inputs.' },
    { id: 'sizes-missing', label: 'Sizes: values missing', model: { show: 'sizes', sizes: 'missing' }, note: 'A missing value reads “— missing” in the error tone, never 0; fill row B from the base.' },
    { id: 'sizes-released', label: 'Sizes: a released revision', model: { show: 'sizes', sizes: 'released' }, note: 'Read only; the fill held with the reason.' },
    { id: 'zones-held', label: 'Zones: held', model: { show: 'zones', zones: 'held' }, note: 'The pin and the words only, with the reason.' },
    { id: 'zones-heat', label: 'Zones: a heat map', model: { show: 'zones', zones: 'heat' }, note: 'Marked zones in four steps with their number, and the table of zones.' },
  ],
})
