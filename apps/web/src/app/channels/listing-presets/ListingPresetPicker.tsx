'use client'

import { useEffect, useRef, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { Banner, Drawer, KeyValue, ProgressBar } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import ListingPresetsClient, { type WizardTemplateRow } from './ListingPresetsClient'
import { displayPresetDefaults } from './preset-display'

interface Preview {
  wizardId: string
  expectedVersion: number
  expectedWizardUpdatedAt: string
  expectedPresetUpdatedAt: string
  before: { channels: WizardTemplateRow['channels']; state: Record<string, unknown> }
  after: { channels: WizardTemplateRow['channels']; state: Record<string, unknown> }
  excluded: string[]
}
const stack = { display: 'grid', gap: 'var(--nds-space-12)' } as const
const destinations = (channels: WizardTemplateRow['channels']) => channels.map(c => `${c.platform} ${c.marketplace}`).join(' · ') || 'None selected'

/** The same paginated library and API as management, with an explicit apply-once review. */
export function ListingPresetPicker({ wizardId, productLabel, beforePreview }: {
  wizardId: string
  productLabel: string
  /** Saves any choices already edited in Step 1; a failed save must stop review. */
  beforePreview: () => Promise<boolean>
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<WizardTemplateRow | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  // The chosen row disappears when review opens. Keep keyboard focus inside the dialog.
  useEffect(() => { if (open) bodyRef.current?.focus() }, [open, selected, preview, error])
  const choose = async (row: WizardTemplateRow) => {
    if (busy) return
    setBusy(true); setError(''); setSelected(row); setPreview(null)
    try {
      if (!await beforePreview()) throw new Error('Your current wizard choices could not be saved. Close this review and resolve the save error before applying a preset.')
      const res = await fetch(`${getBackendUrl()}/api/wizard-templates/${encodeURIComponent(row.id)}/apply`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wizardId, dryRun: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Preview failed (${res.status})`)
      setPreview(data.preview)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const apply = async () => {
    if (!selected || !preview || busy) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${getBackendUrl()}/api/wizard-templates/${encodeURIComponent(selected.id)}/apply`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wizardId, expectedVersion: preview.expectedVersion, expectedWizardUpdatedAt: preview.expectedWizardUpdatedAt, expectedPresetUpdatedAt: preview.expectedPresetUpdatedAt }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Apply failed (${res.status})`)
      // All current choices were persisted before preview; reload the canonical wizard state.
      window.location.reload()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPreview(null); setBusy(false) }
  }
  const close = () => { if (!busy) { setOpen(false); setSelected(null); setPreview(null); setError('') } }
  const before = new Map(preview ? displayPresetDefaults(preview.before.state).map(row => [row.key, row]) : [])
  const after = new Map(preview ? displayPresetDefaults(preview.after.state).map(row => [row.key, row]) : [])
  const comparison = [...new Set([...before.keys(), ...after.keys()])].map(key => ({
    key, label: after.get(key)?.label ?? before.get(key)?.label ?? key,
    before: before.get(key)?.value ?? 'Not set', after: after.get(key)?.value ?? 'Not set',
  }))
  return <>
    <Button size="sm" onClick={() => setOpen(true)}>Listing presets</Button>
    <Drawer open={open} title={selected ? `Review ${selected.name}` : 'Choose a listing preset'} width={900} onClose={close}
      footer={<><Button disabled={busy} onClick={close}>Close</Button>{selected && <>
        <Button disabled={busy} onClick={() => { setSelected(null); setPreview(null); setError('') }}>Back to presets</Button>
        {!preview && <Button disabled={busy} onClick={() => void choose(selected)}>Refresh preview</Button>}
        <Button variant="primary" disabled={busy || !preview} onClick={() => void apply()}>Apply once to this wizard</Button>
      </>}</>}>
      <div style={stack} ref={bodyRef} tabIndex={-1} role="region" aria-label={selected ? 'Preset review' : 'Listing preset choices'}>
        {error && <Banner tone="danger">{error}</Banner>}
        {busy && <ProgressBar indeterminate ariaLabel={preview ? 'Applying listing preset' : 'Preparing listing preset review'} />}
        {!selected && <>
          <p>Choosing a preset saves your current destination and SKU choices before preparing the review.</p>
          <ListingPresetsClient onChoose={row => void choose(row)} choosing={busy} />
          <Button asChild variant="link"><Link href="/channels/listing-presets">Manage reusable listing presets</Link></Button>
        </>}
        {preview && <>
          <Banner tone="info" title="Apply once to this wizard">
            This replaces the selected destinations and fills missing reusable defaults. Existing field values, prices and selected variants are preserved.
            Future products are unaffected. Destination requirements are checked in the wizard; publication remains a separate action.
          </Banner>
          <KeyValue items={[
            { label: 'Current destinations', value: destinations(preview.before.channels) },
            { label: 'Destinations after applying', value: destinations(preview.after.channels) },
            { label: 'Product', value: productLabel },
            { label: 'Preset last changed', value: new Date(preview.expectedPresetUpdatedAt).toLocaleString() },
          ]} />
          <p>The listing wizard currently uses each channel's primary account. This preset does not select an alternate account or change content language.</p>
          <DataGrid ariaLabel="Preset changes" rowKey={row => row.key} rows={comparison} emptyState="No SKU or variation defaults to add." columns={[
            { key: 'label', label: 'Setting', render: row => row.label },
            { key: 'before', label: 'Current choice', render: row => row.before },
            { key: 'after', label: 'After applying', render: row => row.after },
          ]} />
          {!!preview.excluded.length && <Banner tone="warning" title="Older product-specific defaults excluded">{preview.excluded.join(', ')}. These values will not be copied from the preset.</Banner>}
        </>}
      </div>
    </Drawer>
  </>
}
