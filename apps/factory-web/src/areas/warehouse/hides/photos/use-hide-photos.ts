'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import type { ApiClient } from '../../../../lib/api/client'
import { readProblem } from '../../../_shared/stock/model'
import { hidePhotos, photoUrl, uploadHidePhoto } from './api'
import { NO_PHOTOS, newestFirst, PHOTO_MAX_BYTES, photoFileProblem, type HidePhotosState, type HidePhotoView, type PhotoLightboxModel, type PhotoUpload } from './model'

/**
 * The photos of a set of hides (B-W2b-131; the Hides grid's Photo column and the hide record's Photos): one read for every
 * hide asked (`GET /inventory/leather/photos`), then the image addresses — of the newest photo of each hide (`urls: 'first'`,
 * a grid's Thumbnail) or of every photo (`urls: 'all'`, a record) — only for hides that have photos. The Lightbox (design
 * hd-photo) opens on one hide's photos and reads their addresses again (a presigned address lives 60 seconds). `upload`
 * adds an office photo to one hide (files.upload) and reads its photos again.
 *
 * Generic over hide ids: pass the ids on screen; a new set reads again (the same set, in any order, does not).
 */
export function useHidePhotos(api: ApiClient, hideIds: readonly string[], options: { enabled: boolean; urls: 'first' | 'all' }) {
  const [state, setState] = useState<HidePhotosState>(NO_PHOTOS)
  const [lightbox, setLightbox] = useState<PhotoLightboxModel | null>(null)
  const [uploads, setUploads] = useState<PhotoUpload[]>([])
  const key = useMemo(() => [...new Set(hideIds)].sort().join(','), [hideIds])
  const readId = useRef(0)
  const latest = useRef(state)
  latest.current = state

  const setPhoto = useCallback((hideId: string, fileId: string, next: Partial<HidePhotoView>) => {
    setState((current) => {
      const list = current.byHide[hideId]
      if (!list) return current
      return { ...current, byHide: { ...current.byHide, [hideId]: list.map((photo) => (photo.fileId === fileId ? { ...photo, ...next } : photo)) } }
    })
  }, [])

  const readUrls = useCallback(
    async (hideId: string, photos: readonly HidePhotoView[], id: number | null) => {
      await Promise.all(
        photos.map(async (photo) => {
          try {
            const src = await photoUrl(api, photo.fileId)
            if (id === null || id === readId.current) setPhoto(hideId, photo.fileId, { src, broken: false })
          } catch {
            if (id === null || id === readId.current) setPhoto(hideId, photo.fileId, { src: null, broken: true })
          }
        }),
      )
    },
    [api, setPhoto],
  )

  const load = useCallback(async () => {
    const ids = key === '' ? [] : key.split(',')
    if (!options.enabled || ids.length === 0) {
      setState(NO_PHOTOS)
      return
    }
    const id = ++readId.current
    setState((current) => ({ ...current, loading: true, problem: null }))
    try {
      const answer = await hidePhotos(api, ids)
      if (id !== readId.current) return
      const byHide: Record<string, HidePhotoView[]> = Object.fromEntries(ids.map((hideId) => [hideId, [] as HidePhotoView[]]))
      for (const entry of answer.hides) byHide[entry.hideId] = newestFirst(entry.photos).map((photo) => ({ ...photo, src: null, broken: false }))
      setState({ canRead: answer.canRead, byHide, loading: false, problem: null })
      for (const [hideId, photos] of Object.entries(byHide)) {
        if (photos.length === 0) continue
        void readUrls(hideId, options.urls === 'first' ? photos.slice(0, 1) : photos, id)
      }
    } catch (error) {
      if (id !== readId.current) return
      setState({ canRead: isApiError(error) && error.kind === 'forbidden' ? false : null, byHide: {}, loading: false, problem: readProblem(error) })
    }
  }, [api, key, options.enabled, options.urls, readUrls])

  useEffect(() => {
    void load()
  }, [load])

  /** Opens one hide's photos at `index`; their addresses are read again (fresh) while it opens. */
  const open = useCallback(
    (hideId: string, hideCode: string, index = 0) => {
      const photos = latest.current.byHide[hideId] ?? []
      if (photos.length === 0) return
      setLightbox({ hideId, hideCode, photos, index: Math.max(0, Math.min(photos.length - 1, index)) })
      void readUrls(hideId, photos, null)
    },
    [readUrls],
  )

  // The Lightbox follows the photos as their addresses arrive.
  const shown = lightbox ? { ...lightbox, photos: state.byHide[lightbox.hideId] ?? lightbox.photos } : null

  const upload = useCallback(
    async (hide: { id: string; companyId: string }, files: readonly File[]) => {
      for (const file of files) {
        const uploadKey = globalThis.crypto.randomUUID()
        const problem = photoFileProblem({ type: file.type, size: file.size }, PHOTO_MAX_BYTES)
        if (problem) {
          setUploads((list) => [...list, { key: uploadKey, name: file.name, phase: 'failed', problem }])
          continue
        }
        setUploads((list) => [...list, { key: uploadKey, name: file.name, phase: 'sending', problem: null }])
        try {
          const status = await uploadHidePhoto(api, hide, file)
          setUploads((list) => (status === 'AVAILABLE' ? list.filter((entry) => entry.key !== uploadKey) : list.map((entry) => (entry.key === uploadKey ? { ...entry, phase: 'failed', problem: 'hd.photos.problem.quarantined' } : entry))))
        } catch (error) {
          const why = isApiError(error) ? (error.kind === 'forbidden' || error.kind === 'step_up' ? 'hd.photos.problem.forbidden' : error.kind === 'unavailable' ? 'hd.photos.problem.offline' : error.kind === 'invalid' ? 'hd.photos.problem.refused' : 'hd.photos.problem.failed') : 'hd.photos.problem.store'
          setUploads((list) => list.map((entry) => (entry.key === uploadKey ? { ...entry, phase: 'failed', problem: why } : entry)))
        }
      }
      void load()
    },
    [api, load],
  )

  return {
    state,
    lightbox: shown,
    uploads,
    reload: () => void load(),
    open,
    step: (index: number) => setLightbox((current) => (current ? { ...current, index } : current)),
    close: () => setLightbox(null),
    upload: (hide: { id: string; companyId: string }, files: readonly File[]) => void upload(hide, files),
    dismissUpload: (uploadKey: string) => setUploads((list) => list.filter((entry) => entry.key !== uploadKey)),
  }
}

export type HidePhotosHook = ReturnType<typeof useHidePhotos>
