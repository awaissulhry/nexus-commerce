'use client'
import { useEffect } from 'react'
import { Banner, KeyValue } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import type { StepProps } from '@/app/products/[id]/list-wizard/ListWizardClient'
import { ProductListingPresets } from './ProductListingPresets'
import type { ProductPresetScope } from './product-preset-contract'

export function BoundPresetDestination({ wizardState, product, wizardId, updateWizardState, reportValidity }: StepProps) {
  const scope = wizardState.productPresetScope as ProductPresetScope
  useEffect(() => { reportValidity({ valid: true, blockers: 0 }) }, [reportValidity])
  return <section style={{ display: 'grid', gap: 'var(--nds-space-16)', padding: 'var(--nds-space-24)' }}>
    <Banner tone="info" title="Reviewed product destination">This draft retains the account and primary listing chosen in Information. Other destinations require their own review. Publishing remains separate.</Banner>
    <KeyValue items={[{ label: 'Product / family', value: `${product.sku} · ${product.name}` }, { label: 'Channel / market', value: `${scope.channel} · ${scope.market}` }, { label: 'Account', value: scope.accountId }, { label: 'Primary listing', value: scope.listingId ?? 'New listing draft' }]} />
    <div><ProductListingPresets scope={scope} wizardId={wizardId} productLabel={`${product.sku} · ${product.name}`} accountLabel="Reviewed primary account" listingLabel="Primary listing" /></div>
    <div><Button variant="primary" onClick={() => void updateWizardState({}, { advance: true })}>Continue with this destination</Button></div>
  </section>
}
