'use client'

import { useEffect, useRef, useState } from 'react'
import { Banner, Drawer, KeyValue, ProgressBar } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useProfileScope } from '@/app/_shared/ProfileScope'
import { getBackendUrl } from '@/lib/backend-url'
import ListingPresetsClient, { type WizardTemplateRow } from '@/app/channels/listing-presets/ListingPresetsClient'
import { createPresetRequestGate, displayPresetValue, productPresetDraftHref, productPresetScopeKey, type ProductPresetScope } from './product-preset-contract'

interface Review {
  scope: ProductPresetScope; reviewKey: string; wizardId: string | null
  preset: { id: string; name: string; updatedAt: string }
  product: { name: string; sku: string }; account: { id: string; name: string | null }
  listing: { id: string; title: string | null } | null
  before: { absent?: boolean; value?: unknown }; after: { absent?: boolean; value?: unknown }
  changed: boolean; excluded: string[]
  skuFields: Array<{ label: string; before: { absent?: boolean; value?: unknown }; after: { absent?: boolean; value?: unknown }; changed: boolean }>
}
interface Props {
  scope: ProductPresetScope; productLabel: string; accountLabel: string; listingLabel: string
  wizardId?: string
  open?: boolean; onClose?: () => void
}
const stack = { display: 'grid', gap: 'var(--nds-space-16)', minWidth: 0 } as const

/** Information action. The coordinator mounts it with the exact selected row/listing coordinate. */
export function ProductListingPresets(props: Props) {
  return <ProductListingPresetsScope key={`${productPresetScopeKey(props.scope)}:${props.wizardId ?? ''}`} {...props} />
}
function ProductListingPresetsScope({ scope, productLabel, accountLabel, listingLabel, wizardId, open: controlledOpen, onClose }: Props) {
  const { status } = useAuth(), { has } = useProfileScope()
  const canApply = status !== 'authed' || has('listings.publish')
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [review, setReview] = useState<Review | null>(null), [error, setError] = useState('')
  const [receipt, setReceipt] = useState<{ wizardId: string; replayed: boolean } | null>(null)
  const gate = useRef(createPresetRequestGate())
  useEffect(() => { const requests = gate.current; return () => requests.cancel() }, [])
  const close = () => { if (busy) return; gate.current.cancel(); setOpen(false); onClose?.(); setReview(null); setError('') }
  const choose = async (row: WizardTemplateRow) => {
    const request = gate.current.begin()
    setBusy(true); setError(''); setReview(null); setReceipt(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/wizard-templates/${encodeURIComponent(row.id)}/apply`, {
        method: 'POST', credentials: 'include', signal: request.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productContext: scope, wizardId, dryRun: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not review this preset.')
      if (request.current()) {
        if (productPresetScopeKey(data.preview.scope) !== productPresetScopeKey(scope)) throw new Error('The destination changed. Review again.')
        setReview(data.preview)
      }
    } catch (e) { if (request.current()) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (request.current()) setBusy(false) }
  }
  const apply = async () => {
    if (!review || busy || !canApply) return
    const request = gate.current.begin()
    setBusy(true); setError('')
    try {
      const res = await fetch(`${getBackendUrl()}/api/wizard-templates/${encodeURIComponent(review.preset.id)}/apply`, {
        method: 'POST', credentials: 'include', signal: request.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productContext: scope, wizardId: review.wizardId ?? undefined, reviewKey: review.reviewKey }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (request.current() && res.status === 409) setReview(null)
        throw new Error(data.error ?? 'Could not apply this preset.')
      }
      if (request.current()) {
        if (productPresetScopeKey(data.wizard.state.productPresetScope) !== productPresetScopeKey(scope)) throw new Error('The saved draft does not match this destination. Reload the product scope.')
        setReceipt({ wizardId: data.wizard.id, replayed: data.replayed }); setReview(null)
      }
    } catch (e) { if (request.current()) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (request.current()) setBusy(false) }
  }
  return <>
    {controlledOpen === undefined && <Button size="sm" onClick={() => setOpen(true)}>Listing presets</Button>}
    <Drawer open={controlledOpen ?? open} onClose={close} title="Listing defaults for this product" width={900}
      footer={<>
        <Button disabled={busy} onClick={close}>{receipt ? 'Close' : 'Cancel'}</Button>
        {review && <Button disabled={busy || !review.changed || !canApply} variant="primary" onClick={() => void apply()}>Apply once to draft</Button>}
      </>}>
      <div style={stack}>
        <KeyValue items={[
          { label: 'Product / family', value: review ? `${review.product.sku} · ${review.product.name}` : productLabel }, { label: 'Channel', value: scope.channel },
          { label: 'Account', value: `${review?.account.name ?? accountLabel} · ${scope.accountId}` }, { label: 'Market', value: scope.market },
          { label: 'Listing', value: `${listingLabel}${scope.listingId ? ` · ${scope.listingId}` : ''}` },
        ]} />
        <Banner tone="info" title="Apply once to a listing draft">
          Fill missing compatible defaults for the primary connected account and primary listing. Variation themes use its product classification. An unlisted Amazon destination can also receive future parent/variant listing SKU settings. Existing choices, selected variants, product facts, existing SKUs, prices, stock and the reusable preset stay unchanged. Publishing is separate.
        </Banner>
        {scope.aliasKey && <Banner tone="warning">Aliases are not supported by the listing wizard. This listing cannot receive preset defaults yet.</Banner>}
        {busy && <ProgressBar indeterminate ariaLabel={review ? 'Saving preset defaults' : 'Reviewing preset'} />}
        {error && <Banner tone="danger">{error}</Banner>}
        {receipt ? <Banner tone="success" title={receipt.replayed ? 'Draft save already completed' : 'Listing draft saved'}>
          The reviewed defaults are saved in this product’s listing draft. No listing was published or updated.
          <div style={{ marginTop: 'var(--nds-space-12)' }}><Button asChild><a href={productPresetDraftHref(receipt.wizardId, scope)}>Resume this draft</a></Button></div>
        </Banner> : review ? <section style={stack} aria-label="Review preset defaults">
          <h3>{review.preset.name}</h3>
          <KeyValue items={[{ label: 'Variation theme before', value: displayPresetValue(review.before) }, { label: 'Variation theme after', value: displayPresetValue(review.after) }, { label: 'Target', value: review.wizardId ? `Existing draft ${review.wizardId}` : 'New listing draft' }]} />
          {!!review.skuFields?.length && <KeyValue items={review.skuFields.flatMap(field => [{ label: `${field.label} before`, value: displayPresetValue(field.before) }, { label: `${field.label} after`, value: displayPresetValue(field.after) }])} />}
          {!review.changed && <Banner tone="neutral">Existing explicit choices are preserved. There are no missing compatible defaults to apply.</Banner>}
          {!!review.excluded.length && <Banner tone="warning" title="Excluded from this application"><ul>{review.excluded.map((item, i) => <li key={`${i}:${item}`}>{item}</li>)}</ul></Banner>}
          <p>This is a one-time draft save. It creates no standing rule for this product or future products. Publishing from these product drafts is not available yet.</p>
          <Button disabled={busy} onClick={() => { gate.current.cancel(); setReview(null); setError('') }}>Choose another preset</Button>
        </section> : <ListingPresetsClient channel={scope.channel} market={scope.market} onChoose={row => void choose(row)} choosing={busy || !!scope.aliasKey} productContext />}
        <div><Button asChild variant="link"><a href="/channels/listing-presets" target="_blank" rel="noreferrer">Manage shared presets (all products)</a></Button></div>
      </div>
    </Drawer>
  </>
}
