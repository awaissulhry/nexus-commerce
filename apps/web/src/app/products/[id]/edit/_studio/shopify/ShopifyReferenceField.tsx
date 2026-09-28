'use client'

/**
 * ShopifyReferenceField — a reference metafield edited the way Shopify's bulk editor edits it (sheet pop-up rebuild P1,
 * docs/sheet-popup-editor/PLAN-2026-09-27.md §4.3), with pictures:
 *   - ENTRIES (one entry type): list → chips over a searchable tick list, each entry with its swatch or icon, and
 *     "Add new entry"; one entry → a card with Change / Clear, Change opening the same list. A picked entry offers
 *     "Edit entry" (and "Make a separate copy") on its row.
 *   - PRODUCT-LIKE (products, variants, collections, files, …): an ordered list with photos, dragged into order, and a
 *     picker dialog that picks many ("3 products selected").
 * Every pick is checked against the field's own rules (`shopifyReferenceError`, `list.max`) before it lands, and the
 * new values' names and pictures are handed up (`onPicked`) so the list shows them at once.
 */
import { useEffect, useRef, useState } from 'react'
import { Copy, Pencil } from 'lucide-react'
import type { ShopifyFieldDefinition, ShopifyReference, ShopifyReferencePage, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyReferenceError, shopifyTaxonomyCategories } from '@nexus/shared/shopify-linked-products'
import {
  MediaChipField, MediaMark, MediaOrderedList, MediaPickList, ResourcePickerDialog, type MediaPickListHandle,
} from '@/design-system/components'
import { Button, ToolbarButton } from '@/design-system/primitives'
import { linkedEndpoint, linkedRequest } from './api'
import { baseReferenceType, chosenChoices, listMax, referenceChoice, referenceNoun, singleEntryType, type ReferenceUi } from './referenceFieldModel'
import styles from './linked.module.css'

/** A page of search results for one field, re-read 200 ms after typing stops; older answers never overwrite newer. */
function useReferenceSearch(path: string, type: string, metaobjectType: string | undefined, enabled: boolean, extra: { fileTypes?: string; attribute?: string; categories?: string; version?: number } = {}) {
  const { fileTypes, attribute, categories, version } = extra
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ShopifyReference[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const abort = useRef<AbortController | undefined>(undefined)
  const fetchPage = async (after?: string) => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller
    const request = ++generation.current
    setLoading(true); setError(null)
    try {
      const page = await linkedRequest<ShopifyReferencePage>(linkedEndpoint(path, '/references', { type, query, cursor: after, metaobjectType, fileTypes, attribute, categories }), 'GET', undefined, controller.signal)
      if (generation.current === request) { setItems(old => after ? [...old, ...page.items.filter(i => !old.some(o => o.id === i.id))] : page.items); setCursor(page.cursor) }
    } catch (e) { if (!controller.signal.aborted && generation.current === request) setError((e as Error).message) }
    finally { if (generation.current === request) setLoading(false) }
  }
  useEffect(() => {
    if (!enabled) return
    const timer = setTimeout(() => { void fetchPage() }, query ? 200 : 0)
    return () => { clearTimeout(timer); abort.current?.abort(); generation.current++ }
    // The query, type and path own a result generation; fetchPage reads their current render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, query, path, type, metaobjectType, fileTypes, attribute, categories, version])
  return { query, setQuery, items, loading, error, hasMore: !!cursor, loadMore: () => { if (cursor) void fetchPage(cursor) } }
}

/** `file_type_options` as the search parameter (`Image,Video`), or undefined when every file is allowed. */
export function fileTypeOptions(def: Pick<ShopifyFieldDefinition, 'validations'>): string | undefined {
  try {
    const kinds = JSON.parse(def.validations.find(v => v.name === 'file_type_options')?.value ?? '[]')
    return Array.isArray(kinds) && kinds.length ? kinds.map(String).join(',') : undefined
  } catch { return undefined }
}

export interface ShopifyReferenceFieldProps {
  ui: Exclude<ReferenceUi, 'legacy'>
  path: string
  definition: ShopifyFieldDefinition
  schema: ShopifyStoreSchema
  values: readonly string[]
  names: readonly ShopifyReference[]
  namesFailed: boolean
  locked: boolean
  onChange(values: string[]): void
  /** New picks' names and pictures, so rows show them before the next name read. */
  onPicked(refs: ShopifyReference[]): void
  onError(message: string): void
  onOpenEntry?(id: string): void
  onCopyEntry?(id: string): void
  /** "Add new entry" — creates the entry in Shopify (D2 a: saved to the store at once, after a confirm). */
  onCreateEntry?(entryType: string): void
  /** Bumped after an entry is saved: the list is read again, so a new entry shows at once (B2). */
  referenceVersion?: number
}

export function ShopifyReferenceField(props: ShopifyReferenceFieldProps) {
  const { ui, path, definition: def, schema, values, names, namesFailed, locked, onChange, onPicked, onError, onOpenEntry, onCopyEntry, onCreateEntry, referenceVersion } = props
  const list = def.type.startsWith('list.')
  const type = baseReferenceType(def.type)
  const noun = referenceNoun(def.type)
  const max = list ? listMax(def) : 1
  const entryType = ui === 'entries' ? singleEntryType(def, schema) ?? undefined : undefined
  const entryName = schema.metaobjectDefinitions.find(d => d.type === entryType)?.name
  const chosen = chosenChoices(values, names, noun, namesFailed)
  const [browsing, setBrowsing] = useState(ui === 'entries' && (list || values.length === 0))
  const [dialog, setDialog] = useState(false)
  /* A file field limited to some kinds lists only those kinds (gap G8): the store is asked for them, nothing is hidden after. */
  const fileTypes = fileTypeOptions(def)
  /* A taxonomy value field reads its attribute's values through a category it applies to (B2, G12). */
  const attribute = def.validations.find(v => v.name === 'product_taxonomy_attribute_handle')?.value
  const categories = attribute ? shopifyTaxonomyCategories(def, schema).join(',') : undefined
  const search = useReferenceSearch(path, list ? def.type : type, entryType, !locked && (ui === 'entries' ? browsing : dialog), { fileTypes, attribute, categories, version: referenceVersion })
  const pick = useRef<MediaPickListHandle>(null)
  const [active, setActive] = useState<string>()

  /* One gate for every pick: the store's own rules, then the list cap. A refused pick changes nothing and says why. */
  const accept = (next: string[], added: ShopifyReference[]): boolean => {
    const problem = added.length ? shopifyReferenceError(def, added, schema) : null
    if (problem) { onError(problem); return false }
    if (max != null && next.length > max) { onError(`This field takes at most ${max} ${max === 1 ? noun.one : noun.other}.`); return false }
    onError('')
    if (added.length) onPicked(added)
    onChange(next)
    return true
  }
  const toggle = (id: string) => {
    if (values.includes(id)) { accept(values.filter(v => v !== id), []); return }
    const ref = search.items.find(i => i.id === id)
    if (!ref) return
    if (!list) { if (accept([id], [ref])) { setBrowsing(false); search.setQuery('') } return }
    /* A pick clears the search, as Shopify's list does: the next Enter then saves instead of un-ticking the same row. */
    if (accept([...values, id], [ref]) && search.query) search.setQuery('')
  }
  const entryActions = (choice: { value: string }, picked: boolean) => picked && (onOpenEntry || onCopyEntry) ? <>
    {onOpenEntry && <ToolbarButton label="Edit entry" description="Changes this shared entry in Shopify, for every product that uses it." icon={<Pencil size={14} />} onClick={() => onOpenEntry(choice.value)} />}
    {onCopyEntry && !locked && <ToolbarButton label="Make a separate copy" description="A copy only this product uses." icon={<Copy size={14} />} onClick={() => onCopyEntry(choice.value)} />}
  </> : null
  const pickList = (single: boolean) => (
    <MediaPickList ref={pick} label={`${entryName ?? def.name} ${noun.other}`} choices={search.items.map(referenceChoice)} selected={values}
      mode={single ? 'single' : 'multi'} search="remote" searchField={single} query={search.query} onQueryChange={search.setQuery}
      searchPlaceholder={`Search ${entryName ?? noun.other}`} loading={search.loading} error={search.error} hasMore={search.hasMore} onLoadMore={search.loadMore}
      emptyText={search.query ? 'No matches' : `This store has no ${entryName ?? noun.other} yet`} onToggle={toggle} onActiveChange={setActive}
      rowActions={entryActions} autoFocus={single}
      onCreate={onCreateEntry && entryType && !locked ? () => onCreateEntry(entryType) : undefined} createLabel="Add new entry" maxHeight={240} />
  )

  if (ui === 'entries') {
    if (list) return <div className={styles.stack}>
      <MediaChipField label={`Chosen ${entryName ?? def.name}`} items={chosen} disabled={locked} onChange={next => accept(next, [])}
        query={search.query} onQueryChange={search.setQuery} placeholder={`Add ${(entryName ?? noun.one).toLowerCase()}`}
        onClear={() => accept([], [])} controls={pick.current?.listId} activeDescendant={active}
        onInputKeyDown={event => { pick.current?.handleKey(event) }} />
      {!locked && pickList(false)}
    </div>
    const current = chosen[0]
    return <div className={styles.stack}>
      {current && <div className={styles.reference}>
        <MediaMark choice={current} size="card" />
        <span>{current.label}{entryName && <small>{entryName}</small>}</span>
        {onOpenEntry && <Button size="xs" onClick={() => onOpenEntry(current.value)}>Edit entry</Button>}
        {!locked && <Button size="xs" onClick={() => setBrowsing(b => !b)} aria-expanded={browsing}>Change</Button>}
        {!locked && <Button size="xs" variant="link" onClick={() => { accept([], []); setBrowsing(true) }}>Clear</Button>}
      </div>}
      {!locked && browsing && pickList(true)}
    </div>
  }

  /* Product-like references: the ordered list with photos, and the picker dialog. */
  const choices = search.items.map(referenceChoice)
  return <div className={styles.stack}>
    {list
      ? <MediaOrderedList label={`${def.name}, in order`} items={chosen} disabled={locked} onChange={next => accept(next, [])}
          onClear={locked ? undefined : () => accept([], [])} emptyText={`No ${noun.other} chosen`}
          actions={!locked && <Button size="sm" onClick={() => setDialog(true)}>Select {noun.other}</Button>} />
      : <div className={styles.reference}>
          {chosen[0] ? <><MediaMark choice={chosen[0]} size="card" /><span>{chosen[0].label}{chosen[0].detail && <small>{chosen[0].detail}</small>}</span></> : <span>No {noun.one} chosen</span>}
          {!locked && <Button size="xs" onClick={() => setDialog(true)}>{chosen[0] ? 'Change' : `Select ${noun.one}`}</Button>}
          {!locked && chosen[0] && <Button size="xs" variant="link" onClick={() => accept([], [])}>Clear</Button>}
        </div>}
    <ResourcePickerDialog open={dialog} title={`Select ${list ? noun.other : noun.one}`} noun={noun} choices={choices}
      initialSelected={values} mode={list ? 'multi' : 'single'} max={max} search="remote" query={search.query} onQueryChange={search.setQuery}
      loading={search.loading} error={search.error} hasMore={search.hasMore} onLoadMore={search.loadMore}
      onCancel={() => setDialog(false)}
      onDone={next => {
        const added = next.filter(id => !values.includes(id)).map(id => search.items.find(i => i.id === id)).filter((r): r is ShopifyReference => !!r)
        if (accept(next, added)) setDialog(false)
      }} />
  </div>
}
