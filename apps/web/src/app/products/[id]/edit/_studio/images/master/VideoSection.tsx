'use client'

/**
 * PES.7 — master video.
 *
 * Sibling to the gallery, not a tab of its own: video is master media, and an operator checking a
 * product's media should not have to remember which surface holds which kind. It renders only when
 * the product HAS video or the operator is adding some — an always-present empty video panel is
 * dead space on the many products that will never have one.
 *
 * Each tile plays inline from its poster and carries its channel checks. A check whose input the
 * server never recorded reads "not recorded", never a green tick — see `videoChecks.ts`.
 */
import { useCallback, useState } from 'react'

import { FileDropzone } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

import { apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import type { MasterAsset, UploadVideoResponse } from '../types'
import { checkVideo, worstState, type CheckState } from './videoChecks'
import styles from '../images.module.css'

export interface VideoSectionProps {
  productId: string
  videos: MasterAsset[]
  onVideosChange(next: MasterAsset[]): void
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
  onError(message: string | null): void
}

/** What the API's route accepts (`/\.(mp4|mov|webm|mkv|m4v)$/i`) — stated once, used by both. */
const ACCEPT = '.mp4,.mov,.webm,.mkv,.m4v'
const ACCEPT_RE = /\.(mp4|mov|webm|mkv|m4v)$/i

const STATE_MARK: Record<CheckState, string> = { pass: '✓', warn: '!', fail: '×', unknown: '?' }

function seconds(n: number | null): string {
  if (n == null || n <= 0) return '—'
  const m = Math.floor(n / 60)
  const s = Math.round(n % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

export function VideoSection({ productId, videos, onVideosChange, write, onError }: VideoSectionProps) {
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)

  const upload = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setBusy(true)
    onError(null)
    const added: MasterAsset[] = []
    const refusals: string[] = []
    for (const file of files) {
      // Refuse client-side what the route refuses, so a 400 does not have to teach the rule.
      if (!ACCEPT_RE.test(file.name)) {
        refusals.push(`${file.name}: not a supported video container (MP4, MOV, WebM, MKV, M4V)`)
        continue
      }
      const fd = new FormData()
      fd.append('file', file)
      const res = await write(writeSubject.upload(file.name), () => apiSend<UploadVideoResponse>(
        `${routes.videos(productId)}?alt=${encodeURIComponent(file.name)}`, 'POST', fd))
      if (res.ok && res.data?.id) {
        // The route answers an identical upload with the EXISTING row (`reused: 'exact'`) and a
        // 200, so a dedup hit must not be added twice.
        if (!videos.some((v) => v.id === res.data!.id)) added.push(res.data)
        else refusals.push(`${file.name}: already on this product`)
      } else if (!res.ok) {
        refusals.push(`${file.name}: ${res.message}`)
      }
    }
    if (added.length) onVideosChange([...videos, ...added])
    if (refusals.length) onError(refusals.join(' · '))
    setBusy(false)
  }, [onError, onVideosChange, productId, videos, write])

  const remove = useCallback(async (video: MasterAsset) => {
    setBusy(true)
    // Videos delete through the shared image route — one row type, one delete.
    const res = await write(writeSubject.asset(video.id), () => apiSend<unknown>(routes.masterImage(productId, video.id), 'DELETE'))
    setBusy(false)
    if (!res.ok) { onError(res.message); return }
    onVideosChange(videos.filter((v) => v.id !== video.id))
  }, [onError, onVideosChange, productId, videos, write])

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Video</h2>
        <span className={styles.sectionCount}>
          {videos.length === 0 ? 'none' : `${videos.length} video${videos.length === 1 ? '' : 's'}`}
        </span>
        <span className={styles.spacer} />
      </header>

      {/* The DS dropzone. `ACCEPT` is already an extension list, so nothing narrows here. */}
      <FileDropzone
        onFiles={(files) => void upload(files)}
        accept={ACCEPT}
        multiple
        disabled={busy}
        hint={busy ? 'Working…' : undefined}
      />

      {videos.length === 0 ? (
        <p className={styles.hint}>
          No video on this product. Channels show one where you give them one — Amazon in A+, eBay
          and Shopify in the gallery.
        </p>
      ) : (
        <div className={styles.gallery}>
          {videos.map((v) => {
            const checks = checkVideo(v)
            const worst = worstState(checks)
            return (
              <div key={v.id} className={styles.tile} data-testid="video-tile">
                <div className={styles.thumb}>
                  {playing === v.id ? (
                    // Controls, and no autoplay-with-sound: a video that starts talking because a
                    // tile scrolled past is the reason browsers block it.
                    <video className={styles.thumbImg} src={v.url} poster={v.posterUrl ?? undefined} controls autoPlay />
                  ) : (
                    <Button variant="ghost" className={styles.playButton} onClick={() => setPlaying(v.id)}
                      aria-label={`Play ${v.alt ?? 'video'}`}>
                      {v.posterUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img className={styles.thumbImg} src={v.posterUrl} alt="" loading="lazy" />
                        : <span className={styles.thumbEmpty}>No poster frame</span>}
                      <span className={styles.playGlyph} aria-hidden="true">▶</span>
                    </Button>
                  )}
                </div>

                <div className={styles.tileBody}>
                  <span className={styles.altText} title={v.alt ?? ''}>{v.alt ?? 'Untitled video'}</span>
                  <span className={styles.tileMeta}>
                    <span>{seconds(v.durationSec)}</span>
                    <span className={`${styles.checkMark} ${styles[`check_${worst}`]}`}
                      title={checks.map((c) => `${c.id}: ${c.message}`).join('\n')}>
                      {STATE_MARK[worst]} {worst === 'unknown' ? 'unverified' : worst}
                    </span>
                  </span>
                  <div className={styles.actions}>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(v)}>Delete</Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
