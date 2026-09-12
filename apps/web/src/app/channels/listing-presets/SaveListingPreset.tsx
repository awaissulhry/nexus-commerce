'use client'

import { useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { Banner, Drawer, Field } from '@/design-system/components'
import { Button, Input, Textarea } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { useNavigationGuard } from '@/app/products/[id]/edit/_shared/useNavigationGuard'

export function SaveListingPreset({ wizardId }: { wizardId: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [categoryHint, setCategoryHint] = useState('')
  const [error, setError] = useState(''), [saved, setSaved] = useState(false)
  useNavigationGuard({ enabled: busy || (open && !!(name || description || categoryHint)) })
  const close = () => {
    if (busy || ((name || description || categoryHint) && !window.confirm('Discard this unsaved listing preset?'))) return
    setOpen(false); setName(''); setDescription(''); setCategoryHint(''); setError('')
  }
  const save = async () => {
    if (busy || !name.trim()) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${getBackendUrl()}/api/wizard-templates/from-wizard/${encodeURIComponent(wizardId)}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), categoryHint: categoryHint.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`)
      setSaved(true); setOpen(false); setName(''); setDescription(''); setCategoryHint('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <>
    <Button variant="link" onClick={() => { setSaved(false); setOpen(true) }}>Save as listing preset</Button>
    {saved && <Banner tone="success" action={<Button asChild variant="link"><Link href="/channels/listing-presets">Open preset library</Link></Button>}>Listing preset saved. No listings were changed or published.</Banner>}
    <Drawer open={open} title="Save listing preset" onClose={close}
      footer={<><Button disabled={busy} onClick={close}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save preset'}</Button></>}>
      <div style={{ display: 'grid', gap: 'var(--nds-space-12)' }}>
        <Banner tone="info">Saves the current wizard's destinations, SKU strategy and variation-theme defaults. Product facts, identifiers, images, prices, inventory and selected variants stay with this product. Applying the preset is a separate, one-time action.</Banner>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input required maxLength={120} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Description"><Textarea maxLength={500} rows={3} value={description} disabled={busy} onChange={e => setDescription(e.target.value)} /></Field>
        <Field label="Product hint" hint="A suggestion for operators, not an automatic category rule."><Input maxLength={60} value={categoryHint} disabled={busy} onChange={e => setCategoryHint(e.target.value)} /></Field>
      </div>
    </Drawer>
  </>
}
