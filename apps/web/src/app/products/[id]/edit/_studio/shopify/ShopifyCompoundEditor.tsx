'use client'
import { shopifyMeasurementUnits, shopifyJson, type ShopifyFieldDefinition } from '@nexus/shared/shopify-linked-products'
import { Field } from '@/design-system/components'
import { Input, Select, Textarea } from '@/design-system/primitives'
import styles from './linked.module.css'

/** Edit only declared members. Unknown metadata survives every individual input change. */
export function ShopifyCompoundEditor({ definition, value, disabled, currency, onChange }: {
  definition: Pick<ShopifyFieldDefinition, 'name' | 'type' | 'validations'>; value: string | null; disabled: boolean; currency?: string
  onChange(value: string): void
}) {
  const { type, name, validations } = definition
  let object: Record<string, unknown>
  try {
    object = value === null ? {} : shopifyJson.parse(value)
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error()
  } catch { return <Field label={`Repair ${name}`} hint="The existing value is preserved until you correct its structure."><Textarea rows={3} disabled={disabled} value={value ?? ''} onChange={e => onChange(e.target.value)} /></Field> }
  const rules = Object.fromEntries(validations.map(rule => [rule.name, rule.value]))
  const units = shopifyMeasurementUnits[type]
  const initial = units ? { value: '', unit: units[0] } : type === 'money' ? { amount: '', currency_code: currency ?? '' }
    : type === 'rating' ? { value: '', scale_min: rules.scale_min ?? '', scale_max: rules.scale_max ?? '' } : { text: '', url: '' }
  const current: Record<string, unknown> = { ...initial, ...object }
  const update = (key: string, raw: string) => onChange(shopifyJson.stringify({ ...current, [key]: units && key === 'value' && /^-?\d+(\.\d+)?$/.test(raw) ? shopifyJson.parse(raw) : raw }))
  const input = (key: string, label: string, numeric = false) => <Field key={key} label={label}><Input size="sm" disabled={disabled} value={String(current[key] ?? '')} inputMode={numeric ? 'decimal' : undefined} onChange={e => update(key, e.target.value)} /></Field>
  return <div className={styles.stack}>
    {units ? <div className={styles.inline}>{input('value', name, true)}<Field label="Unit"><Select size="sm" disabled={disabled} value={String(current.unit)} onChange={e => update('unit', e.target.value)}>
      {!units.includes(String(current.unit)) && <option value={String(current.unit)}>{String(current.unit)} (current)</option>}
      {units.map(unit => <option key={unit} value={unit}>{unit.replace(/_/g, ' ')}</option>)}
    </Select></Field></div> : type === 'money' ? <div className={styles.inline}>{input('amount', 'Amount', true)}{input('currency_code', 'Currency')}</div>
      : type === 'rating' ? <>{input('value', 'Rating', true)}<div className={styles.inline}>{input('scale_min', 'Scale minimum', true)}{input('scale_max', 'Scale maximum', true)}</div></>
      : <>{input('text', 'Link text')}{input('url', 'URL')}</>}
  </div>
}
