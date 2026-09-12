'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { Banner, EmptyState, Field, Listbox } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { workspaceFromPath } from '@/lib/workspaces/paths'
import type { MediaSourcesResponse, ShopifyFileReference } from '@nexus/shared/shopify-media'
import { mediaRequest } from './media-api'
import { ShopifyLibrary } from './ShopifyLibrary'
import styles from './media-library.module.css'

interface Props {
  nexusLibrary: ReactNode
  imagesOnly?: boolean
  onUse?(reference: ShopifyFileReference): Promise<void>
  onBusyChange?(busy: boolean): void
}

/** One source decision for the content hub and product pickers. Profile changes remount it. */
export function MediaSourceLibrary(props: Props) {
  const pathname = usePathname()
  const params = useSearchParams()
  const accountId = params.get('accountId') ?? undefined
  return <SourceLibrary key={`${workspaceFromPath(pathname ?? '') ?? 'legacy'}:${accountId ?? ''}`} {...props} preferredAccountId={accountId} />
}

function SourceLibrary({ nexusLibrary, imagesOnly, onUse, onBusyChange, preferredAccountId }: Props & { preferredAccountId?: string }) {
  const [data, setData] = useState<MediaSourcesResponse | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    void mediaRequest<MediaSourcesResponse>('media-sources', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      setData(result)
      // An explicit non-Shopify destination (e.g. an Amazon editor) does not choose a
      // Shopify account. Its media source follows the same verified default as the hub.
      setSelected(result.stores.some(store => store.accountId === preferredAccountId) ? preferredAccountId! : result.defaultSource)
    }).catch(err => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [revision, preferredAccountId])
  const store = data?.stores.find(item => item.accountId === selected)
  function reportBusy(value: boolean) { setBusy(value); onBusyChange?.(value) }
  return <section className={`${styles.library} nds-readable`} aria-label="Media library">
    {error ? <Banner tone="danger" title="Media sources could not be loaded" action={<Button onClick={() => setRevision(value => value + 1)}>Retry</Button>}>{error}</Banner>
      : !data ? <p role="status">Loading media sources…</p> : <>
        <div className={styles.sourceBar}>
          <Field label="Media source">
            <Listbox ariaLabel="Media source" value={selected ?? ''} onChange={setSelected} disabled={busy} width="100%" placeholder="Choose a store"
              options={[...data.stores.map(item => ({ value: item.accountId, label: `Shopify · ${item.label}`, trailing: item.accountId === data.defaultSource ? 'Default' : undefined })), { value: 'nexus', label: 'Nexus assets' }]} />
          </Field>
          <Button asChild variant="quiet"><Link href="/settings/channels">Connections</Link></Button>
        </div>
        {selected === 'nexus' ? nexusLibrary : store ? <ShopifyLibrary key={store.accountId} store={store} imagesOnly={imagesOnly} onUse={onUse} onBusyChange={reportBusy} />
          : <EmptyState title="Choose a Shopify store" description="Several stores are connected. Select the store whose files you want to load." />}
      </>}
  </section>
}
