'use client'

/**
 * CX.2 — Connect tab. One card per catalogue entry (`/api/cx/channels`), so a
 * channel appears here because the API knows it, never because a constant in
 * this file says so. Unavailable channels are HELD, not disabled: the button
 * stays reachable and says why (check-silent-disabled).
 */

import { useState } from 'react'
import Link from 'next/link'
import { Card, Banner, Listbox } from '@/design-system/components'
import { Button, Tag, Pill, Skeleton } from '@/design-system/primitives'
import { relativeTime, type AccountRow, type AdsConnection, type CatalogueChannel } from './channels-data'
import { getBackendUrl } from '@/lib/backend-url'

const ORDER = ['AMAZON_SP', 'AMAZON_ADS', 'EBAY', 'SHOPIFY', 'ETSY']

/** Why a channel cannot be connected yet — stated on the card, not hidden in a title. */
const HELD_REASON: Record<string, string> = {
  AMAZON_SP:
    'Amazon sign-in arrives with CX.3 — the public-app registration in Seller Central is the Owner’s step. The environment-managed Amazon account is connected under Accounts.',
  SHOPIFY: 'Arrives with CX.4 — needs the custom-distribution Shopify app to exist first.',
  ETSY: 'Arrives with CX.5 — needs the Etsy Seller App registration first.',
}

function lifetimeLine(c: CatalogueChannel): string | null {
  if (c.rotatesRefreshToken) return 'Sign-in renews itself on every refresh.'
  if (c.refreshTokenLifetimeSec) {
    const months = Math.round(c.refreshTokenLifetimeSec / (30 * 86_400))
    return `Sign-in lasts about ${months} months, then you reconnect.`
  }
  return null
}

export interface ConnectTabProps {
  catalogue: CatalogueChannel[] | null
  catalogueError: string | null
  accounts: AccountRow[]
  ads: { items: AdsConnection[]; adsMode: string } | null
  connecting: string | null
  onStart: (channelKey: string, opts: { intent: 'connect'; region?: string | null; url?: string }) => void
}

export function ConnectTab({ catalogue, catalogueError, accounts, ads, connecting, onStart }: ConnectTabProps) {
  const [region, setRegion] = useState<Record<string, string>>({})
  const [reasonShown, setReasonShown] = useState<string | null>(null)

  if (catalogueError) {
    return (
      <Banner tone="danger" title="The connector catalogue could not be loaded">
        {catalogueError}. The Connect buttons need it — reload the page or check the API.
      </Banner>
    )
  }
  if (!catalogue) {
    return (
      <div style={{ display: 'grid', gap: 'var(--nds-space-12)', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={168} />
        ))}
      </div>
    )
  }

  // AMAZON_ADS has its own card below (it carries the profiles and the live LWA
  // sign-in), so the catalogue entry must not ALSO render: on prod it produced two
  // Amazon Ads cards that disagreed — "Not yet" beside "9 active".
  const adsSpec = catalogue.find((c) => c.key === 'AMAZON_ADS') ?? null
  const sorted = catalogue
    .filter((c) => c.key !== 'AMAZON_ADS')
    .sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key))
  const connectedFor = (channelType: string) => accounts.filter((a) => a.channel === channelType)

  return (
    <div style={{ display: 'grid', gap: 'var(--nds-space-12)' }}>
      <div style={{ display: 'grid', gap: 'var(--nds-space-12)', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {sorted.map((c) => {
          const have = connectedFor(c.channelType)
          const chosenRegion = region[c.key] ?? c.defaultRegion ?? c.regions[0]?.key ?? null
          const held = !c.available
          const busy = connecting === c.key
          return (
            <Card
              key={c.key}
              header={c.displayName}
              description={
                have.length > 0
                  ? `${have.length} account${have.length === 1 ? '' : 's'} connected — ${have.map((a) => a.label).join(', ')}`
                  : 'No account connected yet.'
              }
              headerAction={
                have.length > 0 ? (
                  <Pill tone="success" dot size="sm">
                    {have.length} connected
                  </Pill>
                ) : held ? (
                  <Pill tone="neutral" size="sm">
                    Not yet
                  </Pill>
                ) : (
                  <Pill tone="info" size="sm">
                    Ready
                  </Pill>
                )
              }
            >
              <dl className="nds-connect-facts">
                <div>
                  <dt>Signs in with</dt>
                  <dd>{c.authMode.replace(/_/g, ' ')}</dd>
                </div>
                <div>
                  <dt>Permissions</dt>
                  <dd>
                    {c.requiredScopes.length > 0 ? (
                      <>
                        {c.requiredScopes.length} requested
                        {c.reviewGatedScopes.length > 0 ? ` · ${c.reviewGatedScopes.length} need channel review` : ''}
                      </>
                    ) : (
                      // SP-API grants roles at app registration, not OAuth scopes:
                      // "0 requested" read as a defect rather than as "not scope-based".
                      'Set by the app’s roles at the channel, not by scopes'
                    )}
                  </dd>
                </div>
                {lifetimeLine(c) && (
                  <div>
                    <dt>Renewal</dt>
                    <dd>{lifetimeLine(c)}</dd>
                  </div>
                )}
                {c.apiVersion && (
                  <div>
                    <dt>API version</dt>
                    <dd>{c.apiVersion}</dd>
                  </div>
                )}
              </dl>

              {c.regions.length > 1 && (
                <div className="nds-connect-region">
                  <span id={`region-${c.key}`}>Region</span>
                  <Listbox
                    size="sm"
                    ariaLabel={`${c.displayName} region`}
                    options={c.regions.map((r) => ({ value: r.key, label: r.label }))}
                    value={chosenRegion ?? undefined}
                    onChange={(v) => setRegion((s) => ({ ...s, [c.key]: v }))}
                    width={220}
                  />
                </div>
              )}

              <div className="nds-connect-actions">
                <Button
                  variant="primary"
                  size="sm"
                  aria-disabled={held || busy || undefined}
                  aria-describedby={held && reasonShown === c.key ? `held-${c.key}` : undefined}
                  onClick={() => {
                    if (busy) return
                    if (held) {
                      setReasonShown((s) => (s === c.key ? null : c.key))
                      return
                    }
                    onStart(c.key, { intent: 'connect', region: chosenRegion })
                  }}
                >
                  {busy
                    ? 'Opening sign-in…'
                    : // "Connect another…" on a HELD button promises a second account the
                      // channel cannot give yet (Amazon: the env row is connected, OAuth is CX.3).
                      have.length > 0 && !held
                      ? `Connect another ${c.displayName} account`
                      : `Connect ${c.displayName}`}
                </Button>
                {have.length > 0 && (
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/settings/channels/${c.channelType.toLowerCase()}`}>Details</Link>
                  </Button>
                )}
              </div>
              {held && reasonShown === c.key && (
                <p id={`held-${c.key}`} className="nds-connect-reason" role="status">
                  {HELD_REASON[c.key] ?? 'This channel cannot be connected yet.'}
                </p>
              )}
            </Card>
          )
        })}

        {/* Amazon Ads — a separate connection universe until CX.3 merges it. Read from
            its own table, connected through its own (already live) LWA route. */}
        <Card
          header="Amazon Ads"
          description={
            ads
              ? ads.items.length > 0
                ? `${ads.items.length} advertising profile${ads.items.length === 1 ? '' : 's'} · server mode ${ads.adsMode}`
                : 'No advertising profile connected yet.'
              : 'Loading advertising profiles…'
          }
          headerAction={
            ads && ads.items.some((i) => i.isActive) ? (
              <Pill tone="success" dot size="sm">
                {ads.items.filter((i) => i.isActive).length} active
              </Pill>
            ) : (
              <Pill tone="neutral" size="sm">
                Not connected
              </Pill>
            )
          }
        >
          {adsSpec && (
            <dl className="nds-connect-facts">
              <div>
                <dt>Signs in with</dt>
                <dd>{adsSpec.authMode.replace(/_/g, ' ')}</dd>
              </div>
              <div>
                <dt>Permissions</dt>
                <dd>
                  {adsSpec.requiredScopes.length} requested
                  {adsSpec.reviewGatedScopes.length > 0 ? ` · ${adsSpec.reviewGatedScopes.length} need channel review` : ''}
                </dd>
              </div>
              {lifetimeLine(adsSpec) && (
                <div>
                  <dt>Renewal</dt>
                  <dd>{lifetimeLine(adsSpec)}</dd>
                </div>
              )}
              {adsSpec.apiVersion && (
                <div>
                  <dt>API version</dt>
                  <dd>{adsSpec.apiVersion}</dd>
                </div>
              )}
            </dl>
          )}
          {ads && ads.items.length > 0 && (
            <div className="nds-connect-chips">
              {ads.items.map((i) => (
                <Tag key={i.id} tone={i.tokenExpiryStatus === 'expired' ? 'danger' : i.mode === 'live' ? 'success' : 'neutral'}>
                  {i.accountLabel ?? 'Profile'} · {i.marketplace} · {i.mode}
                  {i.tokenExpiresAt ? ` · token ${relativeTime(i.tokenExpiresAt)}` : ''}
                </Tag>
              ))}
            </div>
          )}
          <p className="nds-connect-note">
            Ads profiles keep their own health for now (mode, writes, allowlists live on{' '}
            <Link href="/settings/advertising">Advertising</Link>). CX.3 folds them into Accounts.
          </p>
          <div className="nds-connect-actions">
            <Button
              variant="primary"
              size="sm"
              aria-disabled={connecting === 'AMAZON_ADS' || undefined}
              onClick={() => {
                if (connecting === 'AMAZON_ADS') return
                onStart('AMAZON_ADS', { intent: 'connect', url: `${getBackendUrl()}/api/amazon-ads/auth/connect` })
              }}
            >
              {connecting === 'AMAZON_ADS' ? 'Opening sign-in…' : 'Connect with Amazon Ads'}
            </Button>
          </div>
        </Card>
      </div>

      <Card header="About channel connections">
        <ul className="nds-connect-about">
          <li>Connect opens the channel’s own sign-in in a popup; you sign in there and choose to allow. Nexus never sees your password.</li>
          <li>The permissions the channel actually granted are recorded at consent. When a channel adds permissions Nexus needs, the account shows how many are missing and Reconnect asks for them.</li>
          <li>Every connected account is checked with a real call every 15 minutes (heartbeat). Access tokens are refreshed before they expire; you are told 30, 7 and 1 days before a sign-in itself runs out.</li>
          <li>Disconnect revokes access at the channel, removes the stored credentials, and keeps the account’s history in the ledger.</li>
        </ul>
      </Card>
    </div>
  )
}
