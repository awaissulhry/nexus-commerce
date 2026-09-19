'use client'

import { useId, useRef, useState, type FormEvent } from 'react'
import { Banner, Card, EmptyState, Field, Modal } from '@/design-system/components'
import { Button, Input, Radio, Textarea } from '@/design-system/primitives'
import type { Access } from './SharingClient'
import { AssortmentProductsModal } from './AssortmentProductsModal'
import { OfferShareModal } from './OfferShareModal'
import { sharingApi, type Assortment, type Selection, type Share } from './sharingApi'
import { count, selectionWords } from './words'

export function AssortmentsPanel({ access, assortments, shares, onChanged, onShared }: {
  access: Access
  assortments: Assortment[] | null
  shares: { outgoing: Share[] } | null
  onChanged: () => Promise<void>
  onShared: () => Promise<void>
}) {
  const [editing, setEditing] = useState<Assortment | 'new' | null>(null)
  const [archiving, setArchiving] = useState<Assortment | null>(null)
  const [products, setProducts] = useState<Assortment | null>(null)
  const [sharing, setSharing] = useState<Assortment | null>(null)
  const owner = access.state === 'owner'

  if (!assortments) return <p role="status">Loading assortments…</p>
  return <>
    {owner && assortments.length > 0 && <div className="business-profile-actions"><Button variant="primary" onClick={() => setEditing('new')}>Create assortment</Button></div>}
    {assortments.length === 0 && <EmptyState title="No assortments yet"
      description="An assortment is a set of products this business can share with your other business profiles."
      action={owner ? <Button variant="primary" onClick={() => setEditing('new')}>Create assortment</Button> : undefined} />}
    {assortments.map((assortment) => {
      const openShares = (shares?.outgoing ?? []).filter((share) => share.assortmentId === assortment.id && ['pending', 'active', 'paused'].includes(share.status))
      return <Card key={assortment.id} headingLevel={3} header={assortment.name}
        description={`${selectionWords(assortment.selection, assortment.memberCount)} · ${assortment.openShareCount ? `shared with ${count(assortment.openShareCount, 'business', 'businesses')}` : 'not shared yet'}`}>
        <div className="shared-products-card-body">
          {assortment.description && <p>{assortment.description}</p>}
          <div className="business-profile-actions">
            <Button onClick={() => setProducts(assortment)}>{assortment.selection === 'list' ? 'Products' : 'Excluded products'}</Button>
            {owner && <>
              <Button onClick={() => setSharing(assortment)}>Share</Button>
              <Button variant="quiet" onClick={() => setEditing(assortment)}>Rename</Button>
              {assortment.openShareCount === 0 && <Button variant="quiet" onClick={() => setArchiving(assortment)}>Archive</Button>}
            </>}
          </div>
          {owner && assortment.openShareCount > 0 && <p className="shared-products-note">
            Shared with {openShares.map((share) => share.workspaceName).join(', ') || count(assortment.openShareCount, 'business', 'businesses')}. End the share before archiving this assortment.
          </p>}
        </div>
      </Card>
    })}
    {editing && <AssortmentEditor assortment={editing} onClose={() => setEditing(null)} onSaved={async () => { await onChanged(); setEditing(null) }} />}
    {archiving && <ArchiveAssortment assortment={archiving} onClose={() => setArchiving(null)} onSaved={async () => { await onChanged(); setArchiving(null) }} />}
    {products && <AssortmentProductsModal assortment={products} canEdit={owner} onClose={() => { setProducts(null); void onChanged() }} />}
    {sharing && <OfferShareModal assortments={assortments} initialAssortmentId={sharing.id} onClose={() => setSharing(null)} onOffered={async () => { setSharing(null); await onShared() }} />}
  </>
}

function AssortmentEditor({ assortment, onClose, onSaved }: { assortment: Assortment | 'new'; onClose: () => void; onSaved: () => Promise<void> }) {
  const formId = useId()
  const creating = assortment === 'new'
  const [name, setName] = useState(creating ? '' : assortment.name)
  const [description, setDescription] = useState(creating ? '' : assortment.description ?? '')
  const [selection, setSelection] = useState<Selection>(creating ? 'list' : assortment.selection)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      if (creating) await sharingApi('assortments', { name, description, selection })
      else await sharingApi(`assortments/${encodeURIComponent(assortment.id)}/update`, { name, description, expectedVersion: assortment.version })
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The assortment could not be saved.')
      setBusy(false); inFlight.current = false
    }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} size="md" title={creating ? 'Create assortment' : `Rename ${assortment.name}`}
    subtitle={creating ? 'Choose products now or later. Nothing is shared until you share the assortment.' : undefined}
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Saving…' : creating ? 'Create assortment' : 'Save'}</Button></>}>
    <form id={formId} className="business-profile-form" onSubmit={submit} aria-busy={busy}>
      {error && <Banner tone="danger">{error}</Banner>}
      <Field label="Assortment name" required hint="For example, Jackets for the Italian store."><Input data-autofocus required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /></Field>
      <Field label="Description" hint="Optional. Only people in this business see it."><Textarea maxLength={500} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} /></Field>
      {creating
        ? <fieldset className="business-profile-form shared-products-fieldset">
          <legend>Which products</legend>
          <Radio name={`${formId}-selection`} label="Products you choose" checked={selection === 'list'} onChange={() => setSelection('list')} disabled={busy} />
          <Radio name={`${formId}-selection`} label="Every product except the ones you exclude" checked={selection === 'all'} onChange={() => setSelection('all')} disabled={busy} />
          <p>This cannot be changed after the assortment is created. New products in this business join an “every product” assortment automatically.</p>
        </fieldset>
        : <p>Which products: {selection === 'list' ? 'products you choose' : 'every product except the ones you exclude'}. This was set when the assortment was created.</p>}
    </form>
  </Modal>
}

function ArchiveAssortment({ assortment, onClose, onSaved }: { assortment: Assortment; onClose: () => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function archive() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await sharingApi(`assortments/${encodeURIComponent(assortment.id)}/archive`, { expectedVersion: assortment.version })
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The assortment could not be archived.')
      setBusy(false)
    }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} size="sm" title={`Archive ${assortment.name}`}
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => { void archive() }}>{busy ? 'Archiving…' : 'Archive assortment'}</Button></>}>
    <div className="business-profile-form">
      {error && <Banner tone="danger">{error}</Banner>}
      <p>The assortment leaves this list and can no longer be shared. Its products are not changed.</p>
    </div>
  </Modal>
}
