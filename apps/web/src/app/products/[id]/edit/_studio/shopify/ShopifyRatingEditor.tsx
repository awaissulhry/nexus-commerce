'use client'

/**
 * A rating field in the Shopify pop-up (Lane B slice B1, gap G2; docs/shopify-metafields/PLAN-2026-09-28.md §6.1).
 *
 * The scale belongs to the store's definition (`scale_min` / `scale_max`), so it is shown as a fact, never typed: before,
 * the editor had two free boxes for the scale and a typed scale was refused only on save. Only the rating is edited —
 * a number in half steps inside the scale (the stepper's − / + and the arrow keys), with the stars beside it as the cell
 * draws them. Other members of a stored value are kept as they are.
 */
import { MetafieldValue } from '@/design-system/grid'
import { Field } from '@/design-system/components'
import { NumberStepper } from '@/design-system/primitives'
import { plainNumber, shopifyJson, type ShopifyFieldDefinition } from '@nexus/shared/shopify-linked-products'
import { ShopifyCompoundEditor } from './ShopifyCompoundEditor'
import styles from './linked.module.css'

export function ShopifyRatingEditor({ definition, value, disabled, onChange }: {
  definition: Pick<ShopifyFieldDefinition, 'name' | 'type' | 'validations'>; value: string | null; disabled: boolean; onChange(value: string): void
}) {
  const rule = (name: string) => definition.validations.find(v => v.name === name)?.value ?? ''
  const scaleMin = rule('scale_min'), scaleMax = rule('scale_max')
  let object: Record<string, unknown>
  try {
    object = value === null ? {} : shopifyJson.parse(value)
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('not an object')
  } catch {
    /* A stored value that does not parse keeps the repair box, with the value preserved until it is fixed. */
    return <ShopifyCompoundEditor definition={definition} value={value} disabled={disabled} onChange={onChange} />
  }
  const low = Number(scaleMin), high = Number(scaleMax)
  const current = object.value === undefined || object.value === '' ? '' : Number(object.value)
  const set = (next: number) => {
    const rounded = Math.round(next * 100) / 100
    onChange(JSON.stringify({ ...object, value: String(rounded), scale_min: scaleMin, scale_max: scaleMax }))
  }
  const otherScale = object.scale_min !== undefined && (Number(object.scale_min) !== low || Number(object.scale_max) !== high)
  return (
    <Field label={definition.name} hint={`Scale ${plainNumber(scaleMin)} to ${plainNumber(scaleMax)}, set by the store.${otherScale ? ` This value uses another scale (${plainNumber(String(object.scale_min))} to ${plainNumber(String(object.scale_max))}); a change saves it on the store’s scale.` : ''}`}>
      <span className={styles.inline}>
        <NumberStepper size="sm" value={Number.isFinite(current) ? current : ''} min={low} max={high} step={0.5} disabled={disabled}
          onChange={set} aria-label={definition.name} decrementLabel={`Lower ${definition.name}`} incrementLabel={`Raise ${definition.name}`} />
        <MetafieldValue type="rating" raw={value} />
      </span>
    </Field>
  )
}
