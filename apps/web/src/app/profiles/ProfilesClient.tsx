'use client'

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { Building2, Plus, Search } from 'lucide-react'
import { BUSINESS_COUNTRIES } from '@nexus/shared/business-profile'
import { Banner, Card, Field, Modal } from '@/design-system/components'
import { Button, Input, Select } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'
import { useTheme } from '@/lib/theme/use-theme'
import { useProfileScope, type BusinessProfile } from '../_shared/ProfileScope'
import { useProfileDirectory } from '@/lib/workspaces/profile-directory'
import './profiles.css'

export default function ProfilesClient() {
  // The picker has no application top bar to restore the saved theme.
  useTheme()
  const { user } = useAuth()
  const { activeProfile, refresh: refreshScope } = useProfileScope()
  const search = useSearchParams()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<BusinessProfile | null>(null)
  const [changingStatus, setChangingStatus] = useState<BusinessProfile | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const directory = useProfileDirectory({ q: query, status: showArchived ? 'archived' : 'active' })
  const { profiles, error, loading } = directory
  const refresh = async () => { await Promise.all([directory.refresh(), refreshScope()]) }
  useEffect(() => { if (search.get('create') === '1') setCreating(true) }, [search])
  if (!WORKSPACES_ENABLED) return <div className="business-profiles"><Banner title="Business profiles are being prepared">Your existing workspace is available from the dashboard.</Banner><Button asChild><a href="/dashboard/overview">Open dashboard</a></Button></div>
  return <div className="business-profiles">
    <header className="business-profiles-heading">
      <div><p className="business-profiles-eyebrow">Nexus Commerce · {user?.email}</p><h1>Business profiles</h1><p>Keep each business’s accounts, catalog, settings, and team together.</p></div>
      <Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />Create profile</Button>
    </header>
    {search.get('unavailable') === '1' && <Banner tone="warning" title="That profile is unavailable">Choose a profile you currently have access to.</Banner>}
    {error && <Banner tone="danger" title="Profiles could not be loaded" action={<Button onClick={() => { void refresh() }}>Retry</Button>}>{error}</Banner>}
    <Field label="Search business profiles"><Input value={query} maxLength={80} onChange={event => setQuery(event.target.value)} leadingIcon={<Search size={15} aria-hidden />} placeholder="Search by business name" /></Field>
    <div><Button variant={showArchived ? 'secondary' : 'primary'} onClick={() => setShowArchived(false)} aria-pressed={!showArchived}>Active profiles</Button> <Button variant={showArchived ? 'primary' : 'secondary'} onClick={() => setShowArchived(true)} aria-pressed={showArchived}>Archived profiles</Button></div>
    {loading && <p role="status">Loading your business profiles…</p>}
    {!loading && !error && !showArchived && !query.trim() && directory.page === 1 && profiles.length === 0 && <Card header="Create your first business profile" description="One login can manage several businesses." padded><p>For example, create Xavia Racing, then connect its Amazon and eBay accounts. Create another profile for a business that needs its own catalog and settings.</p><Button variant="primary" onClick={() => setCreating(true)}>Create business profile</Button></Card>}
    <div className="business-profiles-grid" aria-busy={loading}>
      {profiles.map(profile => <Card key={profile.id} header={<><Building2 size={17} aria-hidden /> {profile.name}</>} description={`${showArchived ? 'Archived · ' : ''}${profile.roleNames.join(' · ')}${profile.id === activeProfile?.id ? ' · Current profile' : ''}`}>
        <div className="business-profile-actions">
          {showArchived ? <Button onClick={() => setChangingStatus(profile)}>Restore profile</Button> : <>
          <Button variant="primary" asChild><a href={`/w/${profile.id}/dashboard/overview`}>Open profile</a></Button>
          {(profile.isOwner || profile.canConnectAccounts) && <Button asChild><a href={`/w/${profile.id}/settings/channels`}>Connected accounts</a></Button>}
          {profile.isOwner && <><Button variant="quiet" onClick={() => setRenaming(profile)}>Rename</Button><Button variant="quiet" onClick={() => setChangingStatus(profile)}>Archive</Button></>}
          </>}
        </div>
      </Card>)}
    </div>
    {!loading && !error && profiles.length === 0 && (query.trim() || showArchived || directory.page > 1) && <p role="status">{query.trim() ? `No profiles match “${query}”.` : showArchived ? 'No archived profiles.' : 'No more profiles on this page.'}</p>}
    {(directory.page > 1 || directory.nextCursor) && <nav aria-label="Business profile pages" className="business-profile-actions">
      <Button disabled={loading || directory.page === 1} onClick={directory.previous}>Previous</Button><span>Page {directory.page}</span><Button disabled={loading || !directory.nextCursor} onClick={directory.next}>Next</Button>
    </nav>}
    <div><Button variant="quiet" asChild><a href="/settings/profile">Personal settings</a></Button></div>
    {creating && <CreateProfile onClose={() => setCreating(false)} />}
    {renaming && <RenameProfile profile={renaming} onClose={() => setRenaming(null)} onSaved={refresh} />}
    {changingStatus && <ChangeProfileStatus profile={changingStatus} onClose={() => setChangingStatus(null)} onSaved={refresh} />}
  </div>
}

function ChangeProfileStatus({ profile, onClose, onSaved }: { profile: BusinessProfile; onClose: () => void; onSaved: () => Promise<void> }) {
  const formId = useId()
  const action = profile.status === 'archived' ? 'restore' : 'archive'
  const title = action === 'archive' ? 'Archive' : 'Restore'
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current || confirmation !== profile.name) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      const response = await fetch(`${getBackendUrl()}/api/workspaces/${profile.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: confirmation, version: profile.version }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'The profile could not be updated.')
      if (action === 'archive' && window.location.pathname.startsWith(`/w/${profile.id}/`)) { window.location.assign('/profiles'); return }
      await onSaved(); onClose()
    } catch (error) { setError(error instanceof Error ? error.message : 'The profile could not be updated.'); setBusy(false); inFlight.current = false }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} title={`${title} ${profile.name}`} footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant={action === 'archive' ? 'danger' : 'primary'} disabled={busy || confirmation !== profile.name} form={formId} type="submit">{busy ? 'Saving…' : `${title} profile`}</Button></>}>
    <form id={formId} onSubmit={submit} className="business-profile-form">
      <p>{action === 'archive' ? 'Archiving blocks access and new integration work. Existing records are preserved, and owners can restore the profile. Work already sent to a marketplace may still finish.' : 'Restoring lets existing members access the business again and allows scheduled integrations to resume. Expired invitations and canceled jobs remain inactive.'}</p>
      {error && <Banner tone="danger">{error}</Banner>}
      <Field label={`Type ${profile.name} to confirm`} required><Input data-autofocus required value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></Field>
    </form>
  </Modal>
}

function CreateProfile({ onClose }: { onClose: () => void }) {
  const formId = useId()
  const key = useRef(crypto.randomUUID())
  const inFlight = useRef(false)
  const [name, setName] = useState('')
  const [country, setCountry] = useState('')
  const [currency, setCurrency] = useState('')
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const options = useMemo(() => {
    const intl = Intl as typeof Intl & { supportedValuesOf(key: 'currency' | 'timeZone'): string[] }
    const names = new Intl.DisplayNames(['en'], { type: 'region' })
    return {
      countries: BUSINESS_COUNTRIES.map(code => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name)),
      currencies: intl.supportedValuesOf('currency'),
      timezones: [...new Set(['UTC', timezone, ...intl.supportedValuesOf('timeZone')])].sort(),
    }
  }, [timezone])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      const response = await fetch(`${getBackendUrl()}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, country, currency, timezone, creationKey: key.current }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'The business profile could not be created.')
      window.location.assign(`/w/${encodeURIComponent(data.workspace.id)}/settings/channels`)
    } catch (err) { setError(err instanceof Error ? err.message : 'The business profile could not be created.'); setBusy(false); inFlight.current = false }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} title="Create business profile" subtitle="Start with a separate catalog, settings, and connected accounts." size="md" footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Creating…' : 'Create profile'}</Button></>}>
    <form id={formId} className="business-profile-form" onSubmit={submit} aria-busy={busy}>
      {error && <Banner tone="danger">{error}</Banner>}
      <Field label="Business profile name" required hint="Use the business or brand name, such as Xavia Racing."><Input data-autofocus value={name} onChange={event => setName(event.target.value)} required minLength={2} maxLength={80} disabled={busy} autoComplete="organization" /></Field>
      <Field label="Business country" required><Select value={country} onChange={event => setCountry(event.target.value)} required disabled={busy}><option value="">Choose a country</option>{options.countries.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}</Select></Field>
      <Field label="Reporting currency" required hint="Channel accounts keep their own marketplace currencies."><Select value={currency} onChange={event => setCurrency(event.target.value)} required disabled={busy}><option value="">Choose a currency</option>{options.currencies.map(code => <option key={code} value={code}>{code}</option>)}</Select></Field>
      <Field label="Business timezone" required><Select value={timezone} onChange={event => setTimezone(event.target.value)} required disabled={busy}>{options.timezones.map(zone => <option key={zone} value={zone}>{zone}</option>)}</Select></Field>
      <p>You’ll be the owner of this profile. Next, connect its marketplace accounts.</p>
    </form>
  </Modal>
}

function RenameProfile({ profile, onClose, onSaved }: { profile: BusinessProfile; onClose: () => void; onSaved: () => Promise<void> }) {
  const formId = useId()
  const [name, setName] = useState(profile.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      const response = await fetch(`${getBackendUrl()}/api/workspaces/${profile.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, version: profile.version }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'The profile could not be renamed.')
      await onSaved(); onClose()
    } catch (err) { setError(err instanceof Error ? err.message : 'The profile could not be renamed.'); setBusy(false); inFlight.current = false }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} title={`Rename ${profile.name}`} footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Saving…' : 'Save name'}</Button></>}>
    <form id={formId} className="business-profile-form" onSubmit={submit}>{error && <Banner tone="danger">{error}</Banner>}<Field label="Business profile name" required><Input data-autofocus required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></Field></form>
  </Modal>
}
