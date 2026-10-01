import type { InformationField } from '@nexus/shared/shopify-information'

/**
 * Which Shopify columns take the sheet's "Set every row…" (lane01, Plan A part 2): store metafields of a plain scalar
 * type, editable in this store. Everything else — lists, references, JSON, money, ratings, native fields (media,
 * inventory, category, identity) and read-only store fields — keeps its own editor; a column Reset still works for them.
 * The value a Set writes is the exact Shopify wire string (`'true'` / `'false'` for a boolean, the typed text otherwise).
 */
const SCALAR: Record<string, { kind: string; options?: string[]; optionLabels?: Record<string, string> }> = {
  single_line_text_field: { kind: 'text' },
  multi_line_text_field: { kind: 'longtext' },
  number_integer: { kind: 'number' },
  number_decimal: { kind: 'number' },
  boolean: { kind: 'boolean', options: ['true', 'false'], optionLabels: { true: 'Yes', false: 'No' } },
}

export function shopifyColumnControl(shopifyField: unknown): { settable: boolean; kind?: string; options?: string[]; optionLabels?: Record<string, string> } {
  const field = shopifyField as Partial<InformationField> | null | undefined
  const definition = field?.definition
  const scalar = definition && !field.reason && field.editor !== 'unavailable' && field.cardinality === 'scalar' && definition.type === field.type ? SCALAR[definition.type] : undefined
  return scalar ? { settable: true, ...scalar } : { settable: false }
}
