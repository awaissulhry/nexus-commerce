'use client'

import { useEffect, useRef, useState } from 'react'
import { drawn, failedRecently, keepSmall, recordOf, smallOf, staleOf, want, type ReadPictures } from './cache'
import { rowPictureOf, wantsSmall, type PictureSource, type RowPicture } from './model'

/**
 * F-SA-211 — one record's picture for the part (RecordPicture, PictureViewer, and a pane that draws its own <img>):
 *
 *   picture    the row's own field (a list read names it), or undefined when the row names none (the week board): then the
 *              batch read names the style and the file too. null: the record has no style yet (the placeholder).
 *   src        the small preview's address to draw: undefined while it is read, null for the placeholder (no file, no right,
 *              no preview yet, the read failed); an expired address is drawn until the fresh one has loaded.
 *   demo       design fixtures: the address to draw, nothing read. `held`: a caller that already holds the address.
 */
export interface RecordPictureInput {
  readonly source: PictureSource
  readonly recordId: string
  readonly picture?: RowPicture | null
  readonly styleCount?: number
  readonly read?: ReadPictures | null
  readonly demo?: string
  readonly held?: { readonly url: string; readonly expiresAt: string } | null
}

export interface RecordPictureState {
  readonly picture: RowPicture | null | undefined
  readonly styleCount: number
  readonly src: string | null | undefined
}

/** Load `url` before it replaces what is drawn (a browser only; elsewhere at once). */
function whenLoaded(url: string, done: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.Image === 'undefined') {
    done()
    return () => undefined
  }
  const image = new window.Image()
  let live = true
  image.onload = () => live && done()
  image.onerror = () => live && done()
  image.src = url
  return () => {
    live = false
  }
}

export function useRecordPicture(input: RecordPictureInput): RecordPictureState {
  const { source, recordId, read, demo, held } = input
  const own = input.picture
  const known = own === undefined ? recordOf(source, recordId) : undefined
  const [answered, setAnswered] = useState<{ picture: RowPicture | null; styleCount: number } | undefined>(known === undefined ? undefined : known === null ? { picture: null, styleCount: 0 } : { picture: rowPictureOf(known), styleCount: known.styleCount })
  const picture = own !== undefined ? own : answered?.picture
  const styleCount = own !== undefined ? (input.styleCount ?? 1) : (answered?.styleCount ?? input.styleCount ?? 1)
  const fileId = picture?.fileId ?? null
  const first = (): string | null | undefined => {
    if (demo !== undefined) return demo
    if (held) return held.url
    if (picture === undefined) return read ? undefined : null
    if (!wantsSmall(picture) || !read) return null
    return smallOf(fileId) ?? staleOf(fileId) ?? undefined
  }
  const [src, setSrc] = useState<string | null | undefined>(first)
  const readRef = useRef(read)
  readRef.current = read

  // A caller that holds the address gives it to the cache (the same file elsewhere finds it).
  useEffect(() => {
    if (held && fileId) keepSmall(fileId, held)
  }, [held, fileId])

  useEffect(() => {
    if (demo !== undefined) return setSrc(demo)
    if (held) {
      drawn(fileId, held.url)
      return setSrc(held.url)
    }
    const reader = readRef.current
    // The row names no picture of its own: the batch read names the style and the file first.
    if (own === undefined) {
      if (!reader) return setSrc(null)
      const kept = recordOf(source, recordId)
      if (kept !== undefined) {
        setAnswered(kept === null ? { picture: null, styleCount: 0 } : { picture: rowPictureOf(kept), styleCount: kept.styleCount })
        if (!kept?.small || !kept.fileId) return setSrc(null)
        const fresh = smallOf(kept.fileId)
        if (fresh) {
          drawn(kept.fileId, fresh)
          return setSrc(fresh)
        }
      }
      if (failedRecently(source, recordId)) {
        if (kept === undefined) setAnswered({ picture: null, styleCount: 0 })
        return setSrc(staleOf(kept?.fileId) ?? null)
      }
      let gone = false
      let stop = () => undefined as void
      void want(source, recordId, reader).then((wanted) => {
        if (gone) return
        if ('failed' in wanted) {
          setAnswered((current) => current ?? { picture: null, styleCount: 0 })
          return setSrc((current) => current ?? null)
        }
        const answer = wanted.answer
        setAnswered(answer ? { picture: rowPictureOf(answer), styleCount: answer.styleCount } : { picture: null, styleCount: 0 })
        if (!answer?.small || !answer.fileId) return setSrc(null)
        const url = answer.small.url
        const file = answer.fileId
        stop = whenLoaded(url, () => {
          drawn(file, url)
          setSrc(url)
        })
      })
      return () => {
        gone = true
        stop()
      }
    }
    if (!wantsSmall(own) || !reader) return setSrc(null)
    const fresh = smallOf(fileId)
    if (fresh) {
      drawn(fileId, fresh)
      return setSrc(fresh)
    }
    // Stale-while-reading: the last address drawn for this file stays until the fresh one has loaded.
    const stale = staleOf(fileId)
    setSrc(stale ?? undefined)
    if (failedRecently(source, recordId)) return setSrc(stale ?? null)
    let gone = false
    let stop = () => undefined as void
    void want(source, recordId, reader).then((wanted) => {
      if (gone) return
      const url = 'failed' in wanted ? null : wanted.answer?.fileId === fileId ? (wanted.answer?.small?.url ?? null) : (smallOf(fileId) ?? null)
      if (!url) return setSrc(stale ?? null)
      stop = whenLoaded(url, () => {
        drawn(fileId, url)
        setSrc(url)
      })
    })
    return () => {
      gone = true
      stop()
    }
    // The record, its file and whether it has a preview decide; `read` is read through its ref.
  }, [source, recordId, own === undefined, fileId, own?.small, demo, held?.url, read === null || read === undefined])

  return { picture, styleCount, src }
}
