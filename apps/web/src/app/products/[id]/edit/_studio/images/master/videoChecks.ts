/**
 * PES.7 — what a channel will accept of a product video. Pure, no I/O.
 *
 * The thresholds are the strictest across the channels Nexus publishes to, so one pass covers all
 * three: container per Amazon A+/eBay/Shopify, ≥ 1280×720, 16:9 within tolerance, ≤ 5 minutes,
 * ≤ 150 MB (eBay's Vault ceiling, the lowest of the three).
 *
 * 🔴 A check whose input is missing returns `unknown`, never `pass`. Dimensions and duration are
 * NULL on rows uploaded before the metadata backfill, and reporting those as green would tell the
 * operator a video had been checked against a resolution nobody measured
 * (feedback_100_percent_honest_ui). The UI renders the three states differently.
 */

export interface VideoMeta {
  width?: number | null
  height?: number | null
  durationSec?: number | null
  mimeType?: string | null
  fileSize?: number | null
}

export type CheckState = 'pass' | 'warn' | 'fail' | 'unknown'

export interface VideoCheck {
  id: 'container' | 'resolution' | 'aspect' | 'duration' | 'weight'
  state: CheckState
  /** One sentence, operator-facing. On `unknown` it says what is missing, not what is wrong. */
  message: string
}

/** Containers the three channels accept. Anything else is a hard fail, not a warning. */
const ALLOWED_MIME = ['video/mp4', 'video/quicktime', 'video/webm']
const MIN_WIDTH = 1280
const MIN_HEIGHT = 720
const MAX_DURATION_SEC = 300
/** eBay's Vault ceiling — the lowest of the three, so it is the one that binds. */
const MAX_BYTES = 150 * 1024 * 1024
/** 16:9, with room for the rounding a real encoder produces. */
const ASPECT_TOLERANCE = 0.15

/**
 * Bytes at a scale that stays truthful.
 *
 * Fixing this to MB printed a 71 KB clip as "0 MB", which reads as an empty or broken file rather
 * than a small one. The unit follows the number.
 */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${Math.round(n / 1024)} KB`
  const mb = n / 1048576
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

export function checkVideo(m: VideoMeta): VideoCheck[] {
  const out: VideoCheck[] = []

  out.push(
    m.mimeType == null
      ? { id: 'container', state: 'unknown', message: 'Container not recorded' }
      : ALLOWED_MIME.includes(m.mimeType)
        ? { id: 'container', state: 'pass', message: m.mimeType.replace('video/', '').toUpperCase() }
        : { id: 'container', state: 'fail', message: `${m.mimeType} may be rejected — use MP4, MOV or WebM` },
  )

  // Width and height are one fact: half of it is not enough to judge either check.
  if (m.width == null || m.height == null || m.width <= 0 || m.height <= 0) {
    out.push({ id: 'resolution', state: 'unknown', message: 'Dimensions not recorded' })
    out.push({ id: 'aspect', state: 'unknown', message: 'Dimensions not recorded' })
  } else {
    out.push(
      m.width < MIN_WIDTH || m.height < MIN_HEIGHT
        ? { id: 'resolution', state: 'warn', message: `${m.width}×${m.height} — channels prefer at least ${MIN_WIDTH}×${MIN_HEIGHT}` }
        : { id: 'resolution', state: 'pass', message: `${m.width}×${m.height}` },
    )
    const ratio = m.width / m.height
    out.push(
      Math.abs(ratio - 16 / 9) > ASPECT_TOLERANCE
        ? { id: 'aspect', state: 'warn', message: `${ratio.toFixed(2)}:1 is not 16:9 — channels may letterbox it` }
        : { id: 'aspect', state: 'pass', message: '16:9' },
    )
  }

  out.push(
    m.durationSec == null || m.durationSec <= 0
      ? { id: 'duration', state: 'unknown', message: 'Duration not recorded' }
      : m.durationSec > MAX_DURATION_SEC
        ? { id: 'duration', state: 'warn', message: `${Math.round(m.durationSec)}s — keep under ${MAX_DURATION_SEC}s for most channels` }
        : { id: 'duration', state: 'pass', message: `${Math.round(m.durationSec)}s` },
  )

  out.push(
    m.fileSize == null || m.fileSize <= 0
      ? { id: 'weight', state: 'unknown', message: 'File size not recorded' }
      : m.fileSize > MAX_BYTES
        ? { id: 'weight', state: 'warn', message: `${bytes(m.fileSize)} — eBay caps video at ${bytes(MAX_BYTES)}` }
        : { id: 'weight', state: 'pass', message: bytes(m.fileSize) },
  )

  return out
}

/** The worst state present, for a tile's single summary mark. `unknown` never outranks a real problem. */
export function worstState(checks: VideoCheck[]): CheckState {
  if (checks.some((c) => c.state === 'fail')) return 'fail'
  if (checks.some((c) => c.state === 'warn')) return 'warn'
  if (checks.some((c) => c.state === 'unknown')) return 'unknown'
  return 'pass'
}
