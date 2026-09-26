'use client'

/**
 * CHMAP (`docs/studies/channel-mappings.md` §8.7) — File mappings: the versioned column decisions every
 * channel file is imported and exported with.
 *
 *   ┌ PageHeader · [Push rules | File mappings] ────────────────────────────────────────────────┐
 *   ├ Versions (by form)          ┬ the selected version: header · actions · counters · filters  │
 *   │  Amazon IT · COAT template  │ one row per column · Recent uses                             │
 *   │   v3 Draft …                │                                                               │
 *   └─────────────────────────────┴───────────────────────────────────────────────────────────────┘
 *
 * The selection lives in the URL (`?view=files&set=<id>`), so a version is linkable. Below 1000 px the
 * panes stack and an open version replaces the list, with a way back.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { RefreshCw, Upload } from 'lucide-react'
import type { MappingSetSummary } from '@nexus/shared/channel-mapping'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { Button, Pill } from '@/design-system/primitives'
import { Banner, Card, EmptyState, Field, Listbox, PressableRow } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'
import { formatDate, num } from '@/design-system/lib/format'
import { listMappingSets, listShopifyStores, errorText } from './api'
import { channelLabel, filterSets, formSourceWord, groupByForm, marketsOf, STATUS_TONE, STATUS_WORD } from './model'
import { fileSetHref } from './urls'
import { VersionDetail } from './VersionDetail'
import { TemplateUploadDrawer } from './TemplateUpload'
import { ShopifyFileDrawer } from './ShopifyFileUpload'
import styles from './files.module.css'

export function FileMappingsView({ viewTabs }: { viewTabs: ReactNode }) {
  const router = useRouter()
  const search = useSearchParams()
  const selectedId = search.get('set')

  const [sets, setSets] = useState<MappingSetSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [listLoad, setListLoad] = useState(0)
  const [channel, setChannel] = useState('')
  const [market, setMarket] = useState('')
  const [uploading, setUploading] = useState(false)
  const [readingShopify, setReadingShopify] = useState(false)
  // NCF — a Shopify version's form key is its store: named from the connected stores (loaded only when one is listed).
  const [stores, setStores] = useState<{ id: string; label: string }[]>([])
  const hasShopify = (sets ?? []).some(s => s.channel === 'SHOPIFY')
  useEffect(() => {
    if (!hasShopify) return
    const controller = new AbortController()
    listShopifyStores(controller.signal).then(rows => { if (!controller.signal.aborted) setStores(rows) }).catch(() => { /* the row then says "not connected" */ })
    return () => controller.abort()
  }, [hasShopify, listLoad])

  useEffect(() => {
    const controller = new AbortController()
    setListError(null)
    listMappingSets(controller.signal)
      .then(rows => { if (!controller.signal.aborted) setSets(rows) })
      .catch(error => { if (!controller.signal.aborted) setListError(errorText(error)) })
    return () => controller.abort()
  }, [listLoad])

  const reloadList = useCallback(() => setListLoad(n => n + 1), [])
  const select = useCallback((id: string | null) => {
    router.replace(fileSetHref(search.toString(), id), { scroll: false })
  }, [router, search])

  const channels = useMemo(() => [...new Set((sets ?? []).map(s => s.channel))].sort(), [sets])
  const markets = useMemo(() => marketsOf(sets ?? [], channel), [sets, channel])
  const groups = useMemo(() => groupByForm(filterSets(sets ?? [], { channel, market })), [sets, channel, market])

  return (
    <div>
      <PageHeader
        title="Category & attribute mappings"
        subtitle="Which Nexus field each column of a channel file fills. Every template has its own versions; an active version never changes."
        actions={<>
          <Button variant="ghost" size="sm" onClick={() => setUploading(true)}><Upload size={14} aria-hidden /> Upload Amazon template</Button>
          <Button variant="ghost" size="sm" onClick={() => setReadingShopify(true)}><Upload size={14} aria-hidden /> Read Shopify file</Button>
          <Button variant="ghost" size="sm" onClick={reloadList}><RefreshCw size={14} aria-hidden /> Refresh</Button>
        </>}
      />
      {viewTabs}

      <div className={styles.shell} data-detail={selectedId ? 'open' : 'closed'}>
        <aside className={styles.listPane} aria-label="Mapping versions">
          <div className={styles.listFilters}>
            <div className={styles.listFilter}>
              <Field label="Channel">
                <Listbox size="sm" value={channel} emptyLabel="All channels"
                  options={channels.map(c => ({ value: c, label: channelLabel(c) }))}
                  onChange={value => { setChannel(value); setMarket('') }} />
              </Field>
            </div>
            <div className={styles.listFilter}>
              <Field label="Market">
                <Listbox size="sm" value={market} emptyLabel="All markets"
                  options={markets.map(m => ({ value: m, label: m }))} onChange={setMarket} />
              </Field>
            </div>
          </div>

          {listError ? (
            <Banner tone="danger" title="The mapping versions could not load" action={<Button size="sm" onClick={reloadList}>Try again</Button>}>{listError}</Banner>
          ) : sets == null ? (
            <p className={styles.plain} role="status">Loading mapping versions…</p>
          ) : sets.length === 0 ? (
            <EmptyState title="No mapping versions yet" description="A version appears when a file is imported." />
          ) : groups.length === 0 ? (
            <EmptyState title="No version matches these filters" description="Choose another channel or market."
              action={<Button size="sm" variant="ghost" onClick={() => { setChannel(''); setMarket('') }}>Show all</Button>} />
          ) : (
            <div className={styles.groups}>
              {groups.map(group => (
                <Card key={group.key} header={group.label} headingLevel={2}
                  description={`${group.versions.length} version${group.versions.length === 1 ? '' : 's'}`}>
                  <div className={styles.versionRows}>
                    {group.versions.map(set => <VersionRow key={set.id} set={set} stores={stores} current={set.id === selectedId} onSelect={() => select(set.id)} />)}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </aside>

        <section className={styles.detailPane} aria-label="Selected mapping version">
          {selectedId ? (
            <>
              <div className={styles.backLink}>
                <Button variant="link" size="sm" onClick={() => select(null)}>All versions</Button>
              </div>
              <VersionDetail key={selectedId} setId={selectedId} sets={sets ?? []} stores={stores} onSelect={select} onListChanged={reloadList} />
            </>
          ) : (
            <EmptyState title="Choose a version" description="Pick a version on the left to see how each column of that file is read and written." />
          )}
        </section>
      </div>
      {uploading && <TemplateUploadDrawer onClose={() => setUploading(false)} onUploaded={result => { reloadList(); select(result.setId) }} />}
      {readingShopify && <ShopifyFileDrawer onClose={() => setReadingShopify(false)} onRead={() => reloadList()}
        onOpenVersion={id => { setReadingShopify(false); select(id) }} />}
    </div>
  )
}

function VersionRow({ set, stores, current, onSelect }: { set: MappingSetSummary; stores: { id: string; label: string }[]; current: boolean; onSelect: () => void }) {
  const c = set.counts
  return (
    <PressableRow
      stacked
      current={current}
      onClick={onSelect}
      label={<span className={styles.versionLabel}>v{set.version}<Pill tone={STATUS_TONE[set.status]} size="sm">{STATUS_WORD[set.status]}</Pill></span>}
    >
      <div className={styles.versionBody}>
        <div className={styles.versionLine}>
          <span>{formSourceWord(set, stores)}</span>
          <span>Created {formatDate(set.createdAt)}</span>
          {set.activatedAt && <span>Activated {formatDate(set.activatedAt)}</span>}
          {set.retiredAt && <span>Retired {formatDate(set.retiredAt)}</span>}
        </div>
        <div className={styles.versionLine}>
          <span>{num(c.mapped)} mapped</span>
          <span>{num(c.ignored)} ignored</span>
          <span>{num(c.managed)} managed</span>
          <span>{num(c.unmapped)} unmapped</span>
          {c.requiredUnmapped > 0 && <Pill tone="danger" size="sm">{num(c.requiredUnmapped)} required unmapped</Pill>}
        </div>
      </div>
    </PressableRow>
  )
}
