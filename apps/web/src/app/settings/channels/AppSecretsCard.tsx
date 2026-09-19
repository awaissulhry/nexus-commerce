'use client'

/**
 * P0.5 (docs/channel-connections/FINAL-PLAN.md) — the "App secrets" card on the Diagnostics tab.
 *
 * Our own app credentials at each channel are not tied to any one account, so this card sits above
 * the account picker. It shows the recorded expiry date and the days left, and lets an admin record
 * the date read from the channel's developer portal (`PUT /api/cx/apps/:channelKey/secret-expiry`).
 * The API never returns a secret. Alerts at 90 / 30 / 7 days run in the heartbeat.
 */

import { useCallback, useEffect, useState } from 'react'
import { Banner, Card, DateField, EmptyState, Field } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { appSecretStatus, expiryInputValue, sortAppSecrets, type AppSecretRow } from './app-secrets'

export function AppSecretsCard() {
  const api = getBackendUrl()
  const [rows, setRows] = useState<AppSecretRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  useEffect(() => { void load() }, [load])

  return (
    <Card
      header="App secrets"
      description="Our own app credentials at each channel. Amazon requires a new SP-API app secret every 180 days; when it expires, every Amazon call stops."
    >
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
