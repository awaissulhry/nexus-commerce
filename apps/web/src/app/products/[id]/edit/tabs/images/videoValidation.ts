// MM.4 — pure video validation. Channel-agnostic warnings the media hub
// surfaces on each video tile, tuned for the marketplaces we publish to
// (Amazon A+, eBay, Shopify). Pure + unit-tested; no I/O.

export interface VideoMeta {
  width?: number | null
  height?: number | null
  durationSec?: number | null
  mimeType?: string | null
  fileSize?: number | null
}

export interface VideoWarning {
  level: 'warn' | 'error'
  message: string
}

const ALLOWED_MIME = ['video/mp4', 'video/quicktime', 'video/webm']
const MIN_WIDTH = 1280
const MIN_HEIGHT = 720
const MAX_DURATION_SEC = 300 // 5 min — most channels cap here or lower
const MAX_BYTES = 150 * 1024 * 1024 // 150 MB — eBay Vault ceiling (strictest)

export function validateVideo(m: VideoMeta): VideoWarning[] {
  const out: VideoWarning[] = []
  if (m.mimeType && !ALLOWED_MIME.includes(m.mimeType)) {
    out.push({ level: 'error', message: `Format ${m.mimeType} may be rejected — use MP4, MOV or WebM` })
  }
  if (m.width && m.height) {
    if (m.width < MIN_WIDTH || m.height < MIN_HEIGHT) {
      out.push({ level: 'warn', message: `Low resolution ${m.width}×${m.height} — channels prefer ≥ ${MIN_WIDTH}×${MIN_HEIGHT}` })
    }
    const ratio = m.width / m.height
    if (Math.abs(ratio - 16 / 9) > 0.15) {
      out.push({ level: 'warn', message: `Aspect ${ratio.toFixed(2)}:1 isn't 16:9 — may letterbox on channels` })
    }
  }
  if (m.durationSec && m.durationSec > MAX_DURATION_SEC) {
    out.push({ level: 'warn', message: `${Math.round(m.durationSec)}s is long — keep under ${MAX_DURATION_SEC}s for most channels` })
  }
  if (m.fileSize && m.fileSize > MAX_BYTES) {
    out.push({ level: 'warn', message: `${(m.fileSize / 1048576).toFixed(0)} MB is large — eBay caps video at 150 MB` })
  }
  return out
}
