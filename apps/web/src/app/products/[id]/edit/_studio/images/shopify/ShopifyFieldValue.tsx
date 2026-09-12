'use client'
import { shopifyJson } from '@nexus/shared/shopify-linked-products'
import { Field } from '@/design-system/components'
import { Button, Input, Select, Textarea, ToolbarButton } from '@/design-system/primitives'
import { ArrowUp, ArrowDown, Trash2 } from 'lucide-react'
import type { ContentField, ContentValue, ShopifyContent } from '@nexus/shared/shopify-content'
import styles from './content.module.css'

type TextNode = { type: string; value?: string; children?: TextNode[]; [key: string]: unknown }
const clone = <T,>(value: T): T => shopifyJson.parse(shopifyJson.stringify(value))

/** Edit Shopify text leaves without flattening existing headings, links, marks or lists. */
export function ShopifyRichText({ raw, disabled, onChange }: { raw: string; disabled: boolean; onChange(raw: string): void }) {
  let tree: TextNode
  try {
    tree = raw ? shopifyJson.parse(raw) : { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: '' }] }] }
    const valid = (node: any, depth = 0): boolean => depth < 100 && !!node && typeof node === 'object' && !Array.isArray(node) && typeof node.type === 'string'
      && (node.value === undefined || typeof node.value === 'string') && (node.children === undefined || (Array.isArray(node.children) && node.children.every((child: unknown) => valid(child, depth + 1))))
    if (!valid(tree) || tree.type !== 'root' || !Array.isArray(tree.children)) throw new Error('Invalid rich text tree')
  }
  catch { return <Textarea aria-label="Repair rich text JSON" disabled={disabled} value={raw} onChange={e => onChange(e.target.value)} /> }
  const leaves: { path: number[]; node: TextNode; kind: string }[] = []
  const visit = (node: TextNode, path: number[], kind: string) => {
    if (node.type === 'text') leaves.push({ path, node, kind })
    else node.children?.forEach((child, i) => visit(child, [...path, i], node.type === 'root' ? kind : node.type))
  }
  visit(tree, [], 'paragraph')
  return <div className={styles.entry}>{leaves.map(({ node, path, kind }, index) => <Field key={path.join('.')} label={`${kind === 'list-item' ? 'List item' : kind === 'heading' ? 'Heading' : 'Text'} ${index + 1}`} hint={[node.bold && 'Bold', node.italic && 'Italic'].filter(Boolean).join(' · ') || undefined}><Textarea disabled={disabled} rows={2} value={node.value ?? ''} onChange={e => {
    const next = clone(tree); let target = next
    for (const i of path) target = target.children![i]
    target.value = e.target.value; onChange(shopifyJson.stringify(next))
  }} /></Field>)}<Button size="sm" disabled={disabled} onClick={() => onChange(shopifyJson.stringify({ ...tree, children: [...(tree.children ?? []), { type: 'paragraph', children: [{ type: 'text', value: '' }] }] }))}>Add paragraph</Button></div>
}

export function ShopifyFieldValue({ field, value, language, defaultLocale, metaobjects, assets, disabled, onChange }: {
  field: Pick<ContentField, 'type' | 'label' | 'metaobjectType'>; value: ContentValue; language: string; defaultLocale: string
  metaobjects: ShopifyContent['metaobjects']; assets: ShopifyContent['assets']; disabled: boolean; onChange(v: ContentValue): void
}) {
  const translated = language !== defaultLocale, translatable = ['single_line_text_field', 'multi_line_text_field', 'rich_text_field'].includes(field.type)
  const raw = translated && translatable ? value.translations[language] ?? '' : value.value ?? ''
  const locked = disabled || (translated && !translatable)
  const update = (raw: string) => { const next = clone(value); if (translated && translatable) { if (raw) next.translations[language] = raw; else delete next.translations[language] } else next.value = raw; onChange(next) }
  const hint = translated ? translatable ? 'Leave the translation empty to use the default language.' : 'Shared across languages. Edit the default language to change this value.' : field.type === 'rich_text_field' ? 'Existing formatting, links and lists are preserved.' : field.type === 'json' ? 'Structured JSON for an advanced custom field.' : undefined
  const choices = field.type.includes('metaobject_reference') ? metaobjects.filter(m => m.type === field.metaobjectType).map(m => ({ id: `@metaobject:${m.id}`, label: m.handle })) : assets.map(a => ({ id: `@image:${a.id}`, label: a.alt || a.id }))
  const label = (id: string) => choices.find(c => c.id === id)?.label ?? `Existing Shopify file or entry ${id.split('/').at(-1)}`
  let control
  if (field.type.includes('reference')) {
    let selected: string[] = []
    try { selected = field.type.startsWith('list.') ? JSON.parse(raw || '[]') : raw ? [raw] : [] } catch { /* Imported malformed JSON remains available for repair below. */ }
    if (!Array.isArray(selected)) selected = []
    if (field.type.startsWith('list.')) control = <div className={styles.entry}>{selected.map((id, index) => <div key={`${id}-${index}`} className={styles.orderedRow}><span>{label(id)}</span><ToolbarButton label={`Move ${label(id)} earlier`} icon={<ArrowUp size={14} />} disabled={locked || index === 0} onClick={() => { const next = [...selected]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; update(JSON.stringify(next)) }} /><ToolbarButton label={`Move ${label(id)} later`} icon={<ArrowDown size={14} />} disabled={locked || index === selected.length - 1} onClick={() => { const next = [...selected]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; update(JSON.stringify(next)) }} /><ToolbarButton label={`Remove ${label(id)}`} icon={<Trash2 size={14} />} disabled={locked} onClick={() => update(JSON.stringify(selected.filter((_, i) => i !== index)))} /></div>)}<Select aria-label={`Add to ${field.label}`} disabled={locked} value="" onChange={e => { if (e.target.value) update(JSON.stringify([...selected, e.target.value])) }}><option value="">Choose an item to add</option>{choices.filter(c => !selected.includes(c.id)).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></div>
    else control = <Select disabled={locked} value={raw} onChange={e => update(e.target.value)}><option value="">Choose {field.type === 'file_reference' ? 'an image' : 'a reusable entry'}</option>{raw && !choices.some(c => c.id === raw) && <option value={raw}>{label(raw)}</option>}{choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
  } else if (field.type === 'boolean') control = <Select disabled={locked} value={raw} onChange={e => update(e.target.value)}><option value="">Choose</option><option value="true">True</option><option value="false">False</option></Select>
  else if (field.type === 'rich_text_field') control = <ShopifyRichText raw={raw} disabled={locked} onChange={update} />
  else if (['multi_line_text_field', 'json'].includes(field.type)) control = <Textarea disabled={locked} rows={3} value={raw} onChange={e => update(e.target.value)} />
  else control = <Input size="sm" disabled={locked} value={raw} onChange={e => update(e.target.value)} />
  return <Field label={`${field.label} · ${translated && !translatable ? defaultLocale : language}`} hint={hint}>{control}</Field>
}
