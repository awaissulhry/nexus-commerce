'use client'

import { useId, useState } from 'react'
import { Banner, Field, Listbox, Modal } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import { useProfileScope, type BusinessProfile } from '@/app/_shared/ProfileScope'
import { BusinessProfilePicker } from '@/app/_shared/BusinessProfilePicker'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'
import type { CatalogueChannel } from './channels-data'
import type { StartOptions } from './useConnectPopup'
import { isShopifyDomain, normalizeShopifyDomain } from './shopify-domain'
import { useConnectionReadiness } from './useConnectionReadiness'

export function ConnectAccountDialog({ channel, options, accountLabel, busy, error, onStart, onClose }: {
  channel: CatalogueChannel
  options: StartOptions
  accountLabel?: string
  busy: boolean
  error: string | null
  onStart: (options: StartOptions, profile?: BusinessProfile) => Promise<boolean>
  onClose: () => void
}) {
  const formId = useId()
  const { profiles, activeProfile, loaded, error: profilesError, refresh } = useProfileScope()
  const reconnecting = !!options.targetConnectionId
  const [chosenProfile, setChosenProfile] = useState<BusinessProfile | null>(null)
  const [choosingProfile, setChoosingProfile] = useState(false)
  const chosenId = options.workspaceId ?? activeProfile?.id
  const candidate = chosenProfile ?? (activeProfile?.id === chosenId ? activeProfile : profiles.find(profile => profile.id === chosenId))
  // A stale or revoked choice never silently falls back to another profile.
  const selected = candidate?.status === 'active' && (candidate.canConnectAccounts ?? candidate.isOwner) ? candidate : undefined
  const [region, setRegion] = useState(options.region ?? channel.defaultRegion ?? '')
  const shopify = channel.key === 'SHOPIFY'
  const [shopDomain, setShopDomain] = useState(shopify ? (options.region ?? '') : '')
  const [shopDomainTouched, setShopDomainTouched] = useState(false)
  const normalizedShopDomain = normalizeShopifyDomain(shopDomain)
  const shopDomainValid = !shopify || isShopifyDomain(shopDomain)
  const close = () => { if (!busy) onClose() }
  const profileReady = !WORKSPACES_ENABLED || (loaded && !profilesError && !!selected)
  const setup = useConnectionReadiness(channel.key, WORKSPACES_ENABLED ? selected?.id : undefined)
  const ready = setup.ready && profileReady && (!channel.regions.length || !!region) && shopDomainValid

  const startConnection = () => {
    if (busy) return
    if (!ready) {
      if (shopify) setShopDomainTouched(true)
      return
    }
    void onStart({
      ...options,
      workspaceId: WORKSPACES_ENABLED ? selected?.id : undefined,
      region: shopify ? normalizedShopDomain : (region || undefined),
    }, selected).then(started => { if (started) onClose() })
  }

  return <><Modal open onClose={close} title={`${reconnecting ? 'Reconnect' : 'Connect'} ${channel.displayName}`}
    subtitle={reconnecting ? accountLabel : WORKSPACES_ENABLED ? 'Choose the business profile for this account.' : shopify ? 'Enter the store you want to authorize.' : undefined} size="md" readable
    footer={<><Button disabled={busy} onClick={close}>Cancel</Button><Button variant="primary" type="submit" form={formId} disabled={busy || !ready}>{busy ? 'Opening sign-in…' : `Continue to ${channel.displayName}`}</Button></>}>
    <form id={formId} className="nds-account-profile-form" onSubmit={event => { event.preventDefault(); startConnection() }}>
      {setup.checking && <p role="status">Checking {channel.displayName} connection setup…</p>}
      {setup.error && <Banner tone="warning" title={`${channel.displayName} connection needs setup`} action={<Button onClick={setup.retry}>Check again</Button>}>{setup.error}</Banner>}
      {error && <Banner tone="danger" title="Sign-in could not be opened">{error}</Banner>}
      {WORKSPACES_ENABLED && profilesError && <Banner tone="danger" title="Profiles could not be loaded" action={<Button onClick={() => { void refresh() }}>Retry</Button>}>{profilesError}</Banner>}
      {WORKSPACES_ENABLED && !loaded && <p role="status">Loading business profiles…</p>}
      {WORKSPACES_ENABLED && <Field label="Connect to business profile" hint={reconnecting
          ? 'Reconnecting renews access for the profile that owns this account.'
          : 'A profile can contain several accounts from the same channel.'}>
          <Button onClick={() => setChoosingProfile(true)} disabled={busy || reconnecting || !loaded || !!profilesError} aria-haspopup="dialog" aria-label={`Connect to business profile: ${selected?.name ?? 'Choose a profile'}`}>
            {selected?.name ?? 'Choose a business profile'}
          </Button>
        </Field>}
      {WORKSPACES_ENABLED && loaded && !profilesError && !selected && !reconnecting && <Banner tone="info">Choose a profile where you can connect accounts, or create a new profile.</Banner>}
      {WORKSPACES_ENABLED && loaded && !profilesError && reconnecting && !selected && <Banner tone="warning">This profile is no longer available for reconnecting. Refresh your profiles or ask its owner for access.</Banner>}
      {shopify && <Field
        label="Shopify store domain"
        required
        hint={shopDomainTouched && !shopDomainValid
          ? 'Enter the permanent myshopify.com domain, such as your-store.myshopify.com.'
          : 'Paste the store name, its myshopify.com domain, or an admin.shopify.com/store URL.'}
      >
        <Input
          value={shopDomain}
          onChange={(event) => setShopDomain(event.target.value)}
          onBlur={() => {
            setShopDomainTouched(true)
            if (normalizedShopDomain) setShopDomain(normalizedShopDomain)
          }}
          placeholder="your-store.myshopify.com"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          aria-invalid={shopDomainTouched && !shopDomainValid ? true : undefined}
          disabled={busy}
        />
      </Field>}
      {channel.regions.length > 0 && <Field label="Region"><Listbox options={channel.regions.map(item => ({ value: item.key, label: item.label }))} value={region} onChange={setRegion} disabled={busy} width="100%" /></Field>}
      {shopify && <Banner tone="info" title="Shopify will ask you to approve access">
        Nexus requests broad read/write access to your store, including products, orders, customers, inventory, content, and settings. Restricted permissions are included only after app approval. Your password is entered only on Shopify.
      </Banner>}
      {WORKSPACES_ENABLED && selected && <p className="nds-connect-note">{reconnecting ? 'Access will be renewed' : 'The account you authorize will be connected'} in <strong>{selected.name}</strong>.</p>}
      {WORKSPACES_ENABLED && !reconnecting && <div><Button asChild variant="link" inline><a href="/profiles?create=1">Create a new business profile</a></Button></div>}
    </form>
  </Modal>{choosingProfile && <BusinessProfilePicker title="Connect to business profile" value={selected?.id} permission="connect"
    onClose={() => setChoosingProfile(false)} onSelect={profile => { setChosenProfile(profile); setChoosingProfile(false) }} />}</>
}
