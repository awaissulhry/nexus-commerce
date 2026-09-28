'use client'
import { ShopifyCompoundEditor } from './ShopifyCompoundEditor'
import { shopifyObjectType, shopifyTypeReason, shopifyJson, shopifyReferenceTypes, shopifyReferenceError } from '@nexus/shared/shopify-linked-products'
import { useEffect, useState } from 'react'
import { type ShopifyFieldDefinition, type ShopifyReference, type ShopifyStoreSchema, validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { DateField, Disclosure, Field, MediaMark, OrderedList } from '@/design-system/components'
import { Button, Input, Select, Textarea } from '@/design-system/primitives'
import { ShopifyRichText } from '../images/shopify/ShopifyFieldValue'
import { ReferencePicker } from './ReferencePicker'
import { ShopifyReferenceField } from './ShopifyReferenceField'
import { referenceUiFor } from './referenceFieldModel'
import { linkedEndpoint, linkedRequest } from './api'
import styles from './linked.module.css'

export function LinkedFieldEditor({ path, definition: def, value, disabled, schema, onChange, onOpenEntry, onCopyEntry, onCreateEntry }: {
  path: string; definition: ShopifyFieldDefinition; value: string | null; disabled: boolean; schema: ShopifyStoreSchema
  onChange(value: string | null): void; onOpenEntry?(id: string): void; onCopyEntry?(id: string): void
  /** "Add new entry" in an entry picker (sheet pop-up rebuild P1, D2 a). Absent ⇒ no create button. */
  onCreateEntry?(entryType: string): void
}) {
  const [picker, setPicker] = useState(false), [names, setNames] = useState<ShopifyReference[]>([]), [nameError, setNameError] = useState('')
  const [pickError, setPickError] = useState('')
  const list = def.type.startsWith('list.'), type = list ? def.type.slice(5) : def.type, reference = type.endsWith('_reference')
  let values: string[] = [], invalidList = false
  // Only structure string lists. Parsing and serializing numeric/object lists can
  // silently round decimals or turn measurements into strings.
  if (list) { try { const parsed = value === null ? [] : JSON.parse(value); if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) invalidList = true; else values = parsed } catch { invalidList = true } }
  else if (reference && value) values = [value]
  if (reference && new Set(values).size !== values.length) invalidList = true
  const identity = reference ? JSON.stringify(values) : ''
  useEffect(() => {
    if (!reference || !values.length) { setNames([]); return }
    const controller = new AbortController(); setNameError('')
    void (async () => {
      const result: ShopifyReference[] = []
      for (let i = 0; i < values.length; i += 100) result.push(...await linkedRequest<ShopifyReference[]>(linkedEndpoint(path, '/reference-names'), 'POST', { ids: values.slice(i, i + 100) }, controller.signal))
      if (!controller.signal.aborted) setNames(result)
    })().catch(e => { if (!controller.signal.aborted) setNameError(e.message) })
    return () => controller.abort()
    // Identity tracks reference values only; text typing does not issue reference lookups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, path, reference])
  const locked = disabled || !!def.readOnlyReason || !!shopifyTypeReason(def.type), error = validateShopifyField(def, value)
  const refDefinition = def.validations.find(v => v.name === 'metaobject_definition_id')?.value
  const metaobjectType = schema.metaobjectDefinitions.find(d => d.id === refDefinition)?.type
  let permittedTypes: string[] | null = null
  try { permittedTypes = shopifyReferenceTypes(def, schema) } catch { permittedTypes = [] }
  const pickerSchema = permittedTypes ? { ...schema, metaobjectDefinitions: schema.metaobjectDefinitions.filter(d => permittedTypes!.includes(d.type)) } : schema
  const text = value ?? ''
  let choices: string[] | null = null
  try { const parsed = JSON.parse(def.validations.find(v => v.name === 'choices')?.value ?? 'null'); if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) choices = parsed } catch { /* keep the raw value readable */ }
  const supportedReference = ['product_reference', 'variant_reference', 'collection_reference', 'page_reference', 'article_reference', 'file_reference', 'metaobject_reference', 'mixed_reference', 'customer_reference', 'company_reference', 'order_reference', 'disclosure_reference', 'product_taxonomy_value_reference'].includes(type)
  /* Entry and product-like fields get the picture pickers (Shopify's bulk-editor pop-ups); the rest keep the older picker. */
  const ui = reference ? referenceUiFor(def, schema) : 'legacy'
  const pictured = reference && !invalidList && ui !== 'legacy'
  let control
  if (pictured) control = <ShopifyReferenceField ui={ui} path={path} definition={def} schema={schema} values={values} names={names} namesFailed={!!nameError}
    locked={locked} onChange={next => onChange(list ? JSON.stringify(next) : next[0] ?? null)} onError={setPickError}
    onPicked={refs => setNames(old => [...old.filter(n => !refs.some(r => r.id === n.id)), ...refs])}
    onOpenEntry={onOpenEntry} onCopyEntry={onCopyEntry} onCreateEntry={onCreateEntry} />
  else if (reference && !invalidList) control = <div className={styles.stack}>
    {values.length > 0 && <OrderedList label={`${def.name} references`} items={values} disabled={locked || !list} draggable keyboardGrip itemLabel={id => names.find(n => n.id === id)?.label ?? 'Referenced item'} onChange={next => onChange(JSON.stringify(next))} renderItem={id => {
      const item = names.find(n => n.id === id)
      return <span className={styles.reference}>{item?.image && <img src={item.image} alt="" loading="lazy" />}<span>{item?.available === false ? 'Referenced entry is unavailable' : item?.label ?? (nameError ? 'Reference preview unavailable' : 'Loading reference…')}{item?.handle && <small>/{item.handle}</small>}</span>
        {id.includes('/Metaobject/') && onOpenEntry && <Button size="xs" disabled={disabled} onClick={() => onOpenEntry(id)}>Edit entry</Button>}
        {id.includes('/Metaobject/') && onCopyEntry && <Button size="xs" disabled={locked} onClick={() => onCopyEntry(id)}>Make a separate copy</Button>}
        <Button size="xs" variant="quiet" disabled={locked} aria-label={`Remove ${item?.label ?? 'reference'}`} onClick={() => onChange(list ? JSON.stringify(values.filter(v => v !== id)) : null)}>Remove</Button></span>
    }} />}
    {nameError && <p role="status">{nameError}</p>}
    {supportedReference ? <Button size="sm" disabled={locked || (!!refDefinition && !metaobjectType)} onClick={() => setPicker(true)}>{values.length && !list ? 'Replace reference' : 'Choose reference'}</Button> : <p>This reference type is preserved. A picker is not available yet.</p>}
  </div>
  else if (list && !reference) {
    let items: unknown[] | null = []
    try { items = value === null ? [] : shopifyJson.parse(value); if (!Array.isArray(items)) items = null } catch { items = null }
    const serialize = (raw: string | null): unknown => {
      if (raw === null) return ''
      if (shopifyObjectType(type)) { try { return shopifyJson.parse(raw) } catch { return raw } }
      if (type === 'number_decimal' && /^-?\d+(\.\d+)?$/.test(raw)) return shopifyJson.parse(raw)
      if (type === 'number_integer' && /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw)
      if (type === 'boolean' && ['true', 'false'].includes(raw)) return raw === 'true'
      return raw
    }
    const listItems = items
    control = listItems ? <div className={styles.stack}>
      <OrderedList label={`${def.name} values`} items={listItems.map((_, i) => String(i))} draggable keyboardGrip disabled={locked} itemLabel={id => `Value ${Number(id) + 1}`}
        onChange={ids => onChange(shopifyJson.stringify(ids.map(id => listItems[Number(id)])))} renderItem={id => {
          const i = Number(id), item = listItems[i]
          const raw = typeof item === 'object' ? shopifyJson.stringify(item) : String(item)
          const definition = { ...def, name: `${def.name} ${i + 1}`, type, validations: def.validations.filter(r => !r.name.startsWith('list.')) }
          return <div className={styles.stack}><LinkedFieldEditor path={path} schema={schema} definition={definition} value={raw} disabled={locked}
            onChange={next => onChange(shopifyJson.stringify(listItems.map((v, index) => index === i ? serialize(next) : v)))} />
            <Button size="xs" variant="quiet" disabled={locked} aria-label={`Remove ${def.name} value ${i + 1}`} onClick={() => onChange(shopifyJson.stringify(listItems.filter((_, index) => index !== i)))}>Remove value</Button></div>
        }} />
      <Button size="sm" disabled={locked} onClick={() => onChange(shopifyJson.stringify([...listItems, shopifyObjectType(type) ? {} : '']))}>Add value</Button>
    </div> : <Field label={`Repair ${def.name}`}><Textarea rows={3} disabled={locked} value={text} onChange={e => onChange(e.target.value)} /></Field>
  }
  else if (!list && shopifyObjectType(type)) control = <ShopifyCompoundEditor definition={def} value={value} currency={schema.currency} disabled={locked} onChange={onChange} />
  else if (!list && type === 'rich_text_field') control = <ShopifyRichText raw={text} disabled={locked} onChange={onChange} />
  else if (!list && (type === 'boolean' || choices)) control = <Field label={def.name}><Select size="sm" disabled={locked} value={text} onChange={e => onChange(e.target.value || null)}><option value="">Not set</option>{text && !(choices ?? ['true', 'false']).includes(text) && <option value={text}>{text} (current value)</option>}{(choices ?? ['true', 'false']).map(v => <option key={v} value={v}>{choices ? v : v === 'true' ? 'True' : 'False'}</option>)}</Select></Field>
  else if (!list && type === 'date' && !error) control = <Field label={def.name}><DateField value={text} disabled={locked} format="yyyy-mm-dd" onChange={v => onChange(v || null)} ariaLabel={def.name} /></Field>
  else if (!list && type === 'color') {
    /* Shopify's colour field: the swatch, the hex text and a colour picker — the swatch is the stored value itself. */
    const hex = /^#[0-9a-f]{6}$/i.test(text) ? text : null
    control = <Field label={def.name}><span className={styles.inline}>
      <Input size="sm" disabled={locked} value={text} placeholder="#RRGGBB" onChange={e => onChange(e.target.value || null)}
        leadingIcon={hex ? <MediaMark choice={{ swatch: hex, label: def.name }} size="chip" /> : undefined} aria-label={`${def.name} hex`} />
      <Input size="sm" type="color" disabled={locked} value={hex ?? '#000000'} onChange={e => onChange(e.target.value)} aria-label={`Pick ${def.name}`} fieldClassName={styles.colourPick} />
    </span></Field>
  }
  else if (!list && ['single_line_text_field', 'number_integer', 'number_decimal', 'url', 'date', 'date_time', 'id', 'language'].includes(type)) control = <Field label={def.name}><Input size="sm" disabled={locked} value={text} inputMode={type.startsWith('number_') ? 'decimal' : undefined} onChange={e => onChange(e.target.value)} /></Field>
  else control = <Field label={def.name} hint={type === 'multi_line_text_field' ? undefined : 'Structured Shopify value. Its fields are preserved exactly.'}><Textarea disabled={locked} rows={3} value={text} onChange={e => onChange(e.target.value)} /></Field>
  return <div className={styles.stack}>
    {control}
    {def.description && <p className={styles.hint}>{def.description}</p>}
    {def.readOnlyReason ? <p className={styles.hint}>{def.readOnlyReason}</p> : (pickError || error) && <p role="status" className={styles.validation}>{pickError || error}</p>}
    {!locked && value !== null && !pictured && <Button size="xs" variant="quiet" onClick={() => onChange(null)}>Clear value</Button>}
    {def.validations.length > 0 && !pictured && <Disclosure summary="Store validation rules"><dl>{def.validations.map(v => <div key={v.name}><dt>{v.name}</dt><dd>{v.value}</dd></div>)}</dl></Disclosure>}
    {picker && <ReferencePicker path={path} type={type} schema={pickerSchema} metaobjectType={metaobjectType} excluded={list ? values : []} onClose={() => setPicker(false)} onChoose={item => { const problem = shopifyReferenceError(def, [item], schema); if (problem) { setNameError(problem); setPicker(false); return } onChange(list ? JSON.stringify([...values, item.id]) : item.id); setNames(old => [...old.filter(n => n.id !== item.id), item]); setPicker(false) }} />}
  </div>
}
