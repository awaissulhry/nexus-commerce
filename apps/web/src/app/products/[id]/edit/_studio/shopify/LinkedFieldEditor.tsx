'use client'
import { ShopifyCompoundEditor } from './ShopifyCompoundEditor'
import { shopifyObjectType, shopifyTypeReason, shopifyJson, shopifyReferenceTypes, shopifyReferenceError, shopifyRuleSummary } from '@nexus/shared/shopify-linked-products'
import { useEffect, useState } from 'react'
import { type ShopifyFieldDefinition, type ShopifyReference, type ShopifyStoreSchema, validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { DateField, Field, MediaMark, OrderedList } from '@/design-system/components'
import { Button, Input, Select, Textarea } from '@/design-system/primitives'
import { ShopifyRichText } from '../images/shopify/ShopifyFieldValue'
import { ReferencePicker } from './ReferencePicker'
import { ShopifyReferenceField } from './ShopifyReferenceField'
import { listMax, referenceUiFor } from './referenceFieldModel'
import { linkedEditorKind } from './linkedEditorKind'
import { ShopifyRatingEditor } from './ShopifyRatingEditor'
import { linkedEndpoint, linkedRequest } from './api'
import styles from './linked.module.css'

export function LinkedFieldEditor({ path, definition: def, value, disabled, schema, onChange, onOpenEntry, onCopyEntry, onCreateEntry, nested = false }: {
  path: string; definition: ShopifyFieldDefinition; value: string | null; disabled: boolean; schema: ShopifyStoreSchema
  /** One value inside a list editor: the list states the rules once, above its values. */
  nested?: boolean
  onChange(value: string | null): void; onOpenEntry?(id: string): void; onCopyEntry?(id: string): void
  /** "Add new entry" in an entry picker (sheet pop-up rebuild P1, D2 a). Absent ⇒ no create button. */
  onCreateEntry?(entryType: string): void
}) {
  const [picker, setPicker] = useState(false), [names, setNames] = useState<ShopifyReference[]>([]), [nameError, setNameError] = useState('')
  const [pickError, setPickError] = useState('')
  const list = def.type.startsWith('list.'), type = list ? def.type.slice(5) : def.type, reference = type.endsWith('_reference')
  let values: string[] = []
  // Only structure string lists. Parsing and serializing numeric/object lists can
  // silently round decimals or turn measurements into strings. A list that does not parse gets the repair box
  // (`linkedEditorKind`).
  if (list) { try { const parsed = value === null ? [] : JSON.parse(value); if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) values = parsed } catch { /* repair box */ } }
  else if (reference && value) values = [value]
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
  /* Which editor opens is decided in one pure place (`linkedEditorKind`, tested per type). Entry and product-like fields
     get the picture pickers (Shopify's bulk-editor pop-ups); the rest keep the older picker. */
  const kind = linkedEditorKind(def, value, schema)
  const ui = reference ? referenceUiFor(def, schema) : 'legacy'
  const pictured = kind === 'entries' || kind === 'resources'
  /* The rules in plain words, once: not under each value of a list, and not under a rating (its hint states the scale). */
  const rules = nested || kind === 'rating' ? '' : shopifyRuleSummary(def, schema)
  let control
  if (pictured && ui !== 'legacy') control = <ShopifyReferenceField ui={ui} path={path} definition={def} schema={schema} values={values} names={names} namesFailed={!!nameError}
    locked={locked} onChange={next => onChange(list ? JSON.stringify(next) : next[0] ?? null)} onError={setPickError}
    onPicked={refs => setNames(old => [...old.filter(n => !refs.some(r => r.id === n.id)), ...refs])}
    onOpenEntry={onOpenEntry} onCopyEntry={onCopyEntry} onCreateEntry={onCreateEntry} />
  else if (kind === 'older-picker') control = <div className={styles.stack}>
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
  else if (kind === 'list' || kind === 'broken-list') {
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
          return <div className={styles.stack}><LinkedFieldEditor nested path={path} schema={schema} definition={definition} value={raw} disabled={locked}
            onChange={next => onChange(shopifyJson.stringify(listItems.map((v, index) => index === i ? serialize(next) : v)))} />
            <Button size="xs" variant="quiet" disabled={locked} aria-label={`Remove ${def.name} value ${i + 1}`} onClick={() => onChange(shopifyJson.stringify(listItems.filter((_, index) => index !== i)))}>Remove value</Button></div>
        }} />
      {(() => {
        const cap = listMax(def), full = cap !== null && listItems.length >= cap
        return <>
          <Button size="sm" disabled={locked || full} aria-describedby={full ? `${def.id}-list-full` : undefined} onClick={() => onChange(shopifyJson.stringify([...listItems, shopifyObjectType(type) ? {} : '']))}>Add value</Button>
          {full && !locked && <p id={`${def.id}-list-full`} className={styles.hint}>The store takes {cap} {cap === 1 ? 'value' : 'values'} at most. Remove one to add another.</p>}
        </>
      })()}
    </div> : <Field label={`Repair ${def.name}`}><Textarea rows={3} disabled={locked} value={text} onChange={e => onChange(e.target.value)} /></Field>
  }
  else if (kind === 'rating') control = <ShopifyRatingEditor definition={def} value={value} disabled={locked} onChange={onChange} />
  else if (kind === 'compound') control = <ShopifyCompoundEditor definition={def} value={value} currency={schema.currency} disabled={locked} onChange={onChange} />
  else if (kind === 'rich-text') control = <ShopifyRichText raw={text} disabled={locked} onChange={onChange} />
  else if (kind === 'yes-no' || kind === 'choices') control = <Field label={def.name}><Select size="sm" disabled={locked} value={text} onChange={e => onChange(e.target.value || null)}><option value="">Not set</option>{text && !(choices ?? ['true', 'false']).includes(text) && <option value={text}>{text} (current value)</option>}{(choices ?? ['true', 'false']).map(v => <option key={v} value={v}>{choices ? v : v === 'true' ? 'Yes' : 'No'}</option>)}</Select></Field>
  else if (kind === 'date') control = <Field label={def.name}><DateField value={text} disabled={locked} format="yyyy-mm-dd" onChange={v => onChange(v || null)} ariaLabel={def.name} /></Field>
  else if (kind === 'colour') {
    /* Shopify's colour field: the swatch, the hex text and a colour picker — the swatch is the stored value itself. */
    const hex = /^#[0-9a-f]{6}$/i.test(text) ? text : null
    control = <Field label={def.name}><span className={styles.inline}>
      <Input size="sm" disabled={locked} value={text} placeholder="#RRGGBB" onChange={e => onChange(e.target.value || null)}
        leadingIcon={hex ? <MediaMark choice={{ swatch: hex, label: def.name }} size="chip" /> : undefined} aria-label={`${def.name} hex`} />
      <Input size="sm" type="color" disabled={locked} value={hex ?? '#000000'} onChange={e => onChange(e.target.value)} aria-label={`Pick ${def.name}`} fieldClassName={styles.colourPick} />
    </span></Field>
  }
  else if (kind === 'line') control = <Field label={def.name}><Input size="sm" disabled={locked} value={text} inputMode={type.startsWith('number_') ? 'decimal' : undefined} onChange={e => onChange(e.target.value)} /></Field>
  else if (kind === 'multi-line') control = <Field label={def.name} hint="Enter adds a line · Ctrl+Enter (⌘+Enter on a Mac) saves"><Textarea disabled={locked} rows={3} value={text} onChange={e => onChange(e.target.value)} /></Field>
  else control = <Field label={def.name} hint="Structured Shopify value. Its fields are preserved exactly."><Textarea disabled={locked} rows={3} value={text} onChange={e => onChange(e.target.value)} /></Field>
  return <div className={styles.stack}>
    {control}
    {def.description && <p className={styles.hint}>{def.description}</p>}
    {def.readOnlyReason ? <p className={styles.hint}>{def.readOnlyReason}</p> : (pickError || error) && <p role="status" className={styles.validation}>{pickError || error}</p>}
    {/* A value inside a list has its own "Remove value"; a second "Clear value" beside it only confused. */}
    {!locked && value !== null && !pictured && !nested && <Button size="xs" variant="quiet" onClick={() => onChange(null)}>Clear value</Button>}
    {rules && <p className={styles.hint}>{rules}</p>}
    {picker && <ReferencePicker path={path} type={type} schema={pickerSchema} metaobjectType={metaobjectType} excluded={list ? values : []} onClose={() => setPicker(false)} onChoose={item => { const problem = shopifyReferenceError(def, [item], schema); if (problem) { setNameError(problem); setPicker(false); return } onChange(list ? JSON.stringify([...values, item.id]) : item.id); setNames(old => [...old.filter(n => n.id !== item.id), item]); setPicker(false) }} />}
  </div>
}
