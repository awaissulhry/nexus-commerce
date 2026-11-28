'use client'

import { useEffect, useRef } from 'react'
import { CircleAlert, Hourglass } from 'lucide-react'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { CaptureStep } from '../../../tasks/machine/view/MediaParts'
import { TaskLine } from '../../../tasks/shared/view/TaskParts'
import '../help2.css'

/**
 * owb-fl8 — ONE window that takes a photo or a voice note on a phone: the DS PhotoCapture (its outline guide and "Keep faces out of
 * the picture", D21) or the floor's voice recorder (FT/machine/view/MediaParts.tsx: imported, never copied; its words are the
 * machine screen's `voice.*`). The host sends what was taken; the window says "Sending…" while it goes and the problem when it
 * failed. Opened only online: the host holds the button with "Needs the network" before.
 */

export interface MediaWindowProps {
  readonly open: { readonly kind: 'PHOTO' | 'AUDIO'; readonly title: string } | null
  readonly busy: boolean
  /** The words of a failed send (null: none). */
  readonly failed: string | null
  readonly onPhoto: (blob: Blob) => void
  /** The note and when the recorder was opened (its length when the browser cannot decode it). */
  readonly onVoice: (blob: Blob, openedAt: number) => void
  readonly onClose: () => void
}

export function MediaWindow({ open, busy, failed, onPhoto, onVoice, onClose }: MediaWindowProps) {
  const machine = useT('floor-machine')
  const t = useT('floor-help2')
  const openedAt = useRef(0)
  const isOpen = open !== null
  useEffect(() => {
    if (isOpen) openedAt.current = Date.now()
  }, [isOpen])
  return (
    <Modal open={open !== null} onClose={onClose} title={open?.title} size="md" sheet className="fw-floor-dialog" closeHeld={busy ? t('media.busy') : null}>
      {open ? (
        <div className="fw-h2-window">
          {busy ? (
            <TaskLine tone="info" icon={<Hourglass />}>
              {t('media.busy')}
            </TaskLine>
          ) : (
            <CaptureStep
              kind={open.kind}
              title={open.title}
              t={machine}
              onPhoto={onPhoto}
              onVoice={(blob) => onVoice(blob, openedAt.current)}
              onCancel={onClose}
            />
          )}
          {failed ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {failed}
            </TaskLine>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}
