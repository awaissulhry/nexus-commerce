'use client'

/**
 * Reviews › Requests › Queue — the sending banner: on (next run, last run) with "Pause sending" (asks why) and
 * "Run now" (lists what it sends first: a sent request cannot be taken back); or paused (who, when, why, what waits)
 * with "Resume sending" and Run now held. Words from sendingModel.ts; the page does the calls.
 */
import { useCallback, useState } from 'react'
import { Pause, Play, Send } from 'lucide-react'
import { Banner, Field, Modal, useActionConfirm } from '@/design-system/components'
import { Button, Skeleton, Textarea } from '@/design-system/primitives'
import type { SendingState } from './queueDatasource'
import { PAUSE_REASON_MAX, pauseReasonHeld, runConfirm, sendingBannerView } from './sendingModel'
import s from './queue.module.css'

const MANAGE_SENDING = "You need 'Manage reviews' to pause, resume or run the sender."

export interface SendingBannerProps {
  sending: SendingState | null
  error: string | null
  loading: boolean
  canManage: boolean
  /** A call is on its way (pause, resume, run). */
  busy: boolean
  onRetry: () => void
  onPause: (reason: string) => Promise<boolean>
  onResume: () => void
  onRun: () => void
}

export function SendingBanner({ sending, error, loading, canManage, busy, onRetry, onPause, onResume, onRun }: SendingBannerProps) {
  const confirm = useActionConfirm()
  const [pauseOpen, setPauseOpen] = useState(false)
  const [reason, setReason] = useState('')

  const askRun = useCallback(async () => {
    if (!sending) return
    const c = runConfirm(sending)
    const ok = await confirm.ask({ level: 'confirm', title: c.title, confirmLabel: c.confirmLabel, consequences: c.consequences, sideEffects: c.sideEffects })
    if (ok) onRun()
  }, [sending, confirm, onRun])

  const submitPause = useCallback(async () => {
    if (pauseReasonHeld(reason)) return
    if (await onPause(reason.trim())) {
      setPauseOpen(false)
      setReason('')
    }
  }, [reason, onPause])

  if (error && !sending) {
    return (
      <Banner tone="danger" title="Could not read whether sending is on" action={<Button size="sm" onClick={onRetry} heldReason={loading ? 'Reading…' : null}>Try again</Button>}>
        {error}
      </Banner>
    )
  }
  if (!sending) return <Skeleton height={58} />

  const view = sendingBannerView(sending)
  const runHeld = !canManage ? MANAGE_SENDING : busy ? 'Working…' : view.runHeld
  const switchHeld = !canManage ? MANAGE_SENDING : busy ? 'Working…' : null
  const pauseHeld = pauseReasonHeld(reason)

  return (
    <>
      <Banner
        tone={view.tone}
        title={view.title}
        action={(
          <span className={s.bannerActions}>
            {view.state === 'paused' ? (
              <Button size="sm" variant="primary" onClick={onResume} heldReason={switchHeld}>
                <Play size={13} aria-hidden /> Resume sending
              </Button>
            ) : (
              <Button size="sm" onClick={() => setPauseOpen(true)} heldReason={switchHeld}>
                <Pause size={13} aria-hidden /> Pause sending
              </Button>
            )}
            <Button size="sm" variant={view.state === 'paused' ? 'secondary' : 'primary'} onClick={() => void askRun()} heldReason={runHeld}>
              <Send size={13} aria-hidden /> Run now
            </Button>
          </span>
        )}
      >
        {view.detail}
        {error && <> {' '}The last refresh failed: {error}</>}
      </Banner>

      {pauseOpen && (
        <Modal
          open
          onClose={() => setPauseOpen(false)}
          title="Pause sending?"
          size="md"
          footer={(
            <>
              <Button onClick={() => setPauseOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void submitPause()} heldReason={pauseHeld ?? (busy ? 'Working…' : null)}>
                Pause sending
              </Button>
            </>
          )}
        >
          <p className={s.modalLead}>
            Nothing goes out until someone resumes: not the hourly sender, not Run now, not Send now. Requests keep their place and wait.
            Amazon’s day-30 limit still counts while sending is paused.
          </p>
          <Field label="Why is sending paused?" required hint="Shown on this page to everyone, with your name and the time.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} limit={PAUSE_REASON_MAX} rows={3} />
          </Field>
        </Modal>
      )}
      {confirm.element}
    </>
  )
}
