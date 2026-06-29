'use client'

/**
 * ImageUpload — a reusable image dropzone (drag-drop + click) with live preview, a criteria
 * panel, client-side format/size/dimension validation, and a remove control. Platform-agnostic:
 * the caller supplies `onUpload(file) => Promise<url>` (wire it to your asset/DAM endpoint), so the
 * component owns the UX and validation but not the transport. Optional "Select from assets" hook
 * for a DAM browse. Used by the Sponsored Brand creative (logo + custom image) and reusable for
 * any image field (product images, A+ modules, etc.).
 */
import { useRef, useState } from 'react'
import { UploadCloud, X, ImageOff } from 'lucide-react'

export interface ImageUploadCriterion { label: string; value: string }
export interface ImageUploadProps {
  value: string | null
  onChange: (url: string | null) => void
  /** Upload transport — receives the validated File, resolves to the stored URL. */
  onUpload: (file: File) => Promise<string>
  label?: string
  criteria?: ImageUploadCriterion[]
  /** Comma-separated accept list (default PNG/JPG). */
  accept?: string
  /** Client-side max size guard (bytes). */
  maxBytes?: number
  /** Minimum pixel dimensions (the image must be at least this big). */
  minWidth?: number
  minHeight?: number
  /** CSS aspect-ratio for the preview/zone box (e.g. '1 / 1', '1200 / 628'). */
  aspect?: string
  /** Optional "Select from assets" action (DAM browse). */
  onSelectFromAssets?: () => void
  disabled?: boolean
  className?: string
}

const DEFAULT_ACCEPT = 'image/png,image/jpeg'

function readDimensions(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')) }
    img.src = url
  })
}

export function ImageUpload({ value, onChange, onUpload, label, criteria, accept = DEFAULT_ACCEPT, maxBytes, minWidth, minHeight, aspect = '1 / 1', onSelectFromAssets, disabled, className }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const [err, setErr] = useState('')

  const accepted = accept.split(',').map((s) => s.trim()).filter(Boolean)

  const handle = async (file: File | undefined) => {
    if (!file || disabled) return
    setErr('')
    if (accepted.length && !accepted.includes(file.type)) { setErr(`Unsupported format — use ${accepted.map((a) => a.replace('image/', '').toUpperCase()).join(' / ')}.`); return }
    if (maxBytes && file.size > maxBytes) { setErr(`File is too large — max ${(maxBytes / 1024 / 1024).toFixed(0)}MB.`); return }
    if (minWidth || minHeight) {
      try { const { w, h } = await readDimensions(file); if ((minWidth && w < minWidth) || (minHeight && h < minHeight)) { setErr(`Image must be at least ${minWidth ?? w}×${minHeight ?? h}px (got ${w}×${h}px).`); return } }
      catch { setErr('Could not read that image.'); return }
    }
    setBusy(true)
    try { const url = await onUpload(file); onChange(url) }
    catch (e) { setErr((e as Error).message || 'Upload failed.') }
    finally { setBusy(false) }
  }

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDrag(false); void handle(e.dataTransfer.files?.[0]) }

  return (
    <div className={`h10-ds-imgup${className ? ` ${className}` : ''}`}>
      {label && <span className="h10-ds-imgup-lbl">{label}</span>}
      <div className="h10-ds-imgup-row">
        {value ? (
          <div className="h10-ds-imgup-preview" style={{ aspectRatio: aspect }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt={label || 'Uploaded image'} />
            {!disabled && <button type="button" className="rm" onClick={() => { onChange(null); setErr('') }} aria-label="Remove image"><X size={14} /></button>}
          </div>
        ) : (
          <button
            type="button"
            className={`h10-ds-imgup-zone ${drag ? 'drag' : ''} ${busy ? 'busy' : ''}`}
            style={{ aspectRatio: aspect }}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); if (!disabled) setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            disabled={disabled}
            aria-label={label ? `Upload ${label}` : 'Upload image'}
          >
            {busy ? <span className="h10-ds-imgup-spin" aria-hidden /> : <UploadCloud size={22} aria-hidden />}
            <span className="t">{busy ? 'Uploading…' : 'Upload Image'}</span>
            {!busy && <span className="d">Drag &amp; drop or click</span>}
          </button>
        )}
        {criteria && criteria.length > 0 && (
          <div className="h10-ds-imgup-crit">
            <span className="h">Criteria</span>
            {criteria.map((c) => <span className="c" key={c.label}><b>{c.label}:</b> {c.value}</span>)}
          </div>
        )}
      </div>
      {!value && onSelectFromAssets && <button type="button" className="h10-ds-imgup-assets" onClick={onSelectFromAssets} disabled={disabled}>or Select from Assets</button>}
      {err && <span className="h10-ds-imgup-err"><ImageOff size={13} /> {err}</span>}
    </div>
  )
}
