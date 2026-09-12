'use client'
import { useState } from 'react'
import type { InformationField, InformationInventory } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { Field } from '@/design-system/components'
import { Button, Checkbox, Input, Select, Textarea } from '@/design-system/primitives'
import { ReferencePicker } from './ReferencePicker'
import styles from './linked.module.css'

export function ShopifyNativeEditor({ path, schema, field, value, disabled, onChange }: {
  path: string; schema: ShopifyStoreSchema; field: InformationField; value: string | null; disabled: boolean; onChange(value: string | null): void
}) {
  const [picker, setPicker] = useState(false)
  if (field.id === 'inventory') {
    let inventory: InformationInventory | null
    try { inventory = JSON.parse(value ?? 'null') } catch { inventory = null }
    if (!inventory?.locations) return <p role="status">Stocking locations are unavailable. Refresh the Shopify inventory.</p>
    if (!inventory.tracked) return <p>Enable Track quantity and synchronize it before setting inventory.</p>
    if (!inventory.locations.length) return <p>This variant is not stocked at a location. Activate a stocking location in Shopify or the inventory workspace first.</p>
    const update = (locationId: string, key: 'available' | 'onHand', text: string) => onChange(JSON.stringify({ ...inventory, locations: inventory!.locations.map(l => l.locationId === locationId ? { ...l, [key]: /^-?\d+$/.test(text) ? Number(text) : text } : l) }))
    return <div className={styles.stack}><p className={styles.hint}>Change either available or on-hand stock at each location. Shopify adjusts the related quantity automatically. This draft is applied only after synchronization review.</p>
      {inventory.locations.map(location => <div key={location.locationId} className={styles.stack}><p>{location.name}{!location.active ? ' · Inactive' : ''}</p><div className={styles.inline}>
        <Field label="Available"><Input size="sm" inputMode="numeric" disabled={disabled || !location.active} value={location.available} onChange={e => update(location.locationId, 'available', e.target.value)} /></Field>
        <Field label="On hand"><Input size="sm" inputMode="numeric" disabled={disabled || !location.active} value={location.onHand} onChange={e => update(location.locationId, 'onHand', e.target.value)} /></Field>
      </div></div>)}
    </div>
  }
  if (field.id === 'salesChannels') {
    let entries: { publicationId: string; publishDate: string | null }[]
    try { entries = JSON.parse(value ?? '[]'); if (!Array.isArray(entries)) throw new Error() }
    catch { return <Field label="Repair publication values"><Textarea disabled={disabled} value={value ?? ''} onChange={e => onChange(e.target.value)} /></Field> }
    const update = (next: typeof entries) => onChange(JSON.stringify(next.sort((a, b) => a.publicationId.localeCompare(b.publicationId))))
    return <div className={styles.stack}>{(schema.publications ?? []).map(publication => {
      const selected = entries.find(p => p.publicationId === publication.id)
      return <div key={publication.id} className={styles.stack}><Checkbox label={publication.name} checked={!!selected} disabled={disabled} onChange={e => update(e.target.checked ? [...entries, { publicationId: publication.id, publishDate: null }] : entries.filter(p => p.publicationId !== publication.id))} />
        {selected && publication.supportsFuturePublishing && <Field label={`${publication.name} schedule`} hint="UTC date and time; leave empty to publish on synchronization."><Input size="sm" type="datetime-local" disabled={disabled} value={selected.publishDate?.slice(0, 16) ?? ''} onChange={e => update(entries.map(p => p.publicationId === publication.id ? { ...p, publishDate: e.target.value ? `${e.target.value}:00.000Z` : null } : p))} /></Field>}
      </div>
    })}<p className={styles.hint}>Visibility changes only after synchronization. Product status must also allow the product to be visible.</p></div>
  }
  const enumKey = ({ status: 'status', countryCodeOfOrigin: 'country', inventoryPolicy: 'inventoryPolicy' } as Record<string, string>)[field.id]
  const choices = enumKey ? schema.native?.enums[enumKey] : field.type === 'boolean' ? [{ name: 'true', description: 'True' }, { name: 'false', description: 'False' }]
    : null
  if (choices) return <Field label={field.label}><Select size="sm" disabled={disabled} value={value ?? ''} onChange={e => onChange(e.target.value || null)}><option value="">Not set</option>
    {value && !choices.some(c => c.name === value) && <option value={value}>{value} (current)</option>}
    {choices.map(c => <option key={c.name} value={c.name}>{field.type === 'boolean' || field.type === 'inventory_policy' ? c.description : c.name}</option>)}
  </Select></Field>
  if (field.id === 'category') return <div className={styles.stack}><p>{value ?? 'No category'}</p><Button size="sm" disabled={disabled} onClick={() => setPicker(true)}>Choose category</Button>
    <p className={styles.hint}>Existing category metafields are preserved. Shopify will reject a category that conflicts with them.</p>
    {picker && <ReferencePicker path={path} schema={schema} type="taxonomy_category" onClose={() => setPicker(false)} onChoose={item => { onChange(item.id); setPicker(false) }} />}</div>
  if (field.id === 'weight' || field.id === 'unitPriceMeasurement') {
    let object: Record<string, unknown>
    try { object = value === null ? {} : JSON.parse(value); if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error() }
    catch { return <Field label={`Repair ${field.label}`}><Textarea rows={3} disabled={disabled} value={value ?? ''} onChange={e => onChange(e.target.value)} /></Field> }
    const unitChoices = schema.native?.enums[field.id === 'weight' ? 'weight' : 'unitPrice'] ?? []
    const weight = field.id === 'weight'
    const current: Record<string, unknown> = { ...(weight ? { value: '', unit: '' } : { quantityValue: '', quantityUnit: '', referenceValue: '', referenceUnit: '' }), ...object }
    const update = (key: string, raw: string, numeric: boolean) => onChange(JSON.stringify({ ...current, [key]: numeric && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw }))
    return <div className={styles.stack}>{(weight ? [['value', 'Weight', 'unit', 'Unit']] : [['quantityValue', 'Quantity', 'quantityUnit', 'Quantity unit'], ['referenceValue', 'Reference quantity', 'referenceUnit', 'Reference unit']]).map(([key, label, unit, unitLabel]) => <div key={key} className={styles.inline}>
      <Field label={label}><Input size="sm" inputMode="decimal" value={String(current[key])} disabled={disabled} onChange={e => update(key, e.target.value, true)} /></Field>
      <Field label={unitLabel}><Select size="sm" value={String(current[unit])} disabled={disabled} onChange={e => update(unit, e.target.value, false)}><option value="">Choose unit</option>
        {!!current[unit] && !unitChoices.some(c => c.name === current[unit]) && <option value={String(current[unit])}>{String(current[unit])} (current)</option>}
        {unitChoices.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
      </Select></Field></div>)}</div>
  }
  const hint = field.id === 'handle' ? 'The old URL will redirect to the new handle. Shopify is checked for collisions before synchronization.'
    : field.id === 'templateSuffix' ? 'Use the suffix of a product template in this store’s theme. Empty selects the default template.'
    : field.type === 'money' ? schema.currency : undefined
  return <Field label={field.label} hint={hint}>{field.type === 'multi_line_text_field'
    ? <Textarea rows={5} disabled={disabled} value={value ?? ''} onChange={e => onChange(e.target.value)} />
    : <Input size="sm" disabled={disabled} value={value ?? ''} inputMode={field.type === 'money' ? 'decimal' : undefined} onChange={e => onChange(e.target.value)} />}</Field>
}
