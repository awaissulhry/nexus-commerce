'use client'

/**
 * Reviews — "Connect your review app" (build spec B21, PR I; Okendo, Yotpo and Loox 2026-10-28): the one window that
 * connects the store's review apps, used by Settings › Sources and the Shopify page. It opens on the list of apps —
 * Judge.me, Okendo, Yotpo, Loox — each with what it gives, its state and "Connect …" / "Manage …"; an app's own view asks
 * exactly what that app needs (the fields come from the API: Judge.me the store address and a private API token, Okendo
 * the User ID and API key, Yotpo the store ID and API secret, Loox the public store ID and an API key), says which plan
 * its API needs and what to do on another plan (export a CSV in the app, import it here). Nexus stores the secret
 * encrypted and never shows it again (not even part of it). Connected, the view says when Nexus last read the app (or what
 * went wrong, in words) and offers "Replace the key" and "Disconnect" (the reviews already read stay).
 *
 * API: GET /api/reviews/apps · POST /api/reviews/apps/:app { the app's fields } · DELETE /api/reviews/apps/:app.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Upload } from 'lucide-react'
import { Banner, Field, Modal, useToast } from '@/design-system/components'
import { Button, Input, Pill, Skeleton } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { reviewsGet, reviewsSend } from '../_lib/reviewsFetch'
import { inboxHref } from '../_lib/reviewsLinks'
import { appActionLabel, connectHeld, initialValues, isAppConnected, shortTime, type ReviewAppKey, type ReviewAppView } from './shopChannelModel'
import s from './channel.module.css'

interface AppsAnswer { apps: ReviewAppView[]; readOn: boolean }

export interface ReviewAppConnectProps {
  open: boolean
  onClose: () => void
  canManage: boolean
  /** Open straight on this app's view (the Shopify page's "Manage Okendo…"); else the list. */
  initialApp?: ReviewAppKey | null
  /** After a connect or a disconnect (the page reads its state again). */
  onChanged?: () => void
}

const MANAGE_APPS = 'You need ‘Manage reviews’ to connect a review app.'

/** Loox opens inside the Shopify admin; the others on their own site. */
const openWords = (app: Pick<ReviewAppView, 'app' | 'name'>) => (app.app === 'LOOX' ? 'Open Loox in the Shopify admin' : `Open ${app.name}`)

export function ReviewAppConnect({ open, onClose, canManage, initialApp = null, onChanged }: ReviewAppConnectProps) {
  const { toast } = useToast()
  const [apps, setApps] = useState<AppsAnswer | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReviewAppKey | null>(initialApp)
  const [replacing, setReplacing] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
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
    setSelected(initialApp)
    setReplacing(false)
    setConfirmOff(false)
    setValues({})
    setError(null)
    void load()
  }, [open, initialApp, load])

  const app = useMemo(() => apps?.apps.find((a) => a.app === selected) ?? null, [apps, selected])
  const known = !!app && (isAppConnected(app) || app.state === 'needs_fix')
  const showForm = !!app && (!known || replacing)
  // The store id is filled back in when the app's view opens; a secret never is.
  useEffect(() => { if (app) setValues(initialValues(app)) }, [app])
  const held = app ? connectHeld({ canManage, app, values, busy }) : null
  const secretWords = app?.fields.find((f) => f.secret)?.label ?? 'key'

  const pick = (key: ReviewAppKey | null) => {
    setSelected(key)
    setReplacing(false)
    setConfirmOff(false)
    setError(null)
  }

  const connect = async () => {
    if (!app) return
    setBusy(true)
    setError(null)
    // No Idempotency-Key: a receipt would keep a hash of the body (the secret). Connecting twice stores the same row again.
    const body = Object.fromEntries(app.fields.map((f) => [f.key, (values[f.key] ?? '').trim()]))
    const res = await reviewsSend<{ app: ReviewAppView }>('POST', `/reviews/apps/${app.app.toLowerCase()}`, body)
    setBusy(false)
    // The secret leaves the page's memory whatever the answer: it is never shown again.
    setValues((v) => Object.fromEntries(Object.entries(v).map(([k, val]) => [k, app.fields.find((f) => f.key === k)?.secret ? '' : val])))
    if (!res.data) {
      setError(res.error)
      return
    }
    emitInvalidation({ type: 'review.settings.changed', meta: { app: app.app } })
    toast(`${app.name} connected. The ${secretWords} is stored encrypted; the first read brings the reviews in.`, 'success')
    setReplacing(false)
    await load()
    onChanged?.()
  }

  const disconnect = async () => {
    if (!app) return
    setBusy(true)
    setError(null)
    // Disconnecting twice changes nothing more (the secret is already gone).
    const res = await reviewsSend<{ app: ReviewAppView }>('DELETE', `/reviews/apps/${app.app.toLowerCase()}`)
    setBusy(false)
    setConfirmOff(false)
    if (!res.data) {
      setError(res.error)
      return
    }
    emitInvalidation({ type: 'review.settings.changed', meta: { app: app.app } })
    toast(`${app.name} disconnected. Its ${secretWords} was deleted; the reviews already read stay.`, 'success')
    await load()
    onChanged?.()
  }

  const back = <Button size="sm" variant="ghost" className={s.dialogFootStart} onClick={() => pick(null)}>All review apps</Button>
  const footer = (
    <div className={s.dialogFoot}>
      {!app && <Button size="sm" variant="primary" onClick={onClose}>Done</Button>}
      {app && known && !showForm && !confirmOff && (
        <>
          {back}
          <Button size="sm" variant="ghost" onClick={() => setConfirmOff(true)} heldReason={canManage ? null : 'You need ‘Manage reviews’ to disconnect a review app.'}>Disconnect…</Button>
          <Button size="sm" onClick={() => setReplacing(true)} heldReason={canManage ? null : 'You need ‘Manage reviews’ to change the key.'}>Replace the key…</Button>
          <Button size="sm" variant="primary" onClick={onClose}>Done</Button>
        </>
      )}
      {app && confirmOff && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setConfirmOff(false)}>Keep it connected</Button>
          <Button size="sm" variant="danger" onClick={() => void disconnect()} heldReason={busy ? 'Disconnecting…' : null}>Disconnect {app.name}</Button>
        </>
      )}
      {app && showForm && (
        <>
          {!replacing && back}
          {replacing && <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>Cancel</Button>}
          <Button size="sm" variant="primary" onClick={() => void connect()} heldReason={held}>{replacing ? 'Save the new key' : `Connect ${app.name}`}</Button>
        </>
      )}
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={app ? `Connect your review app · ${app.name}` : 'Connect your review app'}
      subtitle="Shopify keeps no reviews itself: they live in the store’s review app."
      footer={footer}
    >
      <div className={s.stackGap}>
        {readError && !apps ? (
          <Banner tone="danger" title={readError} action={<Button size="sm" onClick={() => void load()}>Try again</Button>} />
        ) : !apps ? (
          <Skeleton height={160} />
        ) : !app ? (
          <>
            <ul className={s.appList} aria-label="Review apps">
              {apps.apps.map((a) => (
                <li key={a.app} className={s.appRow}>
                  <span className={s.stack}>
                    <span className={s.main}>{a.name}</span>
                    <span className={s.sub}>{a.what}</span>
                  </span>
                  <Pill tone={a.tone} dot>{a.stateWords}</Pill>
                  <Button size="sm" variant={a.state === 'needs_fix' ? 'primary' : 'secondary'} onClick={() => pick(a.app)}>{appActionLabel(a)}</Button>
                </li>
              ))}
            </ul>
            <p className={s.note}>
              Pick the app the store uses. Nexus reads its reviews every 30 minutes, with their photos. Another app, or a plan
              without API access: export the reviews from the app and import the file.
            </p>
          </>
        ) : (
          <>
            {known && !showForm && (
              <Banner tone={app.tone === 'danger' ? 'danger' : app.tone === 'warning' ? 'warning' : 'info'} title={`${app.stateWords}${app.storeWords ? ` · ${app.storeWords}` : ''}`}>
                {app.words}{app.lastReadAt ? ` Last read ${shortTime(app.lastReadAt)}.` : ''}
              </Banner>
            )}
            {!known && app.state === 'disconnected' && <Banner tone="info" title="Disconnected">{app.words}</Banner>}
            {confirmOff && (
              <Banner tone="warning" title={`Disconnect ${app.name}?`}>
                Nexus stops reading {app.name} and deletes the {secretWords}.
                {app.replies ? ` Until you connect again, a reply to a ${app.name} review is copied and posted in ${app.name}, then marked as responded.` : ''}
                {' '}The reviews already read stay.
              </Banner>
            )}
            {showForm && (
              <>
                {app.fields.map((f) => (
                  <Field key={f.key} label={f.label} required hint={f.hint}>
                    <Input
                      type={f.secret ? 'password' : 'text'}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={f.placeholder ?? undefined}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={f.label}
                    />
                  </Field>
                ))}
                <p className={s.note}>
                  Nexus reads new reviews every 30 minutes, with their photos (a video is marked; watch it in {app.name}).{' '}
                  {app.replies
                    ? `A reply you send from the Inbox is posted under the review by ${app.name}, which also e-mails it to the reviewer.`
                    : `${app.name} gives apps no way to reply: the reply box says “Reply in ${app.name}” and opens it.`}
                  {' '}Nexus never sees your Shopify password.
                </p>
              </>
            )}
            <p className={s.note}>{app.planWords}</p>
            <span className={s.buttons}>
              <Button asChild size="sm"><Link href={inboxHref({ import: 1 })}><Upload size={13} aria-hidden /> Import reviews…</Link></Button>
              {app.replyHref && (
                <Button asChild size="sm">
                  <a href={app.replyHref} target="_blank" rel="noopener noreferrer" aria-label={`${openWords(app)} (opens a new tab)`}>{openWords(app)} <ExternalLink size={11} aria-hidden /></a>
                </Button>
              )}
            </span>
            {error && <Banner tone="danger" title={error} />}
          </>
        )}
        {!canManage && !app && apps && <p className={s.note}>{MANAGE_APPS}</p>}
      </div>
    </Modal>
  )
}
