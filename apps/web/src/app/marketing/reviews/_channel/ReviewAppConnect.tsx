'use client'

/**
 * Reviews — "Connect your review app" (build spec B21, PR I): the one window that connects Judge.me, used by Settings ›
 * Sources and the Shopify page. A person pastes the store's myshopify address and a private API token from Judge.me;
 * Nexus stores the token encrypted and never shows it again (not even part of it). Connected, the window says when Nexus
 * last read Judge.me (or what went wrong, in words) and offers "Replace the token" and "Disconnect" (the reviews already
 * read stay). Okendo, Yotpo and Loox are listed as "Coming later" (ruling 3).
 *
 * API: GET /api/reviews/apps · POST /api/reviews/apps/judgeme { shopDomain, apiToken } · DELETE /api/reviews/apps/judgeme.
 */
import { useCallback, useEffect, useState } from 'react'
import { Banner, Field, Modal, useToast } from '@/design-system/components'
import { Button, Input, Pill, Skeleton, Tag } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { reviewsGet, reviewsSend } from '../_lib/reviewsFetch'
import { connectHeld, shortTime, type ReviewAppView } from './shopChannelModel'
import s from './channel.module.css'

interface AppsAnswer { apps: ReviewAppView[]; readOn: boolean }

export interface ReviewAppConnectProps {
  open: boolean
  onClose: () => void
  canManage: boolean
  /** After a connect or a disconnect (the page reads its state again). */
  onChanged?: () => void
}

export function ReviewAppConnect({ open, onClose, canManage, onChanged }: ReviewAppConnectProps) {
  const { toast } = useToast()
  const [apps, setApps] = useState<AppsAnswer | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const [shopDomain, setShopDomain] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setReadError(null)
    const res = await reviewsGet<AppsAnswer>('/reviews/apps')
    if (res.data) setApps(res.data)
    else setReadError(res.error)
  }, [])

  useEffect(() => {
    if (!open) return
    setReplacing(false)
    setConfirmOff(false)
    setApiToken('')
    setError(null)
    void load()
  }, [open, load])

  const app = apps?.apps.find((a) => a.app === 'JUDGEME') ?? null
  const connected = !!app && (app.state === 'connected' || app.state === 'waiting' || app.state === 'needs_fix')
  useEffect(() => { if (app?.shopDomain) setShopDomain((v) => v || app.shopDomain || '') }, [app?.shopDomain])
  const showForm = !!apps && (!connected || replacing)
  const held = connectHeld({ canManage, shopDomain, apiToken, busy })

  const connect = async () => {
    setBusy(true)
    setError(null)
    // No Idempotency-Key: a receipt would keep a hash of the body (the token). Connecting twice stores the same row again.
    const res = await reviewsSend<{ app: ReviewAppView }>('POST', '/reviews/apps/judgeme', { shopDomain, apiToken })
    setBusy(false)
    // The token leaves the page's memory whatever the answer: it is never shown again.
    setApiToken('')
    if (!res.data) {
      setError(res.error)
      return
    }
    emitInvalidation({ type: 'review.settings.changed', meta: { app: 'JUDGEME' } })
    toast('Judge.me connected. The token is stored encrypted; the first read brings the reviews in.', 'success')
    setReplacing(false)
    await load()
    onChanged?.()
  }

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    // Disconnecting twice changes nothing more (the token is already gone).
    const res = await reviewsSend<{ app: ReviewAppView }>('DELETE', '/reviews/apps/judgeme')
    setBusy(false)
    setConfirmOff(false)
    if (!res.data) {
      setError(res.error)
      return
    }
    emitInvalidation({ type: 'review.settings.changed', meta: { app: 'JUDGEME' } })
    toast('Judge.me disconnected. Its token was deleted; the reviews already read stay.', 'success')
    await load()
    onChanged?.()
  }

  const footer = (
    <div className={s.dialogFoot}>
      {connected && !showForm && !confirmOff && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setConfirmOff(true)} heldReason={canManage ? null : 'You need ‘Manage reviews’ to disconnect a review app.'}>Disconnect…</Button>
          <Button size="sm" onClick={() => setReplacing(true)} heldReason={canManage ? null : 'You need ‘Manage reviews’ to change the token.'}>Replace the token…</Button>
          <Button size="sm" variant="primary" onClick={onClose}>Done</Button>
        </>
      )}
      {confirmOff && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setConfirmOff(false)}>Keep it connected</Button>
          <Button size="sm" variant="danger" onClick={() => void disconnect()} heldReason={busy ? 'Disconnecting…' : null}>Disconnect Judge.me</Button>
        </>
      )}
      {showForm && (
        <>
          <Button size="sm" variant="ghost" onClick={replacing ? () => setReplacing(false) : onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => void connect()} heldReason={held}>{replacing ? 'Save the new token' : 'Connect Judge.me'}</Button>
        </>
      )}
      {!apps && <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} size="md" title="Connect your review app" subtitle="Shopify keeps no reviews itself: they live in the store’s review app." footer={footer}>
      <div className={s.stackGap}>
        {readError && !apps ? (
          <Banner tone="danger" title={readError} action={<Button size="sm" onClick={() => void load()}>Try again</Button>} />
        ) : !apps ? (
          <Skeleton height={160} />
        ) : (
          <>
            <ul className={s.sampleList} aria-label="Review apps">
              {apps.apps.map((a) => (
                <li key={a.app} className={s.sampleRow}>
                  <span className={s.stack}>
                    <span className={s.main}>{a.name}</span>
                    <span className={s.sub}>{a.what}</span>
                  </span>
                  {a.connectable
                    ? <Pill tone={a.tone} dot>{a.stateWords}</Pill>
                    : <Tag tone="neutral">Coming later</Tag>}
                </li>
              ))}
            </ul>
            {app && connected && !showForm && (
              <Banner tone={app.tone === 'danger' ? 'danger' : app.tone === 'warning' ? 'warning' : 'info'} title={`${app.stateWords}${app.shopDomain ? ` · ${app.shopDomain}` : ''}`}>
                {app.words}{app.lastReadAt ? ` Last read ${shortTime(app.lastReadAt)}.` : ''}
              </Banner>
            )}
            {confirmOff && (
              <Banner tone="warning" title="Disconnect Judge.me?">
                Nexus stops reading Judge.me and deletes the token. Until you connect again, a reply to a Judge.me review is copied and posted in Judge.me, then marked as responded. The reviews already read stay.
              </Banner>
            )}
            {showForm && (
              <>
                <Field label="Store address" required hint="The store’s Shopify address, like name.myshopify.com.">
                  <Input value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} placeholder="name.myshopify.com" autoComplete="off" spellCheck={false} aria-label="Store address" />
                </Field>
                <Field label="Judge.me private API token" required hint="From your Judge.me admin. Nexus stores it encrypted and never shows it again — not even here.">
                  <Input type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Judge.me private API token" />
                </Field>
                <p className={s.note}>
                  Nexus reads new reviews every 30 minutes, with their photos (a video is marked; watch it in Judge.me). A reply you send from the
                  Inbox is posted under the review by Judge.me, which also e-mails it to the reviewer. Nexus never sees your Shopify password.
                </p>
              </>
            )}
            {error && <Banner tone="danger" title={error} />}
          </>
        )}
      </div>
    </Modal>
  )
}
