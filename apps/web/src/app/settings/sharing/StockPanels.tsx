'use client'

/**
 * The two shared-stock tabs (plan docs/2026-09-19-shared-stock-plan.md §4): stock this business LENDS
 * (the profile switch, lender side: offer, pause, resume, end) and stock it BORROWS (accept, decline,
 * leave, and the product switch). Pause, end and leave first show what happens to the other business's
 * listings, in counts (the API's impact preview). Only an owner acts; everyone else reads.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Banner, Card, EmptyState, Field, KeyValue, Listbox, Modal } from '@/design-system/components'
import { Button, CheckboxCard, Pill } from '@/design-system/primitives'
import { useProfileScope } from '@/app/_shared/ProfileScope'
import { useProfileDirectory } from '@/lib/workspaces/profile-directory'
import type { Access } from './SharingClient'
import { PoolProductsSection } from './PoolProductsSection'
import { sharingApi } from './sharingApi'
import type { BorrowerDecision, Grant, GrantImpact, LendableWarehouse, LenderAction } from './stockPoolApi'
import { borrowerActionLabel, borrowerConsequence, grantStatusWords, impactLines, lenderActionLabel, lenderConsequence, warehousesWords } from './stockWords'
import { count } from './words'

type Pending = { grant: Grant; action: LenderAction | BorrowerDecision }

export function LendPanel({ access, grants, onChanged }: { access: Access; grants: Grant[] | null; onChanged: () => Promise<void> }) {
  const [offering, setOffering] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const owner = access.state === 'owner'
  if (!grants) return <p role="status">Loading shared stock…</p>
  return <>
    {owner && <div className="business-profile-actions"><Button variant="primary" onClick={() => setOffering(true)}>Lend stock</Button></div>}
    {grants.length === 0 && <EmptyState title="This business lends no stock"
      description="Lend the stock of one or more warehouses to another business profile you belong to. Its listings then sell from the same stock as yours: one number, never two." />}
    {grants.map((grant) => <GrantCard key={grant.id} grant={grant} side="lender"
      actions={owner ? lenderActions(grant).map((action) => <Button key={action} variant={action === 'end' ? 'danger-outline' : 'secondary'}
        onClick={() => setPending({ grant, action })}>{lenderActionLabel(grant, action)}</Button>) : []} />)}
    {offering && <OfferStockModal onClose={() => setOffering(false)} onOffered={async () => { setOffering(false); await onChanged() }} />}
    {pending && <GrantActionModal pending={pending} onClose={() => setPending(null)} onDone={async () => { setPending(null); await onChanged() }} />}
  </>
}

export function BorrowPanel({ access, grants, onChanged }: { access: Access; grants: Grant[] | null; onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [reviewing, setReviewing] = useState<Grant | null>(null)
  const owner = access.state === 'owner'
  if (!grants) return <p role="status">Loading shared stock…</p>
  return <>
    {grants.length === 0 && <EmptyState title="This business borrows no stock"
      description="When another business profile lends you its stock, the offer appears here. You then choose which products sell from it." />}
    {grants.map((grant) => <GrantCard key={grant.id} grant={grant} side="borrower"
      actions={owner ? [
        ...(grant.status === 'pending' ? [<Button key="review" variant="primary" onClick={() => setReviewing(grant)}>Review offer</Button>] : []),
        ...(['active', 'paused'].includes(grant.status) ? [<Button key="leave" variant="danger-outline" onClick={() => setPending({ grant, action: 'leave' })}>{borrowerActionLabel('leave')}</Button>] : []),
      ] : []}>
      {['active', 'paused'].includes(grant.status) && <PoolProductsSection grant={grant} canAct={owner} onChanged={onChanged} />}
    </GrantCard>)}
    {reviewing && <ReviewStockOfferModal grant={reviewing} onClose={() => setReviewing(null)}
      onAnswer={(action) => { setReviewing(null); setPending({ grant: reviewing, action }) }} />}
    {pending && <GrantActionModal pending={pending} onClose={() => setPending(null)} onDone={async () => { setPending(null); await onChanged() }} />}
  </>
}

function GrantCard({ grant, side, actions, children }: { grant: Grant; side: 'lender' | 'borrower'; actions: ReactNode[]; children?: ReactNode }) {
  const status = grantStatusWords(grant, side)
  const header = side === 'lender' ? `Stock lent to ${grant.workspaceName}` : `Stock lent by ${grant.ownerWorkspaceName}`
  return <Card headingLevel={3} header={header} description={status.detail} headerAction={<Pill tone={status.tone}>{status.label}</Pill>}>
    <div className="shared-products-card-body">
      <KeyValue columns={2} dense items={[
        { label: 'Warehouses', value: warehousesWords(grant), hint: side === 'lender' ? 'fixed at the offer' : `${grant.ownerWorkspaceName}'s warehouses` },
        { label: 'Products using it', value: count(grant.linkedProducts, 'product'), hint: side === 'lender' ? `in ${grant.workspaceName}` : 'in this business' },
      ]} />
      {actions.length > 0 && <div className="business-profile-actions">{actions}</div>}
      {children}
    </div>
  </Card>
}

function lenderActions(grant: Grant): LenderAction[] {
  switch (grant.status) {
    case 'pending': return ['end']
    case 'active': return ['pause', 'end']
    case 'paused': return ['resume', 'end']
    default: return []
  }
}

/** Pause, resume, end · accept, decline, leave — with the consequence, and for the three that take
 *  stock away the exact listing counts, before anything is sent. */
function GrantActionModal({ pending, onClose, onDone }: { pending: Pending; onClose: () => void; onDone: () => Promise<void> }) {
  const { grant, action } = pending
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [impact, setImpact] = useState<GrantImpact | null>(null)
  const [impactError, setImpactError] = useState<string | null>(null)
  const needsImpact = grant.status !== 'pending' && (action === 'pause' || action === 'end' || action === 'leave')
  const isLender = action === 'pause' || action === 'resume' || action === 'end'
  const label = isLender ? lenderActionLabel(grant, action) : borrowerActionLabel(action)
  const destructive = action === 'end' || action === 'leave' || action === 'decline'

  const loadImpact = useCallback(async () => {
    setImpactError(null)
    try { setImpact((await sharingApi<{ impact: GrantImpact }>(`stock-pool/grants/${encodeURIComponent(grant.id)}/impact`)).impact) }
    catch (err) { setImpactError(err instanceof Error ? err.message : 'What would change could not be worked out.') }
  }, [grant.id])
  useEffect(() => { if (needsImpact) void loadImpact() }, [needsImpact, loadImpact])

  async function run() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await sharingApi(`stock-pool/grants/${encodeURIComponent(grant.id)}/${action}`, { expectedVersion: grant.version })
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be done.')
      setBusy(false)
    }
  }

  // The preview must be read before stock is taken away: until it is there, the action waits for it.
  const ready = !needsImpact || impact !== null
  return <Modal open onClose={() => { if (!busy) onClose() }} size="md" title={`${label}: ${isLender ? grant.workspaceName : grant.ownerWorkspaceName}`}
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button>
      {ready && <Button variant={destructive ? 'danger' : 'primary'} disabled={busy} onClick={() => { void run() }}>{busy ? 'Saving…' : label}</Button>}</>}>
    <div className="business-profile-form">
      {error && <Banner tone="danger">{error}</Banner>}
      <p>{isLender ? lenderConsequence(grant, action) : borrowerConsequence(grant, action)}</p>
      {needsImpact && !impact && !impactError && <p role="status" className="shared-products-note">Working out what changes on the listings…</p>}
      {impactError && <Banner tone="danger" action={<Button onClick={() => { void loadImpact() }}>Retry</Button>}>{impactError} Nothing is changed until it can be shown.</Banner>}
      {impact && <div>
        <p className="shared-products-note">What happens to {isLender ? grant.workspaceName : 'this business'}’s listings:</p>
        <ul className="shared-stock-impact">{impactLines(impact, isLender ? grant.workspaceName : 'this business').map((line) => <li key={line}>{line}</li>)}</ul>
      </div>}
    </div>
  </Modal>
}

function ReviewStockOfferModal({ grant, onClose, onAnswer }: { grant: Grant; onClose: () => void; onAnswer: (action: 'accept' | 'decline') => void }) {
  return <Modal open onClose={onClose} size="md" title={`Stock offered by ${grant.ownerWorkspaceName}`}
    footer={<><Button onClick={onClose}>Close</Button><span className="shared-products-footer-gap" /><Button variant="danger-outline" onClick={() => onAnswer('decline')}>Decline</Button><Button variant="primary" onClick={() => onAnswer('accept')}>Accept</Button></>}>
    <div className="business-profile-form">
      <KeyValue items={[
        { label: 'Offered by', value: grant.ownerWorkspaceName },
        { label: 'Warehouses', value: warehousesWords(grant) },
      ]} />
      <p>Accepting switches nothing yet. You choose products one by one — only products {grant.ownerWorkspaceName} shared with this business — and see the exact number each listing will show before you switch.</p>
      <p>A product uses the shared stock or its own stock, never both added together. Orders for it take from the shared stock and ship from {grant.ownerWorkspaceName}’s warehouse address. Its cost of goods is this business’s own cost price.</p>
    </div>
  </Modal>
}

function OfferStockModal({ onClose, onOffered }: { onClose: () => void; onOffered: () => Promise<void> }) {
  const formId = useId()
  const { activeProfile } = useProfileScope()
  const directory = useProfileDirectory({ status: 'active', limit: 100 })
  const [warehouses, setWarehouses] = useState<LendableWarehouse[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [borrower, setBorrower] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const loadWarehouses = useCallback(async () => {
    setLoadError(null)
    try { setWarehouses((await sharingApi<{ warehouses: LendableWarehouse[] }>('stock-pool/lendable-warehouses')).warehouses) }
    catch (err) { setLoadError(err instanceof Error ? err.message : 'Your warehouses could not be loaded.') }
  }, [])
  useEffect(() => { void loadWarehouses() }, [loadWarehouses])

  const businesses = useMemo(() => directory.profiles.filter((profile) => profile.id !== activeProfile?.id), [directory.profiles, activeProfile?.id])
  const borrowerName = businesses.find((profile) => profile.id === borrower)?.name

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    if (!borrower) { setError('Choose the business profile to lend stock to.'); return }
    if (chosen.length === 0) { setError('Choose at least one warehouse to lend.'); return }
    inFlight.current = true; setBusy(true); setError(null)
    try {
      await sharingApi('stock-pool/grants', { borrowerWorkspaceId: borrower, locationIds: chosen })
      await onOffered()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The offer could not be sent.')
      setBusy(false); inFlight.current = false
    }
  }

  return <Modal open onClose={() => { if (!busy) onClose() }} size="lg" title="Lend stock"
    subtitle="An owner of the other business must accept. Its owners then choose which products use your stock."
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Sending…' : borrowerName ? `Offer to ${borrowerName}` : 'Send offer'}</Button></>}>
    <form id={formId} className="business-profile-form" onSubmit={submit} aria-busy={busy}>
      {error && <Banner tone="danger">{error}</Banner>}
      <Field label="Lend to" required hint="Business profiles you belong to. You cannot lend to this business itself.">
        <Listbox value={borrower} onChange={setBorrower} emptyLabel={directory.loading ? 'Loading business profiles…' : 'Choose a business profile'} disabled={busy} width="100%" searchable
          searchPlaceholder="Search business profiles"
          options={businesses.map((profile) => ({ value: profile.id, label: profile.name, trailing: profile.isOwner ? 'You are an owner' : undefined }))} />
      </Field>
      {directory.error && <Banner tone="danger" action={<Button onClick={() => { void directory.refresh() }}>Retry</Button>}>{directory.error}</Banner>}
      {!directory.loading && !directory.error && businesses.length === 0 && <Banner tone="info" title="No other business profile">
        You belong to no other business profile. Create one on the business profiles page, then lend stock to it.
      </Banner>}
      <fieldset className="business-profile-form shared-products-fieldset">
        <legend>Warehouses to lend</legend>
        <p>The other business sells from the stock of these warehouses, with you: one number, never two. Amazon FBA stock is never lent.</p>
        {loadError && <Banner tone="danger" action={<Button onClick={() => { void loadWarehouses() }}>Retry</Button>}>{loadError}</Banner>}
        {!warehouses && !loadError && <p role="status" className="shared-products-note">Loading your warehouses…</p>}
        {warehouses && warehouses.length === 0 && <Banner tone="info">This business has no active warehouse to lend.</Banner>}
        {warehouses && warehouses.length > 0 && <div className="shared-products-groups">
          {warehouses.map((w) => <CheckboxCard key={w.id} checked={chosen.includes(w.id)} selected={chosen.includes(w.id)} disabled={busy}
            onChange={(event) => setChosen((current) => event.target.checked ? [...current, w.id] : current.filter((id) => id !== w.id))}
            title={w.code} description={w.name !== w.code ? w.name : undefined} />)}
        </div>}
        <p>The warehouses cannot change later: end the shared stock and offer again instead. You can pause it at any time; a preview shows what happens to the other business’s listings first.</p>
      </fieldset>
    </form>
  </Modal>
}
