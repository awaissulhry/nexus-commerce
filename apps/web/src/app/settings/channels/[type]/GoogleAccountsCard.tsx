'use client'

/**
 * Google Ads step 1a, W1 — the "Google accounts" card on /settings/channels/google: which Google Ads account this
 * business reads (and through which manager), the Merchant Center account and Google Analytics property chosen for a
 * later step, and the read state in words. "Change accounts" opens the same dialog as the Connect tab.
 *
 * Read from C1 (`/api/google-ads/connections`); nothing here writes to Google.
 */
import { useCallback, useEffect, useState } from 'react'
import { AsOf, Banner, Card, KeyValue, type KeyValueItem } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { fetchGoogleConnections, type GoogleAccount } from '@/lib/google-ads/contract'
import { formatDay, formatMoment } from '@/app/marketing/ads/google/googleAds'
import { GoogleAccountsDialog } from '../GoogleAccountsDialog'
import { adsAccountHint, needsChoice, readStateText, savedNotice } from '../google-selection'

const STATE_PILL: Record<GoogleAccount['state'], { tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  ok: { tone: 'success', label: 'Read daily' },
  first_read_pending: { tone: 'info', label: 'First read pending' },
  choose_account: { tone: 'warning', label: 'Account not chosen' },
  read_failed: { tone: 'danger', label: 'Last read failed' },
  permission_missing: { tone: 'warning', label: 'Permission missing' },
  sign_in_needed: { tone: 'danger', label: 'Sign-in needed' },
}

const named = (value: { name: string | null } | null, none: string, unnamed: string) => (value ? value.name?.trim() || unnamed : none)

export function GoogleAccountsCard({ connectionId, reloadSignal, onReconnect }: {
  connectionId: string
  /** Bumps when the page refetched (after a reconnect), so the card reads again. */
  reloadSignal?: unknown
  onReconnect?: () => void
}) {
  const [account, setAccount] = useState<GoogleAccount | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [note, setNote] = useState<{ title: string; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const { items } = await fetchGoogleConnections()
      setAccount(items.find((item) => item.connectionId === connectionId) ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The Google accounts could not be loaded.')
    } finally {
      setLoaded(true)
    }
  }, [connectionId])

  useEffect(() => { void load() }, [load, reloadSignal])

  if (!loaded) return <Skeleton height={160} radius="var(--nds-radius-lg)" />

  const pill = account ? STATE_PILL[account.state] : null
  const items: KeyValueItem[] = account
    ? [
        {
          label: 'Google Ads account',
          value: account.ads
            ? `${account.ads.name?.trim() || 'Unnamed Google Ads account'}${account.ads.isTest ? ' (test account)' : ''}`
            : 'Not chosen',
          hint: account.ads ? adsAccountHint(account.ads) : 'Nexus reads nothing until one is chosen.',
        },
        { label: 'Manager account', value: account.ads ? named(account.manager, 'None — direct access', 'Unnamed manager account') : '—' },
        {
          label: 'Merchant Center',
          value: named(account.merchantCenter, 'None', 'Unnamed Merchant Center account'),
          hint: account.merchantCenter ? 'Chosen, not read yet: used in a later step.' : undefined,
        },
        {
          label: 'Google Analytics',
          value: named(account.analytics, 'None', 'Unnamed property'),
          hint: account.analytics ? 'Chosen, not read yet: used in a later step.' : undefined,
        },
        { label: 'Read state', value: pill ? <Pill tone={pill.tone} dot>{pill.label}</Pill> : '—', hint: readStateText(account) },
        { label: 'Last read', value: <AsOf at={account.read.lastReadAt} kind="event" /> },
        // The Ads page's own words for a day ("10 Oct 2026") and a moment in the viewer's time ("13 Oct 2026, 08:25").
        { label: 'Newest day read', value: account.read.lastDataDay ? formatDay(account.read.lastDataDay) : 'None yet' },
        { label: 'Next read', value: account.read.nextReadAt ? <time dateTime={account.read.nextReadAt}>{formatMoment(account.read.nextReadAt) ?? account.read.nextReadAt}</time> : 'Not planned' },
      ]
    : []

  return (
    <Card
      header="Google accounts"
      description="What this business reads from Google. Nexus reads the Google Ads account once a day and changes nothing in Google."
      headerAction={account ? (
        <Button size="sm" variant={needsChoice(account) ? 'primary' : 'secondary'} onClick={() => { setNote(null); setChoosing(true) }}>
          {needsChoice(account) ? 'Choose accounts' : 'Change accounts'}
        </Button>
      ) : undefined}
    >
      <div style={{ display: 'grid', gap: 'var(--nds-space-14)' }}>
        {error && (
          <Banner tone="danger" title="The Google accounts could not be loaded" action={<Button onClick={() => { void load() }}>Try again</Button>}>
            {error}
          </Banner>
        )}
        {note && <Banner tone="success" title={note.title} onDismiss={() => setNote(null)}>{note.text}</Banner>}
        {account?.read.lastError && account.state === 'read_failed' && (
          <Banner tone="danger" title="Last read failed">{account.read.lastError}</Banner>
        )}
        {!error && !account && (
          <p style={{ margin: 0 }}>No Google sign-in is connected to this business. Connect Google on the Connect tab.</p>
        )}
        {account && <KeyValue items={items} columns={2} />}
      </div>
      {choosing && account && (
        <GoogleAccountsDialog
          connectionId={account.connectionId}
          current={account}
          onClose={() => setChoosing(false)}
          onSaved={(saved) => { setChoosing(false); setAccount(saved); setNote(savedNotice(saved)); void load() }}
          onReconnect={onReconnect ? () => { setChoosing(false); onReconnect() } : undefined}
        />
      )}
    </Card>
  )
}
