'use client'
import { useEffect, useState } from 'react'
import { shopifyTypeReason, type ShopifyReusableEntry, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { Banner, Disclosure, Field, Modal } from '@/design-system/components'
import { Button, Input, Select } from '@/design-system/primitives'
import { LinkedFieldEditor } from './LinkedFieldEditor'
import { linkedEndpoint, linkedRequest } from './api'
import { ENTRY_HANDLE, entryHandle, entryDisplayKey, entrySaveProblems } from './entryHandle'
import styles from './linked.module.css'

/** A nested entry opened from one of this entry's fields: an existing one to edit, or a new one for that field (B2). */
type Nested = { id: string | null; type?: string; fieldKey?: string }

/**
 * One reusable entry (metaobject), edited or created — it saves to Shopify at once (D2 a), for every product that uses it.
 * Lane B slice B2 (docs/shopify-metafields/PLAN-2026-09-28.md §6.2): a readable handle; a read-only field is shown with its
 * reason and left out, and no longer blocks the kind; a copy takes only what Nexus can write and says what it left; the
 * field rules are checked before the confirm, and speak only after the first save try; a new entry can be added from a
 * field inside this one and is picked into that field; there is no delete here (LB-D1 a).
 */
export function EntryEditor({ id, copy = false, initialType, path, schema, canPublish, onClose, onSaved }: { id: string | null; copy?: boolean; initialType?: string; path: string; schema: ShopifyStoreSchema; canPublish: boolean; onClose(): void; onSaved(entry: ShopifyReusableEntry): void }) {
  const [entry, setEntry] = useState<ShopifyReusableEntry | null>(null), [type, setType] = useState(initialType ?? '')
  /* The handle Shopify keys the entry by: readable ("water-repellent-k2p9") and the same across retries in this editor, so
     a save whose answer was lost finds its own entry again instead of making a second one. */
  const [suffix] = useState(() => Math.random().toString(36).slice(2, 6).padEnd(4, '0'))
  const [typedHandle, setTypedHandle] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string | null>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(!!id), [confirm, setConfirm] = useState(false), [discard, setDiscard] = useState(false)
  const [status, setStatus] = useState<'ACTIVE' | 'DRAFT'>('ACTIVE')
  const [nested, setNested] = useState<Nested | null>(null), [saved, setSaved] = useState(false)
  const [tried, setTried] = useState(false), [referenceVersion, setReferenceVersion] = useState(0)
  const definition = entry?.definition ?? schema.metaobjectDefinitions.find(d => d.type === type)
  const copying = copy && entry?.id === id
  const creating = !entry || copying
  const valueOf = (key: string) => Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : entry?.fields.find(f => f.key === key)?.value ?? null
  /* Nexus cannot write a read-only field or a type it has no adapter for: those are shown, never sent. */
  const unwritable = (definition?.fields ?? []).filter(f => f.readOnlyReason || shopifyTypeReason(f.type))
  const displayKey = definition ? entryDisplayKey(definition) : undefined
  const handle = entry && !copying ? entry.handle : typedHandle ?? entryHandle(displayKey ? valueOf(displayKey) : null, suffix)
  const dirty = !saved && (Object.keys(fields).length > 0 || copying || (!id && !!type) || (!!definition?.publishable && status !== (entry?.status ?? 'ACTIVE')))
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    void linkedRequest<ShopifyReusableEntry>(linkedEndpoint(path, '/entry', { id }), 'GET', undefined, controller.signal).then(data => { if (!controller.signal.aborted) { setEntry(data); setType(data.type); setStatus(data.status ?? 'ACTIVE') } }).catch(e => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [id, path, copy])
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose() }
  /** What stops the save: the server's own checks, on what this save sends (a copy sends every field it can write). */
  const problems = entrySaveProblems((definition?.fields ?? []).filter(def => !unwritable.includes(def)), valueOf, key => copying || Object.prototype.hasOwnProperty.call(fields, key))
  const review = () => {
    setTried(true)
    if (creating && !copying && !ENTRY_HANDLE.test(handle)) { setError('Use small letters, digits and hyphens in the handle, for example water-repellent.'); return }
    if (problems.length) { setError(`Fix ${problems.length === 1 ? 'the field' : `the ${problems.length} fields`} marked below, then save.`); return }
    setError(''); setConfirm(true)
  }
  async function save() {
    setBusy(true); setError('')
    try {
      const writable = (key: string) => !unwritable.some(f => f.key === key)
      const values = copying ? { ...Object.fromEntries(entry!.fields.filter(f => f.value !== null && writable(f.key)).map(f => [f.key, f.value])), ...fields } : fields
      const result = await linkedRequest<ShopifyReusableEntry>(linkedEndpoint(path, '/entry'), 'POST', { ...(entry && !copying ? { id: entry.id, expectedRevision: entry.revision } : {}), type, handle, ...(definition?.publishable ? { status } : {}),
        fields: Object.entries(values).filter(([key]) => writable(key)).map(([key, value]) => ({ key, value: value ?? '' })) })
      setEntry(result); setFields({}); setSaved(true); setConfirm(false); setTried(false); onSaved(result)
    } catch (e) { setError((e as Error).message); setConfirm(false) } finally { setBusy(false) }
  }
  /* A nested entry is handled HERE: a new one is picked into the field that asked for it; an edited one only refreshes the
     lists. It is never handed to this editor's own host, which would treat it as this entry. */
  const nestedSaved = (result: ShopifyReusableEntry) => {
    setReferenceVersion(v => v + 1)
    const target = nested?.fieldKey ? definition?.fields.find(f => f.key === nested.fieldKey) : undefined
    if (nested && !nested.id && target) {
      const current = valueOf(target.key)
      const next = target.type.startsWith('list.') ? JSON.stringify([...(current ? JSON.parse(current) as string[] : []), result.id]) : result.id
      setFields(old => ({ ...old, [target.key]: next })); setSaved(false)
    }
    if (nested && !nested.id) setNested(null)
  }
  const title = copying ? `Copy ${entry?.name}` : entry?.name ?? (id ? 'Reusable entry' : `New ${definition?.name ?? 'reusable entry'}`)
  return <>
    <Modal open className="ag-custom-component-popup" title={title} size="md" readable onClose={close} footer={<><Button disabled={busy} onClick={close}>Close</Button><Button variant="primary" disabled={busy || !canPublish || !definition || !dirty} onClick={review}>Review entry changes</Button></>}>
      <div className={styles.stack}>
        <p className={styles.hint}>Saves to Shopify now — for every product that uses this entry. To delete an entry, use Shopify admin.</p>
        {error && <Banner tone="danger">{error}</Banner>}{saved && <Banner tone="success">Entry saved and verified in Shopify.</Banner>}{busy && <p role="status">Working with Shopify…</p>}
        {!canPublish && <Banner tone="neutral">Your Nexus role needs publish permission to save entries to Shopify.</Banner>}
        {!entry && !id && <div className={styles.settings}>
          <Field label="Entry type"><Select size="sm" disabled={busy || !!initialType} value={type} onChange={e => { setType(e.target.value); setFields({}); setTried(false) }}><option value="">Choose a type</option>{schema.metaobjectDefinitions.map(d => <option key={d.id} value={d.type}>{d.name}</option>)}</Select></Field>
          <Field label="Entry handle" hint="Shopify’s address for the entry. It is made from the entry’s name; you can change it."><Input size="sm" disabled={busy} value={handle} onChange={e => setTypedHandle(e.target.value)} /></Field>
        </div>}
        {definition?.publishable && <Field label="Entry visibility"><Select size="sm" disabled={busy || !canPublish} value={status} onChange={e => { setStatus(e.target.value as 'ACTIVE' | 'DRAFT'); setSaved(false) }}><option value="ACTIVE">Active — available to the storefront</option><option value="DRAFT">Draft — hidden from the storefront</option></Select></Field>}
        {copying ? <Banner tone="info" title="Separate content for this reference">The copy can have its own images and text. Its replacement reference will be staged in your draft after creation. Nested reusable entries stay shared.{unwritable.length > 0 && ` Not copied, because Nexus cannot write ${unwritable.length === 1 ? 'it' : 'them'}: ${unwritable.map(f => f.name).join(', ')}.`}</Banner>
          : entry && <Banner tone="neutral" title="Shared reusable content">{entry.moreUses ? `This entry has at least ${entry.usedBy.length} references.` : `This entry has ${entry.usedBy.length} ${entry.usedBy.length === 1 ? 'reference' : 'references'}.`} Changes affect every reference to this entry.{entry.usedBy.length > 0 && <Disclosure summary="Where this entry is used"><ul>{entry.usedBy.map((u, i) => <li key={`${u.id}-${i}`}>{u.label}</li>)}</ul>{entry.moreUses && <p>Additional references exist beyond the first 100 shown here.</p>}</Disclosure>}</Banner>}
        {definition?.fields.map(def => <section key={def.key} className={styles.field} aria-label={def.name}>{(def.type.startsWith('list.') || def.type.endsWith('_reference') || ['money', 'rating', 'link', 'rich_text_field'].includes(def.type)) && <h3>{def.name}</h3>}
          <LinkedFieldEditor path={path} schema={schema} definition={def} value={valueOf(def.key)} disabled={busy || !canPublish} showErrors={tried && problems.some(p => p.def === def)} multiLineHint="Enter adds a line" referenceVersion={referenceVersion}
            onOpenEntry={copying ? undefined : entryId => setNested({ id: entryId })}
            onCreateEntry={canPublish ? entryType => setNested({ id: null, type: entryType, fieldKey: def.key }) : undefined}
            onChange={v => { setFields(old => ({ ...old, [def.key]: v })); setSaved(false) }} /></section>)}
      </div>
    </Modal>
    <Modal open={confirm} className="ag-custom-component-popup" onClose={() => { if (!busy) setConfirm(false) }} title="Save reusable entry to Shopify?" footer={<><Button disabled={busy} onClick={() => setConfirm(false)}>Keep editing</Button><Button variant="primary" disabled={busy} onClick={() => { void save() }}>{busy ? 'Saving…' : 'Save to Shopify'}</Button></>}>
      <p>{copying ? 'This creates a separate copy with the displayed fields, then stages its reference in the draft. Save and synchronize the draft to use it on this product.' : !creating ? 'The selected fields will update this shared entry wherever it is referenced.' : 'This creates a reusable entry. Choose it in a product’s metafield to display it.'}</p>{definition?.publishable && <p>Visibility: {status === 'ACTIVE' ? 'Active' : 'Draft'}.</p>}<p>{copying ? 'All displayed fields Nexus can write' : `${Object.keys(fields).length} ${Object.keys(fields).length === 1 ? 'field' : 'fields'}`} will be saved.{!copying && ' Other entry fields are preserved.'}</p>
    </Modal>
    <Modal open={discard} className="ag-custom-component-popup" onClose={() => setDiscard(false)} title="Discard entry edits?" footer={<><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger-outline" onClick={onClose}>Discard edits</Button></>}><p>The changes in this entry editor have not been saved.</p></Modal>
    {nested && <EntryEditor key={`${nested.id}:${nested.type ?? ''}:${nested.fieldKey ?? ''}`} id={nested.id} initialType={nested.type} path={path} schema={schema} canPublish={canPublish} onClose={() => setNested(null)} onSaved={nestedSaved} />}
  </>
}
