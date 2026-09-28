'use client'

/**
 * The two share tabs: shares this business offered (it owns the products) and shares offered to it.
 * Each action names its consequence, with the real linked-product count, before it is sent (§7.1 rule 10).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Banner, Card, EmptyState, KeyValue, Modal } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button, Pill } from '@/design-system/primitives'
import type { Access } from './SharingClient'
import { CopyDrawer } from './CopyDrawer'
import { ShareLayoutModal } from './ShareLayoutModal'
import { OfferShareModal } from './OfferShareModal'
import { sharingApi, type Assortment, type CopyRunSummary, type Share } from './sharingApi'
import { count, dateWords, groupsSentence, runResultWords, runStateWords, statusWords, type ShareSide } from './words'

type OwnerAction = 'pause' | 'resume' | 'revoke'
type FollowerAction = 'accept' | 'decline' | 'leave'
type Pending = { share: Share; action: OwnerAction | FollowerAction }

export function OutgoingPanel({ access, assortments, shares, onChanged, onCreateAssortment }: {
  access: Access
  assortments: Assortment[] | null
  shares: Share[] | null
  onChanged: () => Promise<void>
  onCreateAssortment: () => void
}) {
  const [offering, setOffering] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const owner = access.state === 'owner'
  if (!shares) return <p role="status">Loading shares…</p>
  const shareable = (assortments ?? []).filter((row) => !row.archivedAt)
  return <>
    {owner && (shareable.length
      ? <div className="business-profile-actions"><Button variant="primary" onClick={() => setOffering(true)}>Share an assortment</Button></div>
      : <p className="shared-products-note">Create an assortment first: it is the set of products you share. <Button variant="link" onClick={onCreateAssortment}>Go to assortments</Button></p>)}
    {shares.length === 0 && <EmptyState title="This business has not shared any products" description="Share an assortment with another business profile you belong to. Its owner accepts, then copies the products." />}
    {shares.map((share) => <ShareCard key={share.id} share={share} side="owner"
      actions={owner ? ownerActions(share).map((action) => <Button key={action} variant={action === 'revoke' ? 'danger-outline' : 'secondary'} onClick={() => setPending({ share, action })}>{actionLabel(share, action)}</Button>) : []} />)}
    {offering && assortments && <OfferShareModal assortments={assortments} onClose={() => setOffering(false)} onOffered={async () => { setOffering(false); await onChanged() }} />}
    {pending && <ShareActionModal pending={pending} onClose={() => setPending(null)} onDone={async () => { setPending(null); await onChanged() }} />}
  </>
}

export function IncomingPanel({ access, shares, onChanged }: { access: Access; shares: Share[] | null; onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [reviewing, setReviewing] = useState<Share | null>(null)
  const [copying, setCopying] = useState<{ share: Share; runId?: string } | null>(null)
  const [laying, setLaying] = useState<Share | null>(null)
  const [runsVersion, setRunsVersion] = useState(0)
  const owner = access.state === 'owner'
  if (!shares) return <p role="status">Loading shares…</p>
  return <>
    {shares.length === 0 && <EmptyState title="No products are shared with this business" description="When another business profile shares an assortment with this one, the offer appears here." />}
    {shares.map((share) => <ShareCard key={share.id} share={share} side="follower"
      actions={owner ? [
        ...(share.status === 'pending' ? [<Button key="review" variant="primary" onClick={() => setReviewing(share)}>Review offer</Button>] : []),
        ...(share.status === 'active' ? [<Button key="copy" variant="primary" onClick={() => setCopying({ share })}>Copy products</Button>] : []),
        ...(share.status === 'active' && share.linkedProducts > 0 ? [<Button key="layout" onClick={() => setLaying(share)}>Make draft listings</Button>] : []),
        ...(['active', 'paused'].includes(share.status) ? [<Button key="leave" variant="danger-outline" onClick={() => setPending({ share, action: 'leave' })}>Leave share</Button>] : []),
      ] : []}>
      {share.status !== 'pending' && share.status !== 'declined' && <CopyRuns key={`${share.id}:${runsVersion}`} share={share} canAct={owner && ['active', 'paused'].includes(share.status)} onOpen={(runId) => setCopying({ share, runId })} />}
    </ShareCard>)}
    {reviewing && <ReviewOfferModal share={reviewing} onClose={() => setReviewing(null)}
      onAnswer={(action) => { setReviewing(null); setPending({ share: reviewing, action }) }} />}
    {pending && <ShareActionModal pending={pending} onClose={() => setPending(null)} onDone={async () => { setPending(null); await onChanged() }} />}
    {laying && <ShareLayoutModal share={laying} onClose={() => setLaying(null)} />}
    {copying && <CopyDrawer share={copying.share} runId={copying.runId} onClose={() => { setCopying(null); setRunsVersion((n) => n + 1); void onChanged() }} />}
  </>
}

function ShareCard({ share, side, actions, children }: { share: Share; side: ShareSide; actions: ReactNode[]; children?: ReactNode }) {
  const status = statusWords(share, side)
  // An ended share hides the assortment from the receiving business, so its name is no longer readable there.
  const header = side === 'owner'
    ? `${share.assortmentName ?? 'Assortment'} → ${share.workspaceName}`
    : share.assortmentName ? `${share.assortmentName} from ${share.ownerWorkspaceName}` : `Products shared by ${share.ownerWorkspaceName}`
  return <Card headingLevel={3} header={header} description={status.detail} headerAction={<Pill tone={status.tone}>{status.label}</Pill>}>
    <div className="shared-products-card-body">
      <KeyValue columns={2} dense items={[
        { label: 'What is shared', value: groupsSentence(share.fieldGroups) },
        { label: 'Linked products', value: count(share.linkedProducts, 'product'), hint: side === 'owner' ? `in ${share.workspaceName}` : 'linked to the shared products' },
      ]} />
      {actions.length > 0 && <div className="business-profile-actions">{actions}</div>}
      {children}
    </div>
  </Card>
}

function ownerActions(share: Share): OwnerAction[] {
  switch (share.status) {
    case 'pending': return ['revoke']
    case 'active': return ['pause', 'revoke']
    case 'paused': return ['resume', 'revoke']
    default: return []
  }
}

function actionLabel(share: Share, action: OwnerAction | FollowerAction): string {
  switch (action) {
    case 'pause': return 'Pause'
    case 'resume': return 'Resume'
    case 'revoke': return share.status === 'pending' ? 'Withdraw offer' : 'End share'
    case 'accept': return 'Accept'
    case 'decline': return 'Decline'
    case 'leave': return 'Leave share'
  }
}

/** What each action does, in words, with the real count of linked products. */
function consequence({ share, action }: Pending): string {
  switch (action) {
    case 'pause': return `${share.workspaceName} cannot start a new copy until you resume. ${share.linkedProducts ? `Its ${count(share.linkedProducts, 'linked product')} stay linked.` : 'No products are linked yet.'}`
    case 'resume': return `${share.workspaceName} can copy products again.`
    case 'revoke': return share.status === 'pending'
      ? `The offer to ${share.workspaceName} is withdrawn. Nothing was copied.`
      : `The share ends for good. ${share.linkedProducts ? `${count(share.linkedProducts, 'product')} in ${share.workspaceName} are unlinked. ${share.workspaceName} keeps its copies.` : 'No products were linked.'} To share again, make a new offer.`
    case 'accept': return `Nothing is copied yet. You choose when to copy, and review every product and field first.`
    case 'decline': return `The offer from ${share.ownerWorkspaceName} is declined. ${share.ownerWorkspaceName} can offer again later.`
    case 'leave': return `The share ends for good. ${share.linkedProducts ? `${count(share.linkedProducts, 'product')} in this business are unlinked from ${share.ownerWorkspaceName}. The products stay here as your own.` : 'No products are linked.'}`
  }
}

function ShareActionModal({ pending, onClose, onDone }: { pending: Pending; onClose: () => void; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { share, action } = pending
  const destructive = action === 'revoke' || action === 'leave' || action === 'decline'
  async function run() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await sharingApi(`assortment-shares/${encodeURIComponent(share.id)}/${action}`, { expectedVersion: share.version })
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be done.')
      setBusy(false)
    }
  }
  const title = `${actionLabel(share, action)}: ${share.assortmentName ?? 'shared products'}`
  return <Modal open onClose={() => { if (!busy) onClose() }} size="sm" title={title}
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant={destructive ? 'danger' : 'primary'} disabled={busy} onClick={() => { void run() }}>{busy ? 'Saving…' : actionLabel(share, action)}</Button></>}>
    <div className="business-profile-form">
      {error && <Banner tone="danger">{error}</Banner>}
      <p>{consequence(pending)}</p>
    </div>
  </Modal>
}

function ReviewOfferModal({ share, onClose, onAnswer }: { share: Share; onClose: () => void; onAnswer: (action: 'accept' | 'decline') => void }) {
  return <Modal open onClose={onClose} size="md" title={`Offer from ${share.ownerWorkspaceName}`}
    subtitle={share.assortmentName ?? undefined}
    footer={<><Button onClick={onClose}>Close</Button><span className="shared-products-footer-gap" /><Button variant="danger-outline" onClick={() => onAnswer('decline')}>Decline</Button><Button variant="primary" onClick={() => onAnswer('accept')}>Accept</Button></>}>
    <div className="business-profile-form">
      <KeyValue items={[
        { label: 'Offered by', value: share.ownerWorkspaceName, hint: dateWords(share.createdAt) },
        { label: 'What is shared', value: groupsSentence(share.fieldGroups) },
      ]} />
      <p>Accepting copies nothing yet. When you copy, you first see which products arrive, which ones this business already has, and every field before it is saved.</p>
      <p>Stock, costs and channel listings stay with each business.</p>
    </div>
  </Modal>
}

function CopyRuns({ share, canAct, onOpen }: { share: Share; canAct: boolean; onOpen: (runId: string) => void }) {
  const [runs, setRuns] = useState<CopyRunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    setError(null)
    try { setRuns((await sharingApi<{ runs: CopyRunSummary[] }>(`assortment-shares/${encodeURIComponent(share.id)}/copy-runs`)).runs) }
    catch (err) { setError(err instanceof Error ? err.message : 'Copies could not be loaded.') }
  }, [share.id])
  useEffect(() => { void load() }, [load])
  if (error) return <Banner tone="danger" action={<Button onClick={() => { void load() }}>Retry</Button>}>{error}</Banner>
  if (!runs) return <p role="status" className="shared-products-note">Loading copies…</p>
  if (runs.length === 0) return <p className="shared-products-note">No products copied yet.</p>
  const columns: Array<Column<CopyRunSummary>> = [
    { key: 'started', label: 'Started', render: (run) => dateWords(run.createdAt) },
    { key: 'state', label: 'State', render: (run) => { const words = runStateWords(run.state); return <Pill tone={words.tone}>{words.label}</Pill> } },
    { key: 'result', label: 'Result', render: (run) => runResultWords(run) },
    ...(canAct ? [{ key: 'open', label: 'Action', render: (run: CopyRunSummary) => ['reviewing', 'finishing'].includes(run.state)
      ? <Button size="sm" onClick={() => onOpen(run.id)}>Continue</Button>
      : run.state === 'partial' ? <Button size="sm" onClick={() => onOpen(run.id)}>See problems</Button> : null }] : []),
  ]
  return <DataGrid ariaLabel={`Copies from ${share.ownerWorkspaceName}`} columns={columns} rows={runs} rowKey={(run) => run.id} />
}
