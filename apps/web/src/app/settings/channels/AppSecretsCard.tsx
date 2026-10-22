'use client'

/**
 * P0.5 (docs/channel-connections/FINAL-PLAN.md) — the "App secrets" card on the Diagnostics tab.
 *
 * Our own app credentials at each channel are not tied to any one account, so this card sits above
 * the account picker. It shows the recorded expiry date and the days left, and lets an admin record
 * the date read from the channel's developer portal (`PUT /api/cx/apps/:channelKey/secret-expiry`).
 * The API never returns a secret. Alerts at 90 / 30 / 7 days run in the heartbeat.
 *
 * Google (2026-10-13): Nexus signs in to Google with the Owner's own Google Cloud OAuth client. The card
 * shows the redirect URI to register there and takes the client ID + secret (`PUT /api/cx/apps/GOOGLE/
 * credentials`, only an Owner of every business profile with Google connected). The secret is write-only: once saved
 * it is never shown again.
 *
 * Amazon Ads (2026-10-22): the same list. The card shows the client ID Nexus uses, read-only (a different client would
 * sign every Ads account out), and takes a new secret after Reset Secret in Amazon's developer console. No redirect URI.
 */

import { useCallback, useEffect, useState } from 'react'
import { Banner, Card, DateField, EmptyState, Field } from '@/design-system/components'
import { Button, Input, Pill, Skeleton } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import {
  appCredentialsFormProblem, appCredentialsStatus, appSecretStatus, expiryInputValue, rotationNote, sortAppSecrets,
  type AppCredentialsRow, type AppSecretRow,
} from './app-secrets'

export function AppSecretsCard() {
  const api = getBackendUrl()
  const [rows, setRows] = useState<AppSecretRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<AppCredentialsRow[] | null>(null)
  const [credentialsError, setCredentialsError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${api}/api/cx/apps`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { apps: AppSecretRow[] }
      setRows(sortAppSecrets(data.apps ?? []))
      setError(null)
    } catch (err) {
      setRows([])
      setError(err instanceof Error ? err.message : 'Failed to load the app secrets')
    }
  }, [api])

  // Read on its own: a failure of one list never hides the other.
  const loadCredentials = useCallback(async () => {
    try {
      const res = await fetch(`${api}/api/cx/apps/credentials`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { apps: AppCredentialsRow[] }
      setCredentials(data.apps ?? [])
      setCredentialsError(null)
    } catch (err) {
      setCredentials([])
      setCredentialsError(err instanceof Error ? err.message : 'Failed to load the sign-in apps')
    }
  }, [api])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadCredentials() }, [loadCredentials])
  const reloadAll = useCallback(async () => { await Promise.all([load(), loadCredentials()]) }, [load, loadCredentials])

  return (
    <Card
      header="App secrets"
      description="Our own app credentials at each channel. Amazon requires a new SP-API app secret every 180 days; when it expires, every Amazon call stops. Google needs the client ID and secret of our Google Cloud OAuth client before any business can connect Google. The Amazon Ads app's secret is set here too."
    >
      {credentialsError && (
        <Banner tone="danger" title="The app sign-in settings could not be loaded">
          {credentialsError}
        </Banner>
      )}
      {credentials === null ? (
        <Skeleton height={96} />
      ) : (
        credentials.length > 0 && (
          <div className="nds-app-secrets">
            {credentials.map((row) => (
              <AppCredentialsItem key={`${row.channelKey}:${row.environment}`} row={row} onSaved={reloadAll} />
            ))}
          </div>
        )
      )}
      {error && (
        <Banner tone="danger" title="App secrets could not be loaded">
          {error}
        </Banner>
      )}
      {rows === null ? (
        <Skeleton height={96} />
      ) : rows.length === 0 ? (
        !error && <EmptyState title="No channel apps set up" description="An app row is created the first time a channel's credentials are configured." />
      ) : (
        <div className="nds-app-secrets">
          {rows.map((row) => (
            <AppSecretItem key={`${row.channelKey}:${row.environment}`} row={row} onSaved={load} />
          ))}
        </div>
      )}
    </Card>
  )
}

function AppSecretItem({ row, onSaved }: { row: AppSecretRow; onSaved: () => Promise<void> }) {
  const api = getBackendUrl()
  const status = appSecretStatus(row)
  const saved = expiryInputValue(row)
  const [value, setValue] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  useEffect(() => { setValue(saved) }, [saved])
  const dirty = value !== saved

  const save = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${api}/api/cx/apps/${row.channelKey}/secret-expiry`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresAt: value || null, environment: row.environment }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      await onSaved()
      setResult({ tone: 'success', text: value ? 'Expiry date saved.' : 'Expiry date cleared.' })
    } catch (err) {
      setResult({ tone: 'danger', text: err instanceof Error ? err.message : 'The date was not saved.' })
    } finally {
      setBusy(false)
    }
  }

  const name = `${row.label}${row.environment === 'production' ? '' : ` (${row.environment})`}`
  return (
    <div className="nds-app-secret">
      <div className="nds-app-secret-info">
        <div className="nds-app-secret-head">
          <span className="nds-app-secret-name">{name}</span>
          <Pill tone={status.tone} dot size="sm">
            {status.label}
          </Pill>
        </div>
        <p className="nds-app-secret-detail">{status.detail}</p>
        {rotationNote(row) && <p className="nds-app-secret-detail">{rotationNote(row)}</p>}
      </div>
      <div className="nds-app-secret-form">
        <div className="nds-app-secret-date">
          <Field label="Secret expires on">
            <DateField value={value} onChange={setValue} clearable clearLabel="Clear the date" ariaLabel={`${name} secret expiry date`} />
          </Field>
        </div>
        <Button variant="secondary" size="sm" aria-disabled={busy || !dirty || undefined} onClick={() => { if (!busy && dirty) void save() }}>
          {busy ? 'Saving…' : 'Save date'}
        </Button>
      </div>
      {result && (
        <Banner tone={result.tone} title={result.tone === 'success' ? result.text : 'The date was not saved'}>
          {result.tone === 'danger' ? result.text : undefined}
        </Banner>
      )}
    </div>
  )
}

/**
 * Google: the redirect URI to register, and the client ID + secret (write-only) an Owner pastes.
 * Amazon Ads: the client ID Nexus uses (read-only) and a new secret (write-only).
 */
function AppCredentialsItem({ row, onSaved }: { row: AppCredentialsRow; onSaved: () => Promise<void> }) {
  const api = getBackendUrl()
  const ads = row.channelKey === 'AMAZON_ADS'
  const status = appCredentialsStatus(row)
  const [clientId, setClientId] = useState(row.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'success' | 'danger' | 'info'; title: string; text?: string } | null>(null)
  useEffect(() => { setClientId(row.clientId ?? '') }, [row.clientId])
  const name = `${row.label} sign-in app`

  const copy = async () => {
    if (!row.redirectUri) return
    try {
      await navigator.clipboard.writeText(row.redirectUri)
      setResult({ tone: 'info', title: 'Redirect URI copied.' })
    } catch {
      setResult({ tone: 'danger', title: 'The redirect URI was not copied', text: 'This browser did not allow it. Select the address in the field and copy it.' })
    }
  }

  const save = async () => {
    const problem = appCredentialsFormProblem(clientId, clientSecret, row.channelKey)
    if (problem) { setResult({ tone: 'danger', title: 'Nothing was saved', text: problem }); return }
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${api}/api/cx/apps/${row.channelKey}/credentials`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setClientSecret('')
      await onSaved()
      setResult({ tone: 'success', title: ads ? 'Saved. Nexus now uses the new Amazon Ads secret.' : 'Saved. Google can now be connected.' })
    } catch (err) {
      setResult({ tone: 'danger', title: 'Nothing was saved', text: err instanceof Error ? err.message : 'The client was not saved.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="nds-app-secret"
      aria-label={name}
      onSubmit={(event) => { event.preventDefault(); if (!busy) void save() }}
    >
      <div className="nds-app-secret-info">
        <div className="nds-app-secret-head">
          <span className="nds-app-secret-name">{name}</span>
          <Pill tone={status.tone} dot size="sm">
            {status.label}
          </Pill>
        </div>
        <p className="nds-app-secret-detail">{status.detail}</p>
        {ads ? (
          <p className="nds-app-secret-detail">
            In the Amazon developer console (Login with Amazon → Security Profiles → Nexus Commerce → Web Settings), click
            Reset Secret, then paste the new secret here. The client ID stays the same. Nexus starts using the new secret at
            once.
          </p>
        ) : (
          <p className="nds-app-secret-detail">
            In Google Cloud, create an OAuth client of type “Web application”, add the redirect URI below to its authorised
            redirect URIs, then paste its client ID and secret here. They serve every business profile, so only an Owner of
            every business profile with Google connected can save them.
          </p>
        )}
        <div className="nds-app-secrets">
          {!ads && row.redirectUri && (
            <Field label="Redirect URI" hint="Register this exact address in Google Cloud.">
              <Input value={row.redirectUri} readOnly spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
            </Field>
          )}
          {ads ? (
            <Field label="Client ID">
              <Input value={clientId} readOnly spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
            </Field>
          ) : (
            <Field label="Client ID" hint="Ends in .apps.googleusercontent.com.">
              <Input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          )}
          <Field
            label="Client secret"
            hint={row.secretSet ? 'A secret is saved. It is never shown; paste a new one to replace it.' : 'Stored encrypted and never shown again.'}
          >
            <Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" spellCheck={false} />
          </Field>
        </div>
      </div>
      <div className="nds-app-secret-form">
        {!ads && row.redirectUri && (
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            Copy redirect URI
          </Button>
        )}
        <Button type="submit" variant="primary" size="sm" aria-disabled={busy || undefined}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {!ads && row.redirectUriProblem && (
        <Banner tone="warning" title="The redirect URI is not ready">
          {row.redirectUriProblem}
        </Banner>
      )}
      {result && (
        <Banner tone={result.tone} title={result.title}>
          {result.text}
        </Banner>
      )}
    </form>
  )
}
