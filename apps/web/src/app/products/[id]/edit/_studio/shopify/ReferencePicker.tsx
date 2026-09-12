'use client'
import { useEffect, useRef, useState } from 'react'
import type { ShopifyReference, ShopifyReferencePage, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { AsyncListboxPanel, Field, Modal } from '@/design-system/components'
import { Button, Select } from '@/design-system/primitives'
import { linkedEndpoint, linkedRequest } from './api'

export function ReferencePicker({ path, type, schema, metaobjectType, excluded = [], onChoose, onClose }: {
  path: string; type: string; schema: ShopifyStoreSchema; metaobjectType?: string; excluded?: string[]
  onChoose(value: ShopifyReference): void; onClose(): void
}) {
  const [query, setQuery] = useState(''), [entryType, setEntryType] = useState(metaobjectType ?? '')
  const [items, setItems] = useState<ShopifyReference[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const generation = useRef(0), abort = useRef<AbortController>()
  const needsType = type.includes('metaobject_reference') || type.includes('mixed_reference') || type === 'disclosure_reference'
  async function fetchPage(after?: string) {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller
    const request = ++generation.current; setBusy(true); setError('')
    try {
      const page = await linkedRequest<ShopifyReferencePage>(linkedEndpoint(path, '/references', { type, query, cursor: after, metaobjectType: entryType || undefined }), 'GET', undefined, controller.signal)
      if (generation.current === request) { setItems(old => after ? [...old, ...page.items.filter(i => !old.some(o => o.id === i.id))] : page.items); setCursor(page.cursor) }
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message) } finally { if (generation.current === request) setBusy(false) }
  }
  useEffect(() => {
    setItems([]); setCursor(null); setBusy(true)
    if (needsType && !entryType) { setBusy(false); return }
    const timer = setTimeout(() => { void fetchPage() }, 200)
    return () => { clearTimeout(timer); abort.current?.abort(); generation.current++ }
    // The query and type own the result generation; fetchPage reads their current render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, entryType, refresh, path, type])
  return <Modal open onClose={onClose} title={type === 'product_reference' ? 'Choose a Shopify product' : type === 'product_media' ? 'Choose product media' : 'Choose a reference'} size="md" readable>
    {needsType && !metaobjectType && <Field label="Reusable entry type"><Select size="sm" value={entryType} onChange={e => setEntryType(e.target.value)}><option value="">Choose a type</option>{schema.metaobjectDefinitions.map(d => <option key={d.id} value={d.type}>{d.name}</option>)}</Select></Field>}
    {(!needsType || entryType) && <AsyncListboxPanel label={type === 'product_taxonomy_value_reference' ? 'Shopify taxonomy value ID' : 'Search this Shopify store'} query={query} onQueryChange={setQuery} options={items.map(i => ({ value: i.id, label: `${i.label} · ${i.handle ? `/${i.handle}` : `ID ${i.id.split('/').at(-1)}`}${i.media && i.media.status !== 'READY' ? ` · ${i.media.status}` : ''}`, disabled: excluded.includes(i.id) || !!i.media && i.media.status !== 'READY' }))}
      loading={busy} error={error} onRetry={() => setRefresh(v => v + 1)} onCancel={onClose} onCommit={id => { const item = items.find(i => i.id === id); if (item && !excluded.includes(id)) onChoose(item) }}
      message={cursor ? 'More results are available below.' : undefined} />}
    {cursor && <Button size="sm" disabled={busy} onClick={() => { void fetchPage(cursor) }}>Load more</Button>}
  </Modal>
}
