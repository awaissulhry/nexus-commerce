'use client'

/**
 * BP.S1d / BP.S3 — lend a seller account to another business profile.
 *
 * Deliberately NOT the same dialog as `AssignAccountProfileDialog`. That one MOVES
 * ownership and refuses any account with history; this one lends an account out and
 * moves nothing. Presenting them as one control with a mode would turn the
 * difference into a setting rather than a decision.
 *
 * Two modes, and they are not degrees of one thing: `read` lends a view, `publish`
 * lends the ability to change a live marketplace listing. The copy changes with the
 * mode so the consequence is on screen before the act, never behind a tooltip.
 *
 * Every limit stated here is enforced on the server, not by this dialog: RLS gives a
 * guest no row to write (migration 20260916a), `assertCredentialOwner` refuses a
 * read guest a credential (BP.S1b), and `ChannelListingClaim` gives one seller SKU
 * to one profile at a time (BP.S3).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, Field, Modal } from '@/design-system/components'
import { Button, Select } from '@/design-system/primitives'
import type { AccountRow } from '@/design-system/components/AccountSwitcher'
import type { BusinessProfile } from '@/app/_shared/ProfileScope'
import { BusinessProfilePicker } from '@/app/_shared/BusinessProfilePicker'
import { getBackendUrl } from '@/lib/backend-url'

interface Grant {
  connectionId: string
  workspaceId: string
  workspaceName: string
  mode: string
  marketplaces: string[]
  grantedAt: string
  revokedAt: string | null
}

export function ShareAccountDialog({ account, source, onClose, onSaved }: {
  account: AccountRow
  source: BusinessProfile
  onClose: () => void
  onSaved: () => void
}) {
  const base = `${getBackendUrl()}/api/accounts/${encodeURIComponent(account.id)}/grants`
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [destination, setDestination] = useState<BusinessProfile | null>(null)
  const [mode, setMode] = useState<'read' | 'publish'>('read')
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const response = await fetch(base, { cache: 'no-store', credentials: 'include' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'The shares could not be read.')
      setGrants(result.grants ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The shares could not be read.')
    }
  }, [base])
  useEffect(() => { void load() }, [load])

  /** One in-flight guard for both writes: a double-click must not create two shares. */
  async function send(url: string, body?: object) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        // No Content-Type when there is no body: Fastify rejects an empty JSON body
        // with FST_ERR_CTP_EMPTY_JSON_BODY before the handler ever runs.
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'That change could not be saved.')
      await load()
      onSaved()
      setDestination(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change could not be saved.')
    } finally {
      inFlight.current = false; setBusy(false)
    }
  }

  const active = (grants ?? []).filter(grant => !grant.revokedAt)

  return <><Modal
    open
    title={`Share ${account.label}`}
    subtitle={mode === 'publish'
      ? `Another business profile can see this account and publish with it. ${source.name} stays its owner.`
      : 'Another business profile can see this account. It cannot change it, publish with it, or reach its sign-in.'}
    size="md"
    readable
    onClose={() => { if (!busy) onClose() }}
    footer={<>
      <Button disabled={busy} onClick={onClose}>Close</Button>
      <Button
        variant="primary"
        disabled={busy || !destination}
        onClick={() => { if (destination) void send(base, { destinationWorkspaceId: destination.id, mode }) }}
      >
        {busy ? 'Sharing…' : 'Share account'}
      </Button>
    </>}
  >
    <div className="nds-account-profile-form">
      {error && <Banner tone="danger" title="That did not work">{error}</Banner>}

      {/* Stated before the act and differently per mode: the operator is about to
          give another business sight of, or a hand on, a live seller account. */}
      <Banner tone="info" title="What sharing does">
        <ul>
          <li><strong>{source.name}</strong> stays the owner. Orders, the marketplace sign-in and the account settings do not move.</li>
          <li>The other profile sees the account and its markets. It does not see your products, listings or orders.</li>
          <li>It cannot rename, reconnect or disconnect the account.</li>
          {mode === 'publish'
            ? <li><strong>It can publish with this account.</strong> Each seller SKU belongs to one profile at a time, so it cannot touch a listing you already publish — and you cannot touch one it claims first.</li>
            : <li>It cannot publish with this account.</li>}
          <li>You can take the share back at any time.</li>
        </ul>
      </Banner>

      <Field label="What they can do" hint={mode === 'publish'
        ? 'Publishing reaches the real marketplace with your seller account.'
        : 'Read-only is the safe default.'}>
        <Select value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'read' | 'publish')}>
          <option value="read">See the account only</option>
          <option value="publish">See it and publish with it</option>
        </Select>
      </Field>

      <Field label="Share with" hint="You must be an owner of both business profiles.">
        <Button
          disabled={busy}
          aria-haspopup="dialog"
          aria-label={`Share with business profile: ${destination?.name ?? 'Choose a profile'}`}
          onClick={() => setChoosing(true)}
        >
          {destination?.name ?? 'Choose a business profile'}
        </Button>
      </Field>

      {grants === null && <p role="status">Reading who this account is shared with…</p>}
      {grants !== null && active.length === 0 && <p role="status">This account is not shared with any other profile.</p>}
      {active.length > 0 && <div>
        <h3>Shared with</h3>
        <ul>
          {active.map(grant => (
            <li key={grant.workspaceId}>
              <strong>{grant.workspaceName}</strong>
              {grant.mode === 'publish' ? ' — can publish' : ' — read-only'}
              {grant.marketplaces.length > 0 && ` · ${grant.marketplaces.join(', ')}`}
              {' '}
              <Button
                size="sm"
                variant="danger-outline"
                disabled={busy}
                onClick={() => void send(`${base}/${encodeURIComponent(grant.workspaceId)}/revoke`)}
              >
                Stop sharing
              </Button>
            </li>
          ))}
        </ul>
      </div>}
    </div>
  </Modal>
  {choosing && <BusinessProfilePicker
    title="Share with business profile"
    value={destination?.id}
    permission="owner"
    excludeId={source.id}
    onClose={() => setChoosing(false)}
    onSelect={profile => { setDestination(profile); setChoosing(false) }}
  />}</>
}
