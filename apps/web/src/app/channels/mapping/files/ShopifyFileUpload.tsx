'use client'

/**
 * NCF (`docs/studies/native-channel-files.md` §3, D3 A) — read Shopify's own product CSV for its PREVIEW on the File
 * mappings page: which mapping version it reads with (found, or made as a draft) and what an import would write,
 * exclude and refuse, with the most common reasons. Nothing else is saved; the import itself is applied from the
 * Catalog page or a product's sheet. The server's refusal is shown word for word.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Banner, Drawer, Field, FileDropzone, KeyValue, Listbox } from '@/design-system/components'
import { num } from '@/design-system/lib/format'
import { errorText, listShopifyStores, uploadShopifyFile } from './api'
import { shopifyPreviewSentence, type ShopifyFilePreview } from './model'
import styles from './files.module.css'

const MAX_BYTES = 10 * 1024 * 1024 // the server's own limit (`request.file({ limits: { fileSize } })`)

export function ShopifyFileDrawer({ onClose, onRead, onOpenVersion }: {
  onClose: () => void
  /** A file was read: its version exists now (the list may have a new draft). */
  onRead: (preview: ShopifyFilePreview) => void
  onOpenVersion: (setId: string) => void
}) {
  const [stores, setStores] = useState<{ id: string; label: string }[] | null>(null)
  const [storesError, setStoresError] = useState<string | null>(null)
  const [store, setStore] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ShopifyFilePreview | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listShopifyStores(controller.signal)
      .then(rows => { if (controller.signal.aborted) return; setStores(rows); if (rows.length === 1) setStore(rows[0].id) })
      .catch(e => { if (!controller.signal.aborted) setStoresError(errorText(e)) })
    return () => controller.abort()
  }, [])

  const read = async (file: File) => {
    setBusy(file.name); setError(null); setPreview(null)
    try {
      const result = await uploadShopifyFile(file, store || undefined)
      setPreview(result)
      onRead(result)
    } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }
  const chooseStore = (stores?.length ?? 0) > 1
  const blocked = busy != null || stores == null || (chooseStore && !store)

  return (
    <Drawer open onClose={onClose} width={560} title="Read a Shopify product file"
      subtitle="Shows what an import would do. Nothing is saved here: apply the import on the Catalog page or in a product’s sheet."
      footer={<>
        <Button onClick={onClose}>Close</Button>
        {preview && <Button variant="primary" onClick={() => onOpenVersion(preview.setId)}>Open v{preview.version}</Button>}
      </>}>
      <div className={styles.drawerBody}>
        {storesError && <Banner tone="danger" title="The Shopify stores could not load">{storesError}</Banner>}
        {stores && stores.length === 0 && <Banner tone="warning" title="No Shopify store is connected">Connect the store first; a Shopify file is read against the listings Nexus links in it.</Banner>}
        {chooseStore && (
          <Field label="Shopify store" required hint="Shopify’s file does not name its store.">
            <Listbox size="sm" value={store} placeholder="Choose the store" options={stores!.map(s => ({ value: s.id, label: s.label }))} onChange={setStore} />
          </Field>
        )}
        {stores?.length === 1 && <p className={styles.plain}>Store: {stores[0].label}</p>}
        <FileDropzone accept=".csv" maxBytes={MAX_BYTES} disabled={blocked}
          hint="The Plain CSV file from Shopify admin → Products → Export · up to 10MB"
          onFiles={files => { if (files[0]) void read(files[0]) }} />
        {busy && <p className={styles.plain} role="status">Reading {busy}…</p>}
        {error && <Banner tone="danger" title="The file was refused">{error}</Banner>}
        {preview && <ShopifyPreview preview={preview} />}
      </div>
    </Drawer>
  )
}

function ShopifyPreview({ preview }: { preview: ShopifyFilePreview }) {
  const c = preview.counts
  return (
    <section className={styles.section} aria-label="What an import would do">
      <Banner tone={c.written ? 'success' : 'warning'} title={c.written ? 'File read' : 'File read: nothing would be imported'}>{shopifyPreviewSentence(preview, num)}</Banner>
      <KeyValue columns={2} dense items={[
        { label: 'Products', value: num(c.products), hint: `${num(c.rows)} rows` },
        { label: 'Would be imported', value: num(c.written), hint: 'cells' },
        { label: 'Excluded', value: num(c.excluded), hint: 'cells, each with its reason' },
        { label: 'Refused', value: num(c.refused), hint: 'cells, each with its reason' },
        { label: 'Links to confirm', value: num(c.linkProposals), hint: 'confirmed when you import' },
      ]} />
      {preview.refused.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Most common refusals</h3>
          <ul className={styles.keyList}>{preview.refused.map((r, i) => <li key={i}>{num(r.cells)} × {r.reason}</li>)}</ul>
        </div>
      )}
      {preview.excluded.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Most common exclusions</h3>
          <ul className={styles.keyList}>{preview.excluded.map((r, i) => <li key={i}>{num(r.cells)} × {r.reason}</li>)}</ul>
        </div>
      )}
      {preview.warnings.length > 0 && (
        <Banner tone="info" title={`${preview.warnings.length} note${preview.warnings.length === 1 ? '' : 's'} on this file`}>
          <ul className={styles.keyList}>{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Banner>
      )}
    </section>
  )
}
