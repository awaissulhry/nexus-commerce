'use client'
import { ShopifyCompoundEditor } from './ShopifyCompoundEditor'
import { shopifyObjectType, shopifyTypeReason, shopifyJson, shopifyReferenceTypes, shopifyReferenceError, shopifyRuleSummary, shopifyDateTimeMs, shopifyDateTimeValue, shopifyLimitMs, shopifyMomentWords } from '@nexus/shared/shopify-linked-products'
import { useEffect, useRef, useState } from 'react'
import { type ShopifyFieldDefinition, type ShopifyReference, type ShopifyStoreSchema, validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { DateField, DateTimeField, Field, MediaMark, OrderedList } from '@/design-system/components'
import { Button, Input, Select, Textarea } from '@/design-system/primitives'
import { ShopifyRichText } from '../images/shopify/ShopifyFieldValue'
import { ReferencePicker } from './ReferencePicker'
import { ShopifyReferenceField } from './ShopifyReferenceField'
import { listMax, olderPickerReason, referenceUiFor } from './referenceFieldModel'
import { linkedEditorKind } from './linkedEditorKind'
import { ShopifyRatingEditor } from './ShopifyRatingEditor'
import { linkedEndpoint, linkedRequest } from './api'
import styles from './linked.module.css'

export function LinkedFieldEditor({ path, definition: def, value, disabled, schema, onChange, onOpenEntry, onCopyEntry, onCreateEntry, nested = false,
  showErrors = true, multiLineHint = 'Enter adds a line · Ctrl+Enter (⌘+Enter on a Mac) saves', referenceVersion }: {
  path: string; definition: ShopifyFieldDefinition; value: string | null; disabled: boolean; schema: ShopifyStoreSchema
  /** One value inside a list editor: the list states the rules once, above its values. */
  nested?: boolean
  /** False until the host's first save try: a form that just opened is not shouting "required" at every empty field (B2). */
  showErrors?: boolean
  /** A multi-line box's key fact — the entry editor has no Ctrl+Enter save, so it says only "Enter adds a line". */
  multiLineHint?: string
  /** Bumped by the host after an entry is saved, so a picker's list is read again. */
  referenceVersion?: number
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
  const chosen = linkedEditorKind(def, value, schema)
  /* A date and time that cannot be read opens a repair box, and the box stays while it is typed in: else the first
     valid keystroke would swap it for the picker and drop the focus. Clearing the value brings the picker (G15). */
  const repairing = useRef(chosen === 'line' && type === 'date_time')
  if (!value) repairing.current = false
  const kind = repairing.current ? 'line' : chosen
  const ui = reference ? referenceUiFor(def, schema) : 'legacy'
  /* Why an entry field is still on the older picker, on screen; `blocked` = there is no kind to pick from (B3c, G18). */
  const legacyReason = kind === 'older-picker' ? olderPickerReason(def, schema) : null
  const pictured = kind === 'entries' || kind === 'resources'
  /* The rules in plain words, once: not under each value of a list, and not under a rating (its hint states the scale). */
  const rules = nested || kind === 'rating' ? '' : shopifyRuleSummary(def, schema)
  let control
  if (pictured && ui !== 'legacy') control = <ShopifyReferenceField ui={ui} path={path} definition={def} schema={schema} values={values} names={names} namesFailed={!!nameError}
    locked={locked} onChange={next => onChange(list ? JSON.stringify(next) : next[0] ?? null)} onError={setPickError}
    onPicked={refs => setNames(old => [...old.filter(n => !refs.some(r => r.id === n.id)), ...refs])}
    onOpenEntry={onOpenEntry} onCopyEntry={onCopyEntry} onCreateEntry={onCreateEntry} referenceVersion={referenceVersion} />
  else if (kind === 'older-picker') control = <div className={styles.stack}>
    {values.length > 0 && <OrderedList label={`${def.name} references`} items={values} disabled={locked || !list} draggable keyboardGrip itemLabel={id => names.find(n => n.id === id)?.label ?? 'Referenced item'} onChange={next => onChange(JSON.stringify(next))} renderItem={id => {
      const item = names.find(n => n.id === id)
      return <span className={styles.reference}>{item?.image && <img src={item.image} alt="" loading="lazy" />}<span>{item?.available === false ? 'Referenced entry is unavailable' : item?.label ?? (nameError ? 'Reference preview unavailable' : 'Loading reference…')}{item?.handle && <small>/{item.handle}</small>}</span>
        {id.includes('/Metaobject/') && onOpenEntry && <Button size="xs" disabled={disabled} onClick={() => onOpenEntry(id)}>Edit entry</Button>}
        {id.includes('/Metaobject/') && onCopyEntry && <Button size="xs" disabled={locked} onClick={() => onCopyEntry(id)}>Make a separate copy</Button>}
        <Button size="xs" variant="quiet" disabled={locked} aria-label={`Remove ${item?.label ?? 'reference'}`} onClick={() => onChange(list ? JSON.stringify(values.filter(v => v !== id)) : null)}>Remove</Button></span>
    }} />}
    {nameError && <p role="status">{nameError}</p>}
    {supportedReference ? <Button size="sm" disabled={locked || !!legacyReason?.blocked || (!!refDefinition && !metaobjectType)} aria-describedby={legacyReason ? `${def.id}-picker-reason` : undefined} onClick={() => setPicker(true)}>{values.length && !list ? 'Replace reference' : 'Choose reference'}</Button> : <p>This reference type is preserved. A picker is not available yet.</p>}
    {legacyReason && <p id={`${def.id}-picker-reason`} className={styles.hint}>{legacyReason.text}</p>}
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
          return <div className={styles.stack}><LinkedFieldEditor nested showErrors={showErrors} multiLineHint={multiLineHint} path={path} schema={schema} definition={definition} value={raw} disabled={locked}
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
  else if (kind === 'date-time') {
    /* The picker shows the viewer's zone; Shopify gets the UTC moment with no zone, its documented form (G15). The
       store's limits are UTC moments too, so the picker offers no day or time outside them. */
    const at = value ? shopifyDateTimeMs(value) : null
    const limit = (name: 'min' | 'max') => { const raw = def.validations.find(r => r.name === name)?.value, ms = raw === undefined ? null : shopifyLimitMs(raw); return ms === null ? undefined : new Date(ms).toISOString() }
    control = <Field label={def.name} hint={at === null ? undefined : `That is ${shopifyMomentWords(at)} (UTC).`}>
      <DateTimeField value={at === null ? '' : new Date(at).toISOString()} min={limit('min')} max={limit('max')} format="yyyy-mm-dd" ariaLabel={def.name} disabled={locked}
        onChange={v => onChange(v ? shopifyDateTimeValue(v) : null)} /></Field>
  }
  else if (kind === 'colour') {
    /* Shopify's colour field: the swatch, the hex text and a colour picker — the swatch is the stored value itself. */
    const hex = /^#[0-9a-f]{6}$/i.test(text) ? text : null
    control = <Field label={def.name}><span className={styles.inline}>
      <Input size="sm" disabled={locked} value={text} placeholder="#RRGGBB" onChange={e => onChange(e.target.value || null)}
        leadingIcon={hex ? <MediaMark choice={{ swatch: hex, label: def.name }} size="chip" /> : undefined} aria-label={`${def.name} hex`} />
      <Input size="sm" type="color" disabled={locked} value={hex ?? '#000000'} onChange={e => onChange(e.target.value)} aria-label={`Pick ${def.name}`} fieldClassName={styles.colourPick} />
    </span></Field>
  }
  else if (kind === 'line' && type === 'date_time') control = <Field label={`Repair ${def.name}`} hint="Type it as 2026-09-28T12:30:00 (UTC), or clear the value to use the date picker.">
    <Input size="sm" disabled={locked} value={text} onChange={e => onChange(e.target.value)} /></Field>
  else if (kind === 'line') control = <Field label={def.name}><Input size="sm" disabled={locked} value={text} inputMode={type.startsWith('number_') ? 'decimal' : undefined} onChange={e => onChange(e.target.value)} /></Field>
  else if (kind === 'code') control = <Field label={def.name} hint={type === 'language' ? 'For example en or it-IT.' : 'For example IT, or US-CA for a region.'}>
    <Input size="sm" disabled={locked} value={text} spellCheck={false} autoCapitalize={type === 'jurisdiction' ? 'characters' : 'off'} onChange={e => onChange(e.target.value)} /></Field>
  else if (kind === 'multi-line') control = <Field label={def.name} hint={multiLineHint}><Textarea disabled={locked} rows={3} value={text} onChange={e => onChange(e.target.value)} /></Field>
  /* The error line under it says where the JSON breaks (G16); an empty box is no value. */
  else if (kind === 'json') control = <Field label={def.name} hint={multiLineHint}><Textarea disabled={locked} rows={4} spellCheck={false} value={text} onChange={e => onChange(e.target.value || null)} /></Field>
  else control = <Field label={def.name} hint="Structured Shopify value. Its fields are preserved exactly."><Textarea disabled={locked} rows={3} value={text} onChange={e => onChange(e.target.value)} /></Field>
  return <div className={styles.stack}>
    {control}
    {def.description && <p className={styles.hint}>{def.description}</p>}
    {def.readOnlyReason ? <p className={styles.hint}>{def.readOnlyReason}</p> : (pickError || (showErrors && error)) && <p role="status" className={styles.validation}>{pickError || error}</p>}
    {/* A value inside a list has its own "Remove value"; a second "Clear value" beside it only confused. */}
    {!locked && value !== null && !pictured && !nested && <Button size="xs" variant="quiet" onClick={() => onChange(null)}>Clear value</Button>}
    {rules && <p className={styles.hint}>{rules}</p>}
    {picker && <ReferencePicker path={path} type={type} schema={pickerSchema} metaobjectType={metaobjectType} excluded={list ? values : []} onClose={() => setPicker(false)} onChoose={item => { const problem = shopifyReferenceError(def, [item], schema); if (problem) { setNameError(problem); setPicker(false); return } onChange(list ? JSON.stringify([...values, item.id]) : item.id); setNames(old => [...old.filter(n => n.id !== item.id), item]); setPicker(false) }} />}
  </div>
}
