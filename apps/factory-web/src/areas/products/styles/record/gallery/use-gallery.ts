'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { useLiveChanges } from '../../../../../record-panels/live'
import type { StyleNotice } from '../record-model'
import { addPicture, orderPictures, readPictures, removePicture, setMainPicture, updatePicture, uploadPictureFile, type StylePicturesView } from './api'
import { galleryProblem, galleryReadProblem, movedOrder, NO_UPLOAD, pictureOf, type GalleryActions, type GalleryDialog, type GalleryModel, type GalleryNotice, type GalleryPart, type GalleryUpload, type PictureTarget } from './gallery-model'

/**
 * The Sketches and pictures section's container hook (B-W2b-236; SCR-304): reads the style's pictures while the Overview
 * shows (again when the style changes, and on `style.pictures_changed` of this style), and does what the section asks
 * through the studio's ONE write queue (`write`: one write at a time, the band's save words; a refusal keeps the gallery as
 * the server has it and says why in our words). Files are sent from this device first (files platform), one after the
 * other, then named pictures.
 */
export function useGallery({
  api,
  style,
  loadKey,
  enabled,
  canManage,
  canArrange,
  write,
}: {
  api: ApiClient
  style: { id: string; companyId: string | null } | null
  /** Changes when the style changes (its version): the section reads again. */
  loadKey: string | null
  enabled: boolean
  canManage: boolean
  canArrange: boolean
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
}): { model: GalleryModel; actions: GalleryActions; reload: () => void } {
  const [part, setPart] = useState<GalleryPart>({ status: 'idle' })
  const valueRef = useRef<StylePicturesView | null>(null)
  const [dialog, setDialog] = useState<GalleryDialog | null>(null)
  const [notice, setNotice] = useState<GalleryNotice | null>(null)
  const [upload, setUpload] = useState<GalleryUpload>(NO_UPLOAD)
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const styleId = style?.id ?? null

  const setValue = useCallback((next: StylePicturesView) => {
    valueRef.current = next
    setPart({ status: 'ready', value: next })
  }, [])

  const load = useCallback(() => {
    if (!styleId) return
    setPart((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    readPictures(api, styleId)
      .then(setValue)
      .catch((error: unknown) => setPart({ status: 'error', problem: galleryReadProblem(error) }))
  }, [api, styleId, setValue])

  useEffect(() => {
    if (!enabled || !styleId) {
      valueRef.current = null
      setPart({ status: 'idle' })
      return
    }
    load()
    // The key holds the style's version.
  }, [loadKey, enabled, styleId])

  const reload = useCallback(() => {
    if (enabled && valueRef.current) load()
  }, [enabled, load])

  useLiveChanges(
    {
      onChange: (change) => {
        if (change.type === 'style.pictures_changed' && change.fields['styleId'] === styleId && !busy) reload()
      },
    },
    enabled && !!styleId,
  )

  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  /** One write through the studio's queue; the section takes the answer; the error is kept for our words. */
  const run = async (work: () => Promise<StylePicturesView | null>, done?: GalleryNotice): Promise<boolean> => {
    let failure: unknown = null
    setBusy(true)
    const ok = await write(async () => {
      try {
        const next = await work()
        if (next) setValue(next)
      } catch (error) {
        failure = error
        throw error
      }
    })
    setBusy(false)
    setNotice(ok ? (done ?? null) : { key: galleryProblem(failure), tone: 'danger' })
    if (!ok && failure && galleryProblem(failure) !== 'gallery.problem.invalid') load()
    return ok
  }

  const actions: GalleryActions = {
    onRetry: load,
    onDialog: (next) => {
      setNotice(null)
      setDialog(next)
    },
    onDismissNotice: () => setNotice(null),
    onUpload: (files, target) => {
      if (!style || files.length === 0) return
      void (async () => {
        setUpload({ state: 'sending', done: 0, of: files.length, problem: null })
        const held: string[] = []
        let added = 0
        for (const [index, file] of files.entries()) {
          const one: PictureTarget = { ...target, caption: files.length === 1 ? target.caption : null }
          const ok = await run(async () => {
            const sent = await uploadPictureFile(api, style, file)
            if (!sent.available) {
              held.push(file.name)
              return null
            }
            return addPicture(api, style.id, { fileId: sent.fileId, kind: one.kind, revisionId: one.revisionId, colourwayId: one.colourwayId, caption: one.caption, callouts: [] })
          })
          if (!ok) {
            setUpload({ state: 'failed', done: index, of: files.length, problem: 'gallery.add.failed' })
            return
          }
          added += held.includes(file.name) ? 0 : 1
          setUpload({ state: 'sending', done: index + 1, of: files.length, problem: null })
        }
        setUpload(NO_UPLOAD)
        setDialog(null)
        if (held.length > 0) {
          setNotice({ key: 'gallery.notice.held', tone: 'info', params: { count: held.length } })
          load()
        } else setNotice({ key: 'gallery.notice.added', tone: 'success', params: { count: added } })
      })()
    },
    onAddExisting: (fileId, target) => {
      if (!styleId) return
      void run(() => addPicture(api, styleId, { fileId, kind: target.kind, revisionId: target.revisionId, colourwayId: target.colourwayId, caption: target.caption, callouts: [] }), { key: 'gallery.notice.added', tone: 'success', params: { count: 1 } })
    },
    onSave: (pictureId, changes) => {
      const picture = valueRef.current ? pictureOf(valueRef.current, pictureId) : null
      if (!styleId || !picture) return
      void run(() => updatePicture(api, styleId, pictureId, { version: picture.version, ...changes })).then((ok) => {
        if (ok) setDialog(null)
      })
    },
    onMain: (pictureId) => {
      const picture = valueRef.current ? pictureOf(valueRef.current, pictureId) : null
      if (!styleId || !picture || picture.isMain) return
      void run(() => setMainPicture(api, styleId, picture), { key: 'gallery.notice.main', tone: 'success' })
    },
    onMove: (pictureId, to) => {
      const view = valueRef.current
      const ids = view ? movedOrder(view, pictureId, to) : null
      if (!styleId || !ids) return
      void run(() => orderPictures(api, styleId, ids))
    },
    onRemove: (pictureId) => {
      const picture = valueRef.current ? pictureOf(valueRef.current, pictureId) : null
      if (!styleId || !picture) return
      void run(() => removePicture(api, styleId, picture), { key: picture.isMain ? 'gallery.notice.removedMain' : 'gallery.notice.removed', tone: 'success' }).then((ok) => {
        if (ok) setDialog(null)
      })
    },
  }

  return { model: { part, canManage, canArrange, dialog, busy, notice, upload, offline }, actions, reload }
}
