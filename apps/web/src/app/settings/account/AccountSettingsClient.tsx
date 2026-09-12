'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BUSINESS_COUNTRIES } from '@nexus/shared/business-profile'
import { Banner, Card, Field } from '@/design-system/components'
import { Button, Input, Select } from '@/design-system/primitives'
import { registerProfileChanges } from '@/lib/workspaces/unsaved-changes'
import { saveAccountSettings } from './actions'
import './account-settings.css'
const intl = Intl as typeof Intl & { supportedValuesOf(key: 'currency' | 'timeZone'): string[] }

export interface AccountSettingsData {
  businessName: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postalCode: string
  country: string
  timezone: string
  currency: string
  primaryMarketplace: string | null
  updatedAt: string
}

export default function AccountSettingsClient({ settings }: { settings: AccountSettingsData | null }) {
  const [saved, setSaved] = useState(settings)
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const current = useRef({ draft, saved })
  current.current = { draft, saved }
  const inFlight = useRef<Promise<void> | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const names = useMemo(() => new Intl.DisplayNames(['en'], { type: 'region' }), [])
  const currencies = useMemo(() => intl.supportedValuesOf('currency'), [])
  const timezones = useMemo(() => intl.supportedValuesOf('timeZone'), [])
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  const save = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current
    if (!current.current.draft || !form.current?.reportValidity()) return Promise.reject(new Error('Complete the required business settings.'))
    const submitted = { ...current.current.draft }
    const data = new FormData()
    for (const [key, value] of Object.entries(submitted)) data.set(key, value ?? '')
    setBusy(true); setMessage(null)
    const pending = (async () => {
      try {
        const result = await saveAccountSettings(data)
        const next = { ...submitted, updatedAt: result.updatedAt }
        current.current = { draft: next, saved: next }
        setSaved(next); setDraft(next)
        setMessage({ tone: 'success', text: 'Business settings saved.' })
      } catch (error) {
        setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Business settings could not be saved.' })
        throw error
      } finally { setBusy(false); inFlight.current = null }
    })()
    inFlight.current = pending
    return pending
  }, [])
  useEffect(() => registerProfileChanges('business-settings', {
    isDirty: () => !!inFlight.current || JSON.stringify(current.current.draft) !== JSON.stringify(current.current.saved),
    save,
    canDiscard: () => !inFlight.current,
    discard: () => { if (!inFlight.current) { current.current.draft = current.current.saved; setDraft(current.current.saved); setMessage(null) } },
  }), [save])
  useEffect(() => {
    if (!dirty && !busy) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, busy])

  if (!draft) return <Banner tone="danger" title="Business settings are unavailable">Reload this page before editing settings.</Banner>
  const update = (key: keyof AccountSettingsData, value: string) => { setDraft(row => row && { ...row, [key]: value }); setMessage(null) }
  const input = (key: keyof AccountSettingsData, label: string, options: { required?: boolean; maxLength?: number; hint?: string } = {}) => <Field label={label} required={options.required} hint={options.hint}><Input value={draft[key] ?? ''} onChange={event => update(key, event.target.value)} required={options.required} maxLength={options.maxLength ?? 200} disabled={busy} /></Field>
  return <form ref={form} className="business-settings-form" onSubmit={event => { event.preventDefault(); void save().catch(() => {}) }}>
    {message && <Banner tone={message.tone}>{message.text}</Banner>}
    <Card header="Business information" padded><div className="business-settings-fields">{input('businessName', 'Business name', { required: true, maxLength: 80, hint: 'Used in business records. Manage the profile’s display name in Business profiles.' })}</div></Card>
    <Card header="Business address" padded><div className="business-settings-fields">
      {input('addressLine1', 'Address line 1')}{input('addressLine2', 'Address line 2')}
      <div className="business-settings-pair">{input('city', 'City')}{input('state', 'State / province')}</div>
      <div className="business-settings-pair">{input('postalCode', 'Postal code', { maxLength: 32 })}<Field label="Country" required><Select value={draft.country} onChange={event => update('country', event.target.value)} disabled={busy} required>{BUSINESS_COUNTRIES.map(code => <option key={code} value={code}>{names.of(code)}</option>)}</Select></Field></div>
    </div></Card>
    <Card header="Business defaults" padded><div className="business-settings-fields">
      <Field label="Business timezone" required><Select value={draft.timezone} onChange={event => update('timezone', event.target.value)} disabled={busy} required>{[...new Set([draft.timezone, 'UTC', ...timezones])].filter(Boolean).map(zone => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}</Select></Field>
      <Field label="Reporting currency" required hint="Historical order and listing currencies stay as recorded."><Select value={draft.currency} onChange={event => update('currency', event.target.value)} disabled={busy} required>{[...new Set([draft.currency, ...currencies])].filter(Boolean).map(code => <option key={code} value={code}>{code}</option>)}</Select></Field>
      {input('primaryMarketplace', 'Primary marketplace', { maxLength: 2, hint: 'Optional country code, such as IT, DE, or US. Used as a starting selection when preparing listings.' })}
    </div></Card>
    <div className="business-settings-actions"><Button disabled={busy || !dirty} onClick={() => { setDraft(saved); setMessage(null) }}>Discard changes</Button><Button type="submit" variant="primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save settings'}</Button></div>
  </form>
}
