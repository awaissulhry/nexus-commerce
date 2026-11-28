'use client'

import { useEffect, useState } from 'react'
import { Camera, Check, WifiOff, X } from 'lucide-react'
import { FloorButton, useConfirmFeedback } from '@nexus/ui/floor'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { useFloor } from '../../FloorApp'
import { uploadNoteFile } from '../../tasks/scans/api'
import { TaskLine } from '../../tasks/shared/view/TaskParts'
import type { HelpRead } from '../help/api'
import { mediaName } from '../help/model'
import { problemWords } from '../help/view/HelpWindowView'
import { MediaWindow } from '../help/view/MediaWindow'
import { PHOTO_NOTE_KIND, photoHeld, photoNotePayload } from './model'
import '../help/help2.css'

/**
 * owb-fl8 step 3 — the Photo tile of every basket and its window: the DS camera with "Keep faces out of the picture" → the photo
 * goes to the office as today's floor photo note on the basket's work order (uploadNoteFile of the Operation screen: imported, not
 * copied), the note through the queue. With no network the window says "Needs the network" (a photo cannot wait on the phone).
 */

export interface PhotoProps {
  readonly read: HelpRead
  readonly onChanged?: () => void
}

export function PhotoTile({ read, onChanged }: PhotoProps) {
  const t = useT('floor-help2')
  const [open, setOpen] = useState(false)
  return (
    <>
      <FloorButton className="fw-h2-tile" variant="secondary" icon={<Camera />} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {t('tile.photo')}
      </FloorButton>
      <PhotoWindow open={open} onClose={() => setOpen(false)} read={read} onChanged={onChanged} />
    </>
  )
}

export interface PhotoWindowProps extends PhotoProps {
  readonly open: boolean
  readonly onClose: () => void
}

export function PhotoWindow({ open, onClose, read, onChanged }: PhotoWindowProps) {
  const t = useT('floor-help2')
  const { api, queue, online, sessionEnded } = useFloor()
  const feedback = useConfirmFeedback()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (open) {
      setFailed(null)
      setSaved(false)
    }
  }, [open])

  const close = () => {
    if (busy) return
    onClose()
  }

  const send = async (blob: Blob) => {
    setBusy(true)
    setFailed(null)
    const up = await uploadNoteFile(api, read.basket.workOrderId, blob, mediaName(read.basket.code, 'photo', new Date(), blob.type))
    if (!up.ok) {
      setBusy(false)
      if (up.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setFailed(problemWords(t, up.problem))
    }
    try {
      await queue.enqueue(PHOTO_NOTE_KIND, photoNotePayload(read, up.value.fileId))
    } catch {
      setBusy(false)
      feedback('error')
      return setFailed(t('window.failed'))
    }
    setBusy(false)
    feedback('success')
    setSaved(true)
    onChanged?.()
  }

  const held = photoHeld(online)
  if (open && (held || saved)) {
    return (
      <Modal
        open
        onClose={close}
        title={t('photo.title', { code: read.basket.code })}
        size="md"
        sheet
        className="fw-floor-dialog"
        footer={
          <FloorButton size="lg" variant={saved ? 'primary' : 'quiet'} icon={saved ? <Check /> : <X />} onClick={close}>
            {t('window.close')}
          </FloorButton>
        }
      >
        <div className="fw-h2-window">
          {saved ? (
            <TaskLine tone="success" icon={<Check />}>
              {t('photo.saved')}
            </TaskLine>
          ) : (
            <TaskLine tone="warning" icon={<WifiOff />} alert>
              {t('photo.offline')}
            </TaskLine>
          )}
        </div>
      </Modal>
    )
  }
  return <MediaWindow open={open ? { kind: 'PHOTO', title: t('photo.title', { code: read.basket.code }) } : null} busy={busy} failed={failed} onPhoto={(blob) => void send(blob)} onVoice={() => undefined} onClose={close} />
}
