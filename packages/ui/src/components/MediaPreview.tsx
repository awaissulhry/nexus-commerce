'use client'

import { useEffect, useRef, useState } from 'react'
import { Box, File, Film, ImageOff, Music } from 'lucide-react'
import { Button } from '../primitives/Button'

export interface MediaSource { url: string; mimeType?: string }
export interface MediaCaption { url: string; language: string; label: string; default?: boolean }
export interface MediaPreviewProps {
  type: string
  url?: string | null
  poster?: string | null
  label: string
  sources?: readonly MediaSource[]
  captions?: readonly MediaCaption[]
  transcript?: string | null
}

/** Link and media URLs never accept executable protocols. Relative URLs support local assets. */
export function mediaUrl(value?: string | null): string | undefined {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return undefined
  try {
    const url = new URL(value, 'https://nexus.invalid')
    return ['https:', 'http:'].includes(url.protocol) ? value : undefined
  } catch { return undefined }
}

export function mediaTypeLabel(type: string): string {
  return ({ IMAGE: 'Image', VIDEO: 'Video', EXTERNAL_VIDEO: 'External video', MODEL_3D: '3D model', MODEL3D: '3D model', AUDIO: 'Audio', DOC: 'Document' } as Record<string, string>)[type] ?? 'File'
}

/** Image-only data URLs support existing catalog and local preview consumers. Never used for links. */
export function mediaImageUrl(value?: string | null): string | undefined {
  return value && /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i.test(value) ? value : mediaUrl(value)
}

export function MediaTypeIcon({ type, size = 20 }: { type: string; size?: number }) {
  const Icon = type === 'VIDEO' || type === 'EXTERNAL_VIDEO' ? Film : type === 'MODEL_3D' || type === 'MODEL3D' ? Box : type === 'AUDIO' ? Music : type === 'IMAGE' ? ImageOff : File
  return <Icon size={size} aria-hidden />
}

/** Original aspect ratio; playback starts only on request. Unknown formats retain a safe file link. */
export function MediaPreview(props: MediaPreviewProps) {
  // Remount on resource changes so a failed file never poisons the next preview or keeps playing.
  return <PreviewContent key={JSON.stringify([props.type, props.url, props.sources])} {...props} />
}

function PreviewContent({ type, url, poster, label, sources = [], captions = [], transcript }: MediaPreviewProps) {
  const [failed, setFailed] = useState(false)
  const [captionFailed, setCaptionFailed] = useState(false)
  const captionSignature = JSON.stringify(captions)
  useEffect(() => setCaptionFailed(false), [captionSignature])
  const original = mediaUrl(url)
  const imageSource = mediaImageUrl(url)
  const failedSources = useRef(new Set<string>())
  const playable = sources.filter(source => mediaUrl(source.url))
  const safeCaptions = captions.filter(caption => mediaUrl(caption.url))
  const file = type === 'VIDEO' || type === 'AUDIO'
  const available = !failed && ((file && (original || playable.length)) || (type === 'IMAGE' && imageSource))
  const sourceFailed = (source: string) => { failedSources.current.add(source); if (failedSources.current.size === playable.length) setFailed(true) }
  return <div className="nds-media-preview">
    <div className="nds-media-preview-stage">
      {available ? type === 'IMAGE' ? <img src={imageSource} alt={label} onError={() => setFailed(true)} />
        : type === 'AUDIO' ? <audio controls preload="metadata" aria-label={label} src={playable.length ? undefined : original} onError={() => setFailed(true)}>
          {playable.map(source => <source key={source.url} src={source.url} type={source.mimeType} onError={() => sourceFailed(source.url)} />)}
        </audio>
        : <video controls playsInline preload="metadata" crossOrigin={safeCaptions.length ? 'anonymous' : undefined} poster={mediaUrl(poster)} aria-label={label} src={playable.length ? undefined : original} onError={() => setFailed(true)}>
          {playable.map(source => <source key={source.url} src={source.url} type={source.mimeType} onError={() => sourceFailed(source.url)} />)}
          {safeCaptions.map((caption, index) => <track key={`${caption.language}:${caption.url}`} kind="captions" src={caption.url} srcLang={caption.language} label={caption.label} default={caption.default && !safeCaptions.slice(0, index).some(item => item.default)} onError={() => setCaptionFailed(true)} />)}
        </video>
        : <div className="nds-media-preview-fallback" role="status"><MediaTypeIcon type={type} size={32} /><p>{failed ? 'This file could not be previewed. Open the original to inspect it.' : type === 'EXTERNAL_VIDEO' ? 'Play this video on its hosting site.' : `An inline preview is unavailable for this ${mediaTypeLabel(type).toLowerCase()}.`}</p></div>}
    </div>
    {original && <div className="nds-media-preview-actions"><Button size="sm" asChild><a href={original} target="_blank" rel="noopener noreferrer">{type === 'EXTERNAL_VIDEO' ? 'Open video' : 'Open original'}</a></Button></div>}
    {captionFailed && <p role="status">Captions could not be loaded. Check the caption file, or use the transcript when available.</p>}
    {transcript && <details className="nds-media-preview-transcript"><summary>Transcript</summary><p>{transcript}</p></details>}
  </div>
}
