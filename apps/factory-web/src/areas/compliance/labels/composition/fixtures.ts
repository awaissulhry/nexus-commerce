import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { PREFIX, JACKET_R2 } from '../demo'
import { demoTextile } from '../depth/demo'
import { CompositionPart, type CompositionPartModel } from './CompositionPart'

/**
 * SCR-331 Style › Compliance › Composition computed from the BOM (B-W2b-270, a new id for the part the style's Compliance
 * tab SCR-045 shows; the coverage item products.styles/rec:Style/style.compliance/style.cp.label#2) — made-up data only:
 * the touring jacket's revision 2 in size 52 (outer fabric 80/20 by weight, lining one material, padding without a weight).
 */

const checks = demoTextile()
const base: CompositionPartModel = { read: { status: 'ready', value: checks }, prefix: PREFIX, labelId: JACKET_R2.id }

export const designScreen = defineDesignScreen<CompositionPartModel>({
  screen: 'SCR-331',
  title: 'Style composition from the BOM',
  view: CompositionPart,
  part: true,
  cases: [
    { id: 'computed', label: 'Computed: two parts, one weight missing', model: base, note: 'Official names in the page’s language; the padding is named as not computed; textile share 82.4 % applies.' },
    {
      id: 'two-groups',
      label: 'Colourways that differ',
      model: {
        ...base,
        read: {
          status: 'ready',
          value: {
            ...checks,
            composition: [
              { ...checks.composition[0]!, colourways: ['NER'] },
              { colourways: ['GRI'], parts: [{ ...checks.composition[0]!.parts[0]!, fibres: [{ fibre: 'polyamide', annex: true, percent: '100', names: { en: 'polyamide', it: 'poliammide' } }], basis: 'ONE_COMPOSITION' }], findings: [] },
            ],
          },
        },
      },
    },
    { id: 'no-label', label: 'The revision names no label', model: { ...base, labelId: null, read: { status: 'ready', value: { ...checks, label: null } } } },
    { id: 'no-textile', label: 'No textile part yet', model: { ...base, read: { status: 'ready', value: { ...checks, composition: [], textileShare: [] } } } },
    { id: 'loading', label: 'Being computed', model: { ...base, read: { status: 'loading' } } },
    { id: 'error', label: 'Could not compute', model: { ...base, read: { status: 'error', problem: 'problem.unavailable' } }, note: 'The card says what failed; the rest of the tab stays usable.' },
    { id: 'no-permission', label: 'No compliance access: hidden', model: { ...base, read: { status: 'idle' } }, note: 'A person without compliance.certificates.view never reads it: the card is absent.' },
  ],
})
