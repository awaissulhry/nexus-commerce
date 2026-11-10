'use client'

import { useEffect } from 'react'
import { X, ZoomIn, ZoomOut } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { Modal } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import { ZOOM_LEVELS, zoomIn, zoomOut } from '../model'

/**
 * pop:instructions.zoom "Photo" (design: a step's photo full-screen with + / − and Close; Esc). The DS Modal at its media size
 * (`full`), the photo scaled inside a scrolling area so a zoomed photo can be moved with a finger; + and − on the keyboard too.
 */
export function ZoomDialog({ zoom, src, alt, t, onLevel, onClose }: { zoom: { readonly mediaId: string; readonly level: number } | null; src: string | null; alt: string; t: Translate; onLevel: (level: number) => void; onClose: () => void }) {
  const level = zoom?.level ?? 1
  useEffect(() => {
    if (!zoom) return
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        onLevel(zoomIn(level))
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        onLevel(zoomOut(level))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [zoom, level, onLevel])
  const most = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!
  const least = ZOOM_LEVELS[0]
  return (
    <Modal
      open={zoom !== null}
      onClose={onClose}
      size="full"
      title={t('zoom.title')}
      footer={
        <div className="fw-fi-zoom-bar">
          <FloorButton size="lg" variant="secondary" icon={<ZoomOut />} heldReason={level <= least ? t('zoom.leastHeld') : null} onClick={() => onLevel(zoomOut(level))}>
            {t('zoom.out')}
          </FloorButton>
          <span className="fw-fi-zoom-level" aria-live="polite">
            {t('zoom.level', { percent: Math.round(level * 100) })}
          </span>
          <FloorButton size="lg" variant="secondary" icon={<ZoomIn />} heldReason={level >= most ? t('zoom.mostHeld') : null} onClick={() => onLevel(zoomIn(level))}>
            {t('zoom.in')}
          </FloorButton>
          <span className="grow" />
          <FloorButton size="lg" variant="primary" icon={<X />} onClick={onClose}>
            {t('zoom.close')}
          </FloorButton>
        </div>
      }
    >
      <div className="fw-fi-zoom-area" tabIndex={0} aria-label={t('zoom.area')}>
        {src ? <img src={src} alt={alt} style={{ width: `${level * 100}%` }} /> : <p className="fw-floor-muted">{t('steps.mediaOffline')}</p>}
      </div>
    </Modal>
  )
}
