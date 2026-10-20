'use client'

/**
 * Meta ads step 1 — the two Meta cards on /settings/channels/meta: the token as Nexus last checked it (valid, expiry
 * and renewal, type, the permissions it lacks and what each is for; "Check token now" asks Meta again), and the assets
 * this business reads (the ad account, and the Page and Instagram account chosen for a later step) with the read state
 * in words. "Choose assets", "Connect Meta" and "Replace credentials" open the same dialogs as the Connect tab (Meta
 * has no sign-in popup, so the page shows no Reconnect).
 *
 * Read from GET /api/meta-ads/connections; nothing here writes to Meta. The token itself is never shown.
 */
import { useCallback, useEffect, useState } from 'react'
import { AsOf, Banner, Card, KeyValue, type KeyValueItem } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { checkMetaToken, fetchMetaConnections, type MetaConnection } from '@/lib/meta-ads/contract'
import { formatDay, formatMoment } from '@/app/marketing/ads/meta/metaAds'
import { MetaAccountsDialog } from '../MetaAccountsDialog'
import { MetaCredentialsDialog } from '../MetaCredentialsDialog'
import { metaConnectedNotice, metaSavedNotice, missingPermissionLines, needsMetaChoice, tokenCheckNote, tokenLines } from '../meta-selection'

const STATE_PILL: Record<MetaConnection['state'], { tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  ok: { tone: 'success', label: 'Read daily' },
  first_read_pending: { tone: 'info', label: 'First read pending' },
  choose_account: { tone: 'warning', label: 'Ad account not chosen' },
  read_failed: { tone: 'danger', label: 'Last read failed' },
  permission_missing: { tone: 'warning', label: 'Permission missing' },
  token_problem: { tone: 'danger', label: 'Token problem' },
  sign_in_needed: { tone: 'danger', label: 'New token needed' },
}

type Note = { tone: 'success' | 'warning' | 'danger'; title: string; text?: string }

export function MetaConnectionCards({ connectionId, reloadSignal, onChanged }: {
  /** The page's Meta connection; null when none is connected. */
  connectionId: string | null
  /** Bumps when the page refetched, so the cards read again. */
  reloadSignal?: unknown
  /** New credentials were saved: the page reads its connection again. */
  onChanged: () => void
}) {
  const [connection, setConnection] = useState<MetaConnection | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The asset picker, for the shown connection or the one just connected.
  const [choosing, setChoosing] = useState<string | null>(null)
  const [entering, setEntering] = useState(false)
  const [checking, setChecking] = useState(false)
  const [tokenNote, setTokenNote] = useState<Note | null>(null)
  const [assetNote, setAssetNote] = useState<{ title: string; text: string } | null>(null)
  const [credentialsNote, setCredentialsNote] = useState<{ title: string; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const { items } = await fetchMetaConnections()
      setConnection(connectionId ? items.find((item) => item.connectionId === connectionId) ?? null : null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The Meta connection could not be loaded.')
    } finally {
      setLoaded(true)
    }
  }, [connectionId])

  useEffect(() => { void load() }, [load, reloadSignal])

  const checkNow = async () => {
    if (checking || !connectionId) return
    setChecking(true)
    setTokenNote(null)
    try {
      setTokenNote(tokenCheckNote(await checkMetaToken(connectionId)))
      await load()
    } catch (err) {
      setTokenNote({ tone: 'danger', title: 'The token was not checked', text: err instanceof Error ? err.message : 'Nexus could not reach the server. Try again.' })
    } finally {
      setChecking(false)
    }
  }

  const credentialsDialog = entering && (
    <MetaCredentialsDialog
      connectionId={connection?.connectionId ?? null}
      appId={connection?.appId}
      onClose={() => setEntering(false)}
      onSaved={(answer) => {
        setEntering(false)
        setCredentialsNote(metaConnectedNotice(answer))
        if (answer.placement !== 'reconsent' && answer.adAccountsSeen > 0) { setAssetNote(null); setChoosing(answer.connectionId) }
        onChanged()
      }}
    />
  )
  const assetsDialog = choosing && (
    <MetaAccountsDialog
      connectionId={choosing}
      current={connection?.connectionId === choosing ? connection : null}
      onClose={() => setChoosing(null)}
      onSaved={(saved) => { setChoosing(null); setConnection(saved); setAssetNote(metaSavedNotice(saved)); onChanged() }}
    />
  )
  const credentialsBanner = credentialsNote && <Banner tone="success" title={credentialsNote.title} onDismiss={() => setCredentialsNote(null)}>{credentialsNote.text}</Banner>

  if (!loaded) return <Skeleton height={160} radius="var(--nds-radius-lg)" />

  if (!connection) {
    return (
      <Card header="Meta" headerAction={<Button size="sm" variant="primary" onClick={() => setEntering(true)}>Connect Meta</Button>}>
        <div style={{ display: 'grid', gap: 'var(--nds-space-14)' }}>
          {credentialsBanner}
          {error
            ? <Banner tone="danger" title="The Meta connection could not be loaded" action={<Button onClick={() => { void load() }}>Try again</Button>}>{error}</Banner>
            : <p style={{ margin: 0 }}>Meta is not connected to this business. Connect it with your business's own Meta app and a system-user token.</p>}
        </div>
        {credentialsDialog}
        {assetsDialog}
      </Card>
    )
  }

  const pill = STATE_PILL[connection.state]
  const missing = missingPermissionLines(connection.token)
  const tokenItems: KeyValueItem[] = [
    ...tokenLines(connection.token).map((line): KeyValueItem => ({
      label: line.label,
      value: line.tone ? <Pill tone={line.tone} dot>{line.value}</Pill> : line.value,
    })),
    { label: 'System user', value: connection.systemUser ? connection.systemUser.name?.trim() || 'Unnamed system user' : 'Not read yet' },
    { label: 'App ID', value: connection.appId ?? 'Not saved' },
  ]
  const assetItems: KeyValueItem[] = [
    {
      label: 'Ad account',
      value: connection.adAccount ? connection.adAccount.name?.trim() || 'Unnamed ad account' : 'Not chosen',
      hint: connection.adAccount
        ? [connection.adAccount.statusText, connection.adAccount.currency, connection.adAccount.timeZone].filter(Boolean).join(' · ') || undefined
        : 'Nexus reads nothing until one is chosen.',
    },
    {
      label: 'Facebook Page',
      value: connection.page ? connection.page.name?.trim() || 'Unnamed Facebook Page' : 'None',
      hint: connection.page ? 'Chosen, not read yet: used in a later step.' : undefined,
    },
    {
      label: 'Instagram account',
      value: connection.instagram ? (connection.instagram.username ? `@${connection.instagram.username}` : 'Instagram account') : 'None',
      hint: connection.instagram ? 'Chosen, not read yet: used in a later step.' : undefined,
    },
    { label: 'Read state', value: <Pill tone={pill.tone} dot>{pill.label}</Pill>, hint: connection.stateText },
    { label: 'Last read', value: <AsOf at={connection.read.lastReadAt} kind="event" /> },
    { label: 'Newest day read', value: connection.read.lastDataDay ? formatDay(connection.read.lastDataDay) : 'None yet' },
    { label: 'Next read', value: connection.read.nextReadAt ? <time dateTime={connection.read.nextReadAt}>{formatMoment(connection.read.nextReadAt) ?? connection.read.nextReadAt}</time> : 'Not planned' },
  ]
  const canChoose = connection.state !== 'sign_in_needed' && connection.state !== 'token_problem'

  return (
    <div className="nds-cd-pair">
      <Card
        header="Meta token"
        description="The system-user token as Nexus last checked it with Meta. The token itself is never shown."
        headerAction={<>
          <Button size="sm" onClick={() => { void checkNow() }} aria-busy={checking || undefined} heldReason={checking ? 'Nexus is asking Meta about the token.' : null}>
            {checking ? 'Checking…' : 'Check token now'}
          </Button>
          <Button size="sm" variant={connection.state === 'sign_in_needed' || connection.state === 'token_problem' ? 'primary' : 'secondary'} onClick={() => setEntering(true)}>
            Replace credentials
          </Button>
        </>}
      >
        <div style={{ display: 'grid', gap: 'var(--nds-space-14)' }}>
          {credentialsBanner}
          {tokenNote && <Banner tone={tokenNote.tone} title={tokenNote.title} onDismiss={() => setTokenNote(null)}>{tokenNote.text}</Banner>}
          {error && <Banner tone="danger" title="The Meta connection could not be refreshed" action={<Button onClick={() => { void load() }}>Try again</Button>}>{error}</Banner>}
          <KeyValue items={tokenItems} columns={2} />
          {missing.length > 0 && (
            <div>
              <strong>Permissions the token lacks</strong>
              <ul className="nds-connect-about">
                {missing.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}
        </div>
      </Card>
      <Card
        header="Meta assets"
        description="What this business reads from Meta. Nexus reads the ad account once a day and changes nothing in Meta."
        headerAction={<Button size="sm" variant={needsMetaChoice(connection) ? 'primary' : 'secondary'}
          heldReason={canChoose ? null : 'Replace the credentials first: Meta needs a working system-user token to list the assets.'}
          onClick={() => { setAssetNote(null); setChoosing(connection.connectionId) }}>
          {needsMetaChoice(connection) ? 'Choose assets' : 'Change assets'}
        </Button>}
      >
        <div style={{ display: 'grid', gap: 'var(--nds-space-14)' }}>
          {assetNote && <Banner tone="success" title={assetNote.title} onDismiss={() => setAssetNote(null)}>{assetNote.text}</Banner>}
          {connection.read.lastError && connection.state === 'read_failed' && (
            <Banner tone="danger" title="Last read failed">{connection.read.lastError}</Banner>
          )}
          <KeyValue items={assetItems} columns={2} />
        </div>
      </Card>
      {credentialsDialog}
      {assetsDialog}
    </div>
  )
}
