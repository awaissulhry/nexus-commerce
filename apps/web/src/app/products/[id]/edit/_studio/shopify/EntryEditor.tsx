'use client'
import { useEffect, useState } from 'react'
import type { ShopifyReusableEntry, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { Banner, Disclosure, Field, Modal } from '@/design-system/components'
import { Button, Input, Select } from '@/design-system/primitives'
import { LinkedFieldEditor } from './LinkedFieldEditor'
import { linkedEndpoint, linkedRequest } from './api'
import styles from './linked.module.css'

export function EntryEditor({ id, copy = false, path, schema, canPublish, onClose, onSaved }: { id: string | null; copy?: boolean; path: string; schema: ShopifyStoreSchema; canPublish: boolean; onClose(): void; onSaved(entry: ShopifyReusableEntry): void }) {
  const [entry, setEntry] = useState<ShopifyReusableEntry | null>(null), [type, setType] = useState(''), [handle, setHandle] = useState(() => `nexus-${crypto.randomUUID()}`)
  const [fields, setFields] = useState<Record<string, string | null>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(!!id), [confirm, setConfirm] = useState(false), [discard, setDiscard] = useState(false)
  const [status, setStatus] = useState<'ACTIVE' | 'DRAFT'>('ACTIVE')
  const [nested, setNested] = useState<string | null>(null), [saved, setSaved] = useState(false)
  const definition = entry?.definition ?? schema.metaobjectDefinitions.find(d => d.type === type)
  const copying = copy && entry?.id === id
  const dirty = !saved && (Object.keys(fields).length > 0 || copying || (!id && !!type) || (!!definition?.publishable && status !== (entry?.status ?? 'ACTIVE')))
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    void linkedRequest<ShopifyReusableEntry>(linkedEndpoint(path, '/entry', { id }), 'GET', undefined, controller.signal).then(data => { if (!controller.signal.aborted) { setEntry(data); setType(data.type); if (!copy) setHandle(data.handle); setStatus(data.status ?? 'ACTIVE') } }).catch(e => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [id, path, copy])
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose() }
  async function save() {
    setBusy(true); setError('')
    try {
      const values = copying ? { ...Object.fromEntries(entry!.fields.filter(f => f.value !== null).map(f => [f.key, f.value])), ...fields } : fields
      const result = await linkedRequest<ShopifyReusableEntry>(linkedEndpoint(path, '/entry'), 'POST', { ...(entry && !copying ? { id: entry.id, expectedRevision: entry.revision } : {}), type, handle, ...(definition?.publishable ? { status } : {}), fields: Object.entries(values).map(([key, value]) => ({ key, value: value ?? '' })) })
      setEntry(result); setFields({}); setSaved(true); setConfirm(false); onSaved(result)
    } catch (e) { setError((e as Error).message); setConfirm(false) } finally { setBusy(false) }
  }
  return <>
    <Modal open title={copying ? `Copy ${entry?.name}` : entry?.name ?? (id ? 'Reusable entry' : 'Create reusable entry')} size="md" readable onClose={close} footer={<><Button disabled={busy} onClick={close}>Close</Button><Button variant="primary" disabled={busy || !canPublish || !definition || !dirty || !!definition.fields.some(f => f.readOnlyReason)} onClick={() => setConfirm(true)}>Review entry changes</Button></>}>
      <div className={styles.stack}>{error && <Banner tone="danger">{error}</Banner>}{saved && <Banner tone="success">Entry saved and verified in Shopify.</Banner>}{busy && <p role="status">Working with Shopify…</p>}
        {!entry && !id && <div className={styles.settings}><Field label="Entry type"><Select size="sm" disabled={busy} value={type} onChange={e => { setType(e.target.value); setFields({}) }}><option value="">Choose a type</option>{schema.metaobjectDefinitions.map(d => <option key={d.id} value={d.type}>{d.name}</option>)}</Select></Field><Field label="Entry handle"><Input size="sm" disabled={busy} value={handle} onChange={e => setHandle(e.target.value)} /></Field></div>}
        {definition?.publishable && <Field label="Entry visibility"><Select size="sm" disabled={busy || !canPublish} value={status} onChange={e => { setStatus(e.target.value as 'ACTIVE' | 'DRAFT'); setSaved(false) }}><option value="ACTIVE">Active — available to the storefront</option><option value="DRAFT">Draft — hidden from the storefront</option></Select></Field>}
        {copying ? <Banner tone="info" title="Separate content for this reference">The copy can have its own images and text. Its replacement reference will be staged in your draft after creation. Nested reusable entries stay shared.</Banner> : entry && <Banner tone="neutral" title="Shared reusable content">{entry.moreUses ? `This entry has at least ${entry.usedBy.length} references.` : `This entry has ${entry.usedBy.length} ${entry.usedBy.length === 1 ? 'reference' : 'references'}.`} Changes affect every reference to this entry.{entry.usedBy.length > 0 && <Disclosure summary="Where this entry is used"><ul>{entry.usedBy.map((u, i) => <li key={`${u.id}-${i}`}>{u.label}</li>)}</ul>{entry.moreUses && <p>Additional references exist beyond the first 100 shown here.</p>}</Disclosure>}</Banner>}
        {definition?.fields.map(def => <section key={def.key} className={styles.field} aria-label={def.name}>{(def.type.startsWith('list.') || def.type.endsWith('_reference') || ['money', 'rating', 'link', 'rich_text_field'].includes(def.type)) && <h3>{def.name}</h3>}<LinkedFieldEditor path={path} schema={schema} definition={def} value={Object.prototype.hasOwnProperty.call(fields, def.key) ? fields[def.key] : entry?.fields.find(f => f.key === def.key)?.value ?? null} disabled={busy || !canPublish} onOpenEntry={copying ? undefined : setNested} onChange={v => { setFields(old => ({ ...old, [def.key]: v })); setSaved(false) }} /></section>)}
      </div>
    </Modal>
    <Modal open={confirm} onClose={() => { if (!busy) setConfirm(false) }} title="Save reusable entry to Shopify?" footer={<><Button disabled={busy} onClick={() => setConfirm(false)}>Keep editing</Button><Button variant="primary" disabled={busy} onClick={() => { void save() }}>{busy ? 'Saving…' : 'Save to Shopify'}</Button></>}>
      <p>{copying ? 'This creates a separate copy with the displayed fields, then stages its reference in the draft. Save and synchronize the draft to use it on this product.' : entry ? 'The selected fields will update this shared entry wherever it is referenced.' : 'This creates a reusable entry. Choose it in a product’s metafield to display it.'}</p>{definition?.publishable && <p>Visibility: {status === 'ACTIVE' ? 'Active' : 'Draft'}.</p>}<p>{copying ? 'All displayed fields' : `${Object.keys(fields).length} fields`} will be saved.{!copying && ' Other entry fields are preserved.'}</p>
    </Modal>
    <Modal open={discard} onClose={() => setDiscard(false)} title="Discard entry edits?" footer={<><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger-outline" onClick={onClose}>Discard edits</Button></>}><p>The changes in this entry editor have not been saved.</p></Modal>
    {nested && <EntryEditor id={nested} path={path} schema={schema} canPublish={canPublish} onClose={() => setNested(null)} onSaved={onSaved} />}
  </>
}
