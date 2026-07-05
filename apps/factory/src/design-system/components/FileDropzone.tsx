'use client'

/**
 * FileDropzone — a generic file picker (drag-drop + click + keyboard). Validates type
 * (against the `accept` extension list) and size (`maxBytes`) client-side, then hands the
 * accepted File[] to `onFiles`; the caller owns the upload/parse transport. The non-image
 * sibling of ImageUpload — no preview, used for CSV/TSV/XLSX/JSON imports and the like.
 * Requires `styles/components.css`.
 */
import { useRef, useState, type ReactNode, type DragEvent, type KeyboardEvent } from 'react'
import { UploadCloud, AlertCircle } from 'lucide-react'

export interface FileDropzoneProps {
  /** Called with the validated files. */
  onFiles: (files: File[]) => void
  /** Comma-separated extension list (e.g. '.csv,.tsv,.xlsx,.xls,.json'). Empty = any. */
  accept?: string
  /** Client-side max size guard per file (bytes). */
  maxBytes?: number
  /** Allow selecting more than one file. */
  multiple?: boolean
  disabled?: boolean
  /** Secondary line — defaults to the accepted formats + size limit. */
  hint?: ReactNode
  className?: string
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

export function FileDropzone({ onFiles, accept = '', maxBytes, multiple = false, disabled = false, hint, className }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [err, setErr] = useState('')

  const exts = accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

  const matchesAccept = (file: File) => {
    if (!exts.length) return true
    const name = file.name.toLowerCase()
    return exts.some((ext) => (ext.startsWith('.') ? name.endsWith(ext) : file.type === ext))
  }

  const handle = (fileList: FileList | null | undefined) => {
    if (disabled) return
    setErr('')
    const files = Array.from(fileList ?? [])
    if (!files.length) return
    const picked = multiple ? files : files.slice(0, 1)
    for (const file of picked) {
      if (!matchesAccept(file)) {
        setErr(`Unsupported file — accepts ${exts.join(', ') || 'any type'}.`)
        return
      }
      if (maxBytes && file.size > maxBytes) {
        setErr(`"${file.name}" is too large — max ${fmtBytes(maxBytes)}.`)
        return
      }
    }
    onFiles(picked)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    handle(e.dataTransfer.files)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      inputRef.current?.click()
    }
  }

  const defaultHint = exts.length
    ? `${exts.join(', ')}${maxBytes ? ` · up to ${fmtBytes(maxBytes)}` : ''}`
    : maxBytes
    ? `Up to ${fmtBytes(maxBytes)}`
    : ''

  return (
    <div className={`h10-ds-dropzone-wrap${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={`h10-ds-dropzone ${drag ? 'drag' : ''}`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={onKeyDown}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        disabled={disabled}
      >
        <UploadCloud size={26} aria-hidden />
        <span className="h10-ds-dropzone-primary">Drag &amp; drop or click to upload</span>
        {(hint ?? defaultHint) && <span className="h10-ds-dropzone-hint">{hint ?? defaultHint}</span>}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept || undefined}
        multiple={multiple}
        disabled={disabled}
        className="h10-ds-dropzone-input"
        onChange={(e) => { handle(e.target.files); e.target.value = '' }}
      />
      {err && (
        <span className="h10-ds-dropzone-err" role="alert">
          <AlertCircle size={13} aria-hidden /> {err}
        </span>
      )}
    </div>
  )
}
