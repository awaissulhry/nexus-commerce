'use client'
import { useState } from 'react'
import { ArrowUp, ArrowDown, ChevronsUp, ChevronsDown } from 'lucide-react'
import { Banner, Field, Modal } from '@/design-system/components'
import { Button, Checkbox, Input, Select, ToolbarButton } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'
import { mediaRequest } from '../ebay/transport'
import { usePresentationNavigationGuard } from '@/app/products/ebay-flat-file/Presentation/usePresentationNavigationGuard'
import styles from './content.module.css'

interface Collection { id: string; title: string }
interface CollectionView { collectionId: string; title: string; domain: string; cards: { key: string; label: string; image: string | null; skus: string[] }[]; order: string[]; revision: string; remoteRevision: string; publication: { status: string } | null }
export function CollectionOrderEditor({ path, disabled }: { path: string; disabled: boolean }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [collections, setCollections] = useState<Collection[]>([]), [view, setView] = useState<CollectionView | null>(null), [order, setOrder] = useState<string[]>([]), [approved, setApproved] = useState(false), [discard, setDiscard] = useState<(() => void) | null>(null)
  const canEdit = usePermission('products.edit'), canPublish = usePermission('products.publish')
  const dirty = !!view && JSON.stringify(order) !== JSON.stringify(view.order)
  usePresentationNavigationGuard(open && (dirty || busy), async () => { setError('Save or discard the collection changes before leaving this editor.'); return false })
  const url = (suffix = '') => { const [base, query] = path.split('?'); return `${base}/collections${suffix}?${query}` }
  const adopt = (data: CollectionView) => { setView(data); setOrder(data.order); setApproved(false) }
  async function load(id: string) { setBusy(true); setError(''); setNotice(''); try { adopt(await mediaRequest(url(`/${id}`)) as CollectionView) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  async function show() { setOpen(true); setBusy(true); setError(''); try { const result = await mediaRequest(url()) as { collections: Collection[] }; setCollections(result.collections) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  function move(index: number, position: number) { if (busy || !canEdit || !Number.isInteger(position) || position < 0 || position >= order.length) return; const next = [...order], [key] = next.splice(index, 1); next.splice(position, 0, key); setOrder(next); setApproved(false); setNotice('') }
  async function save(sync = false) {
    if (!view || busy || (sync && (dirty || !approved))) return
    setBusy(true); setError('')
    try { const data = await mediaRequest(url(`/${view.collectionId}${sync ? '/synchronize' : ''}`), sync ? 'POST' : 'PUT', sync ? { expectedRevision: view.revision, expectedRemoteRevision: view.remoteRevision, confirmCollection: true } : { expectedRevision: view.revision, order }) as CollectionView; adopt(data); setNotice(sync ? 'Collection card order saved in Shopify and read back.' : 'Collection order saved in Nexus. Shopify has not been changed.') }
    catch (e) { setError((e as Error).message); setApproved(false) } finally { setBusy(false) }
  }
  function close() { if (busy) return; if (dirty) setDiscard(() => () => { setOpen(false); setView(null) }); else setOpen(false) }
  return <><Button size="sm" disabled={disabled} onClick={() => void show()}>Arrange collection cards</Button><Modal open={open} onClose={close} title="Collection card order" size="xl" readable footer={<><Button disabled={busy} onClick={close}>Close</Button>{view && <><Button disabled={busy || !canEdit || !dirty} onClick={() => void save()}>Save order in Nexus</Button><Button variant="primary" disabled={busy || !canPublish || dirty || !approved || !!error} onClick={() => void save(true)}>Synchronise reviewed order</Button></>}</>}>
    <p>Move a colour, option group or individual variant independently of its family. The saved sequence is the collection’s featured order; rows adapt to the shopper’s screen size. Shopper-selected sorting takes precedence.</p>
    {error && <Banner tone="danger" action={view ? <Button disabled={busy} onClick={() => dirty ? setDiscard(() => () => void load(view.collectionId)) : void load(view.collectionId)}>Reload collection</Button> : undefined}>{error}</Banner>}{notice && <Banner tone="success">{notice}</Banner>}
    <Field label="Shopify collection"><Select disabled={busy} value={view ? `gid://shopify/Collection/${view.collectionId}` : ''} onChange={e => { const id = e.target.value.split('/').at(-1)!; if (!id) return; if (dirty) setDiscard(() => () => void load(id)); else void load(id) }}><option value="">Choose a collection</option>{collections.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</Select></Field>
    {busy && <p role="status">Reading or saving collection content…</p>}
    {view && <><p>{view.domain} · {order.length} cards. New products and cards are added after the saved sequence until you arrange them. Synchronise each family’s card grouping before arranging this collection.</p><ol className={styles.collectionOrder}>{order.map((key, index) => { const card = view.cards.find(c => c.key === key)!; return <li key={key} className={styles.orderedRow}>
      {card.image && <img src={card.image} alt="" width={64} height={64} />}<span><strong>{card.label}</strong><br />{card.skus.join(', ')}</span>
      <div className={styles.collectionPosition}><Input key={`${key}-${index}`} aria-label={`Position for ${card.label}`} size="sm" type="number" min={1} max={order.length} defaultValue={index + 1} disabled={busy || !canEdit} onBlur={e => { const position = Number(e.target.value) - 1; move(index, position); e.target.value = String(position >= 0 && position < order.length ? position + 1 : index + 1) }} /></div>
      <ToolbarButton label={`Move ${card.label} to top`} icon={<ChevronsUp size={14} />} disabled={busy || !canEdit || index === 0} onClick={() => move(index, 0)} /><ToolbarButton label={`Move ${card.label} up`} icon={<ArrowUp size={14} />} disabled={busy || !canEdit || index === 0} onClick={() => move(index, index - 1)} /><ToolbarButton label={`Move ${card.label} down`} icon={<ArrowDown size={14} />} disabled={busy || !canEdit || index === order.length - 1} onClick={() => move(index, index + 1)} /><ToolbarButton label={`Move ${card.label} to bottom`} icon={<ChevronsDown size={14} />} disabled={busy || !canEdit || index === order.length - 1} onClick={() => move(index, order.length - 1)} />
    </li> })}</ol><Checkbox checked={approved} disabled={dirty || busy || !canPublish} onChange={e => setApproved(e.target.checked)} label="I have reviewed this saved order and approve applying it to this Shopify collection." /><p>The order affects storefront themes using the Nexus integration. It does not create duplicate products or move variants into separate Shopify products.</p></>}
  </Modal><Modal open={!!discard} onClose={() => setDiscard(null)} title="Discard unsaved collection order?" footer={<><Button onClick={() => setDiscard(null)}>Keep editing</Button><Button variant="danger-outline" onClick={() => { discard?.(); setDiscard(null) }}>Discard order changes</Button></>}><p>Your product content is unaffected. The collection order will reload from its saved state.</p></Modal></>
}
