'use client'

import { useEffect, useRef, useState } from 'react'
import { Banner, Field, Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import type { AccountRow } from '@/design-system/components/AccountSwitcher'
import type { BusinessProfile } from '@/app/_shared/ProfileScope'
import { BusinessProfilePicker } from '@/app/_shared/BusinessProfilePicker'
import { getBackendUrl } from '@/lib/backend-url'

interface AssignmentReview {
  eligible: boolean
  version: string
  blockers: string[]
  destinationId: string
  destinationName: string
}

export function AssignAccountProfileDialog({ account, source, onClose, onSaved }: {
  account: AccountRow
  source: BusinessProfile
  onClose: () => void
  onSaved: () => void
}) {
  const [destination, setDestination] = useState<BusinessProfile | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [review, setReview] = useState<AssignmentReview | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [assigned, setAssigned] = useState<{ destinationId: string; destinationName: string } | null>(null)
  const inFlight = useRef(false)
  const endpoint = `${getBackendUrl()}/api/workspaces/${encodeURIComponent(source.id)}/accounts/${encodeURIComponent(account.id)}/assignment`
  useEffect(() => {
    setReview(null); setError(null)
    if (!destination) return
    const abort = new AbortController()
    setLoading(true)
    void fetch(`${endpoint}?destinationId=${encodeURIComponent(destination.id)}`, { cache: 'no-store', credentials: 'include', signal: abort.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'The assignment could not be reviewed.')
      if (result.destinationId !== destination.id || !Array.isArray(result.blockers) || typeof result.version !== 'string') throw new Error('The assignment review is incomplete. Try again.')
      if (!abort.signal.aborted) setReview(result)
    }).catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'The assignment could not be reviewed.') })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [endpoint, destination, revision])
  async function commit() {
    if (inFlight.current || !review?.eligible || !destination || review.destinationId !== destination.id) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: review.destinationId, version: review.version }) })
      const result = await response.json()
      if (!response.ok || !result.assigned) throw new Error(result.error ?? 'The account could not be assigned.')
      setAssigned(result); onSaved()
    } catch (error) { setError(error instanceof Error ? error.message : 'The account could not be assigned.') }
    finally { inFlight.current = false; setBusy(false) }
  }
  const close = () => { if (!inFlight.current) onClose() }
  return <><Modal open title={assigned ? 'Account assigned' : `Assign ${account.label} to a profile`} size="md" readable onClose={close}
    footer={assigned ? <><Button onClick={close}>Close</Button><Button asChild variant="primary"><a href={`/w/${assigned.destinationId}/settings/channels`}>Open {assigned.destinationName}</a></Button></>
      : <><Button disabled={busy} onClick={close}>Cancel</Button><Button disabled={!destination || loading || busy} onClick={() => setRevision(value => value + 1)}>Review again</Button><Button variant="primary" disabled={loading || busy || !review?.eligible || review.destinationId !== destination?.id} onClick={() => { void commit() }}>{busy ? 'Assigning…' : 'Assign profile'}</Button></>}>
    {assigned ? <p><strong>{account.label}</strong> is now assigned to <strong>{assigned.destinationName}</strong>. Open that profile and select Reconnect to authorize the marketplace account.</p> : <div className="nds-account-profile-form">
      <p>Move this account from <strong>{source.name}</strong> to another business profile you own.</p>
      <Field label="Destination business profile"><Button disabled={busy} aria-haspopup="dialog" aria-label={`Destination business profile: ${destination?.name ?? 'Choose a profile'}`} onClick={() => setChoosing(true)}>{destination?.name ?? 'Choose a business profile'}</Button></Field>
      <p>The destination requires a fresh marketplace sign-in. Connection history stays in {source.name}; catalog, stock and orders require a separate data migration.</p>
      {loading && <p role="status">Checking account activity, records and profile ownership…</p>}
      {error && <Banner tone="danger" title="Assignment could not be completed">{error}</Banner>}
      {review && !review.eligible && <Banner tone="warning" title="This account is not ready to move"><ul>{review.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></Banner>}
      {review?.eligible && <Banner tone="info" title={`Ready to assign to ${review.destinationName}`}>No active credentials, recorded business activity, pending sign-ins or linked business records were found. These checks run again when you assign the profile.</Banner>}
    </div>}
  </Modal>{choosing && <BusinessProfilePicker title="Assign to business profile" value={destination?.id} permission="owner" excludeId={source.id} onClose={() => setChoosing(false)} onSelect={profile => { setReview(null); setDestination(profile); setChoosing(false) }} />}</>
}
