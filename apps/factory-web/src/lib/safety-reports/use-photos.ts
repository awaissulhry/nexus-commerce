'use client'

import { useCallback, useRef, useState } from 'react'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { newIdempotencyKey } from '../api/client'
import { PHOTO_MAX } from './intake'
import { photoName } from './photos'
import type { SafetyPhoto, SafetyPhotosModel } from './view/SafetyPhotos'

/**
 * The photos after a send, for a door's container (the public page, the portal; the office record has its own): the list,
 * the camera sheet, one upload at a time with its own keys (a retry sends the same photo again with new keys), and why
 * "Add a photo" waits. `upload` is the door's call (lib/safety-reports/photos.ts `uploadSafetyPhoto` with its address).
 */
export function useSafetyPhotos(input: { number: string | null; until: string | null; max?: number; already?: number; offline?: boolean; upload: (photo: { blob: Blob; name: string }, keys: { announce: string; complete: string }) => Promise<unknown> }) {
  const [photos, setPhotos] = useState<readonly SafetyPhoto[]>([])
  const [capturing, setCapturing] = useState(false)
  const blobs = useRef(new Map<string, Blob>())
  const latest = useRef(input)
  latest.current = input
  const max = input.max ?? PHOTO_MAX

  const send = useCallback(async (key: string) => {
    const blob = blobs.current.get(key)
    const photo = blob ? { blob, name: key } : null
    if (!photo) return
    setPhotos((current) => current.map((entry) => (entry.key === key ? { ...entry, state: 'sending' } : entry)))
    try {
      await latest.current.upload(photo, { announce: newIdempotencyKey(), complete: newIdempotencyKey() })
      setPhotos((current) => current.map((entry) => (entry.key === key ? { ...entry, state: 'sent' } : entry)))
    } catch {
      setPhotos((current) => current.map((entry) => (entry.key === key ? { ...entry, state: 'failed' } : entry)))
    }
  }, [])

  const capture = useCallback(
    async (captured: CapturedPhoto) => {
      const name = photoName(latest.current.number ?? 'report', (latest.current.already ?? 0) + blobs.current.size + 1)
      blobs.current.set(name, captured.marked ?? captured.photo)
      setPhotos((current) => [...current, { key: name, name, state: 'sending' }])
      setCapturing(false)
      await send(name)
    },
    [send],
  )

  const taken = (input.already ?? 0) + photos.filter((photo) => photo.state !== 'failed').length
  const over = input.until !== null && Date.parse(input.until) <= Date.now()
  const held = input.offline ? 'photos.held.offline' : over ? 'photos.held.over' : taken >= max ? 'photos.held.full' : photos.some((photo) => photo.state === 'sending') ? 'photos.held.sending' : null

  const model: SafetyPhotosModel = { photos, max, until: input.until, held, capturing, ...(input.already ? { already: input.already } : {}) }
  return {
    model,
    actions: {
      onAdd: () => {
        if (!held) setCapturing(true)
      },
      onCapture: capture,
      onCloseCapture: () => setCapturing(false),
      onRetry: (key: string) => void send(key),
    },
    reset: () => {
      blobs.current.clear()
      setPhotos([])
      setCapturing(false)
    },
  }
}
