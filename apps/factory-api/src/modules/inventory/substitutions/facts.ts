import type { ApprovalField, Facts } from '@nexus/factory-domain/approvals/rules'
import type { SubstituteKind } from '@nexus/factory-domain/inventory/substitutions/rules'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import type { AlternateUse } from '@nexus/factory-domain/product/bom-lines/rules'

/**
 * The facts an approval rule of kind MATERIAL_SUBSTITUTION may test (B-W2b-298; the RuleBuilder's fields in Admin ›
 * Automation): whether it is another lot of the line's own material or an alternate, the alternate's "when it may be used", a
 * PPE component involved, the substitute's kind and code, the line's own material, how much (the substitute's base unit), the
 * site and the reason code. No money. Shared by the kind file (platform/approvals/kinds/material-substitution.ts) and the
 * dialog's dry run ("who would approve it"), so both read the same facts.
 */

const capital = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ')
const yesNo = [
  { value: 'YES', label: { en: 'Yes', it: 'Sì' } },
  { value: 'NO', label: { en: 'No', it: 'No' } },
] as const

export const SUBSTITUTION_FIELDS: readonly ApprovalField[] = Object.freeze<ApprovalField[]>([
  {
    id: 'substituteKind',
    label: { en: 'what stands in', it: 'cosa sostituisce' },
    kind: 'choice',
    options: [
      { value: 'ALTERNATE', label: { en: 'An alternate of the BOM line', it: 'Un alternativo della riga distinta' } },
      { value: 'OWN_MATERIAL', label: { en: "Another lot of the line's own material", it: 'Un altro lotto del materiale della riga' } },
    ],
  },
  {
    id: 'allowedWhen',
    label: { en: 'when the alternate may be used', it: "quando si può usare l'alternativo" },
    kind: 'choice',
    options: [
      { value: 'ALWAYS', label: { en: 'Always', it: 'Sempre' } },
      { value: 'WHEN_SHORT', label: { en: 'Only when short', it: 'Solo se manca' } },
      { value: 'WITH_APPROVAL', label: { en: 'With approval', it: 'Con approvazione' } },
      { value: 'NONE', label: { en: 'Not an alternate', it: 'Non è un alternativo' } },
    ],
  },
  { id: 'ppeComponent', label: { en: 'a PPE component involved', it: 'componente DPI coinvolto' }, kind: 'choice', options: [...yesNo] },
  { id: 'materialKind', label: { en: "substitute's material kind", it: 'tipo di materiale sostituto' }, kind: 'choice', options: ITEM_KINDS.map((value) => ({ value, label: { en: capital(value), it: capital(value) } })) },
  { id: 'itemCode', label: { en: "substitute's code", it: 'codice del sostituto' }, kind: 'text' },
  { id: 'lineMaterialCode', label: { en: "line's own material code", it: 'codice del materiale della riga' }, kind: 'text' },
  { id: 'quantity', label: { en: 'quantity (base unit)', it: 'quantità (unità base)' }, kind: 'number', unit: null, min: 0 },
  { id: 'siteCode', label: { en: 'site code', it: 'codice sede' }, kind: 'text' },
  { id: 'reasonCode', label: { en: 'reason code', it: 'codice causale' }, kind: 'text' },
  { id: 'askedOnFloor', label: { en: 'asked on the floor', it: 'chiesto in reparto' }, kind: 'choice', options: [...yesNo] },
])

export interface SubstitutionFactsInput {
  readonly kind: SubstituteKind
  readonly allowedWhen: AlternateUse | null
  readonly ppe: boolean
  readonly materialKind: string
  readonly itemCode: string
  readonly lineMaterialCode: string
  /** The substitute's base quantity (plain decimal text). */
  readonly quantity: string
  readonly siteCode: string
  readonly reasonCode: string | null
  readonly askedOnFloor: boolean
}

export function substitutionFacts(input: SubstitutionFactsInput): Facts {
  return {
    substituteKind: input.kind,
    allowedWhen: input.kind === 'ALTERNATE' ? (input.allowedWhen ?? 'NONE') : 'NONE',
    ppeComponent: input.ppe ? 'YES' : 'NO',
    materialKind: input.materialKind,
    itemCode: input.itemCode,
    lineMaterialCode: input.lineMaterialCode,
    quantity: input.quantity,
    siteCode: input.siteCode,
    reasonCode: input.reasonCode,
    askedOnFloor: input.askedOnFloor ? 'YES' : 'NO',
  }
}
