'use client'

import { useEffect, useRef, useState } from 'react'
import type { CameraScanner } from '@nexus/ui/floor'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useWords } from '../parts'

/**
 * "Scan the label" (design pop:service.new "Serial (scan or type)"; Owner answer 11-10: the factory phone or tablet camera):
 * the rear camera in a sheet reads the label's code, fills the serial and closes. Composed over the DS floor's
 * `CameraScanner` (the DS ScanInput is the floor's always-listening field, not a form field in a dialog; named in the step's
 * notes). No camera, or none allowed: it says so; typing the serial still works, and a USB scanner types into the field.
 */
export function ScanSheet({ scanner, onScanned, onClose }: { scanner: CameraScanner | null; onScanned: (code: string) => void; onClose: () => void }) {
  const { t } = useWords()
  const video = useRef<HTMLVideoElement>(null)
  const latest = useRef(onScanned)
  latest.current = onScanned
  const [state, setState] = useState<'starting' | 'on' | 'failed' | 'none'>(scanner ? 'starting' : 'none')

  useEffect(() => {
    const element = video.current
    if (!scanner || !element) return
    let stop: (() => void) | null = null
    let done = false
    scanner
      .start(element, (code) => {
        if (done || code.trim() === '') return
        done = true
        stop?.()
        latest.current(code.trim())
      })
      .then((stopper) => {
        if (done) stopper()
        else {
          stop = stopper
          setState('on')
        }
      })
      .catch(() => {
        if (!done) setState('failed')
      })
    return () => {
      done = true
      stop?.()
    }
  }, [scanner])

  return (
    <Modal open sheet size="md" onClose={onClose} title={t('scan.title')} footer={<Button onClick={onClose}>{t('common.cancel')}</Button>}>
      <div className="fw-svc-dialog">
        <p className="fw-svc-hint">{t('scan.intro')}</p>
        {scanner && (
          <div className="fw-svc-video" data-state={state}>
            <video ref={video} muted playsInline aria-label={t('scan.video')} />
          </div>
        )}
        {state === 'starting' && (
          <p className="fw-svc-hint" role="status">
            <Spinner size={12} /> {t('scan.starting')}
          </p>
        )}
        {(state === 'failed' || state === 'none') && <Banner tone="warning" title={t('scan.noCamera')} />}
      </div>
    </Modal>
  )
}
