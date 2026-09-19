'use client'

/**
 * Offer an assortment to another business profile this person belongs to. An owner of that business
 * must accept before anything can be copied. What is offered cannot change afterwards (end the share and
 * offer again), so the dialog says that before it is sent.
 */
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Banner, Field, Listbox, Modal } from '@/design-system/components'
import { Button, CheckboxCard } from '@/design-system/primitives'
import { useProfileScope } from '@/app/_shared/ProfileScope'
import { useProfileDirectory } from '@/lib/workspaces/profile-directory'
import { sharingApi, type Assortment } from './sharingApi'
import { DEFAULT_FIELD_GROUPS, FIELD_GROUP_ORDER, FIELD_GROUP_WORDS } from './words'

export function OfferShareModal({ assortments, initialAssortmentId, onClose, onOffered }: {
  assortments: Assortment[]
  initialAssortmentId?: string
  onClose: () => void
  onOffered: () => Promise<void>
}) {
  const formId = useId()
  const { activeProfile } = useProfileScope()
  const directory = useProfileDirectory({ status: 'active', limit: 100 })
  const [assortmentId, setAssortmentId] = useState(initialAssortmentId ?? '')
  const [destination, setDestination] = useState('')
  const [groups, setGroups] = useState<string[]>([...DEFAULT_FIELD_GROUPS])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const businesses = useMemo(() => directory.profiles.filter((profile) => profile.id !== activeProfile?.id), [directory.profiles, activeProfile?.id])
  const chosen = businesses.find((profile) => profile.id === destination)
  const toggle = (group: string, on: boolean) => setGroups((current) => on ? FIELD_GROUP_ORDER.filter((g) => g === group || current.includes(g)) : current.filter((g) => g !== group))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    if (!assortmentId || !destination) { setError('Choose an assortment and a business profile.'); return }
    if (groups.length === 0) { setError('Choose at least one kind of product detail to share.'); return }
    inFlight.current = true; setBusy(true); setError(null)
    try {
      await sharingApi('assortment-shares', { assortmentId, destinationWorkspaceId: destination, fieldGroups: groups })
      await onOffered()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The offer could not be sent.')
      setBusy(false); inFlight.current = false
    }
  }

  return <Modal open onClose={() => { if (!busy) onClose() }} size="lg" title="Share an assortment"
    subtitle="An owner of the other business must accept before any product is copied."
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Sending…' : chosen ? `Offer to ${chosen.name}` : 'Send offer'}</Button></>}>
    <form id={formId} className="business-profile-form" onSubmit={submit} aria-busy={busy}>
      {error && <Banner tone="danger">{error}</Banner>}
      <Field label="Assortment" required>
        <Listbox value={assortmentId} onChange={setAssortmentId} emptyLabel="Choose an assortment" disabled={busy} width="100%"
          options={assortments.filter((row) => !row.archivedAt).map((row) => ({ value: row.id, label: row.name }))} />
      </Field>
      <Field label="Share with" required hint="Business profiles you belong to. You cannot share with this business itself.">
        <Listbox value={destination} onChange={setDestination} emptyLabel={directory.loading ? 'Loading business profiles…' : 'Choose a business profile'} disabled={busy} width="100%" searchable
          searchPlaceholder="Search business profiles"
          options={businesses.map((profile) => ({ value: profile.id, label: profile.name, trailing: profile.isOwner ? 'You are an owner' : undefined }))} />
      </Field>
      {directory.error && <Banner tone="danger" action={<Button onClick={() => { void directory.refresh() }}>Retry</Button>}>{directory.error}</Banner>}
      {!directory.loading && !directory.error && businesses.length === 0 && <Banner tone="info" title="No other business profile">
        You belong to no other business profile. Create one on the business profiles page, then share with it.
      </Banner>}
      <fieldset className="business-profile-form shared-products-fieldset">
        <legend>What to share</legend>
        <p>These details of each product can be copied into the other business. Stock, costs and channel listings always stay with each business.</p>
        <div className="shared-products-groups">
          {FIELD_GROUP_ORDER.map((group) => <CheckboxCard key={group} checked={groups.includes(group)} selected={groups.includes(group)} disabled={busy}
            onChange={(event) => toggle(group, event.target.checked)}
            title={FIELD_GROUP_WORDS[group].label} description={FIELD_GROUP_WORDS[group].description} />)}
        </div>
        <p>Prices and active or draft status are not shared unless you choose them: each business usually decides those itself. What you offer cannot be changed later; end the share and offer again instead.</p>
      </fieldset>
    </form>
  </Modal>
}
