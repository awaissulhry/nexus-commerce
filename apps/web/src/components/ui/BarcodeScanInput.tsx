'use client'

// O.14 — Barcode scan input. USB barcode scanners emit a fast
// sequence of keystrokes followed by Enter; this is just a text
// input with autoFocus + onSubmit on Enter, plus a small "scanned"
// flash to acknowledge successful reads.
//
// O.43 — Optional camera mode via @zxing/browser. Operator clicks
// the camera icon → grants permission → live video + decoded
// barcodes call onScan. Useful in warehouse-on-phone scenarios
// where there's no USB scanner. ZXing is loaded via dynamic import
// so its weight (a few hundred KB) only ships when camera mode is
// activated.
//
// Used by the pack station (O.13) for scan-to-verify SKU. Reusable
// for future pick-list scan-driven workflow.

import { useEffect, useRef, useState } from 'react'
import { ScanLine, Check, Camera, CameraOff } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  /** Called with the scanned text on Enter. Empty submissions ignored. */
  onScan: (value: string) => void
  /** Visible label. Defaults to a generic "Scan…" hint. */
  label?: string
  /** Placeholder text inside the input. */
  placeholder?: string
  /** Auto-focus on mount. Default true — pack station scanners
   *  immediately fire keystrokes; the page should be ready to receive. */
  autoFocus?: boolean
  /** Disable input (e.g. while a parent is processing). */
  disabled?: boolean
  /** Show the camera-mode toggle button. Default true. Set false on
   *  surfaces where camera mode is inappropriate (e.g. desktop-only
   *  flows). */
  enableCamera?: boolean
  className?: string
}

export function BarcodeScanInput({
  onScan,
  label = 'Scan',
  placeholder = 'Aim scanner here…',
  autoFocus = true,
  disabled = false,
  enableCamera = true,
  className,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [value, setValue] = useState('')
  const [flashCheck, setFlashCheck] = useState(false)
  const [cameraMode, setCameraMode] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  // Last raw scan + dedupe: ZXing fires multiple times per second on
  // a stable barcode in view. We only call onScan once until the
  // operator moves the camera off (changes to a different value).
  const lastScanRef = useRef<{ value: string; at: number } | null>(null)

  // Scanners typically emit a CR + Enter at end. We listen on
  // onKeyDown for Enter and fire onScan with the trimmed value.
  const [announce, setAnnounce] = useState<string>('')
  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    onScan(trimmed)
    setValue('')
    setFlashCheck(true)
    // Announce to screen readers so operators using assistive tech
    // get audible feedback on each scan (warehouse hardware often has
    // a beep, but that's separate from screen-reader output).
    setAnnounce(`Scanned ${trimmed}`)
    // Flash the green check for 600ms then return to default state.
    window.setTimeout(() => setFlashCheck(false), 600)
    // Re-focus so the next scan lands here without the operator
    // having to click — important for warehouse hardware where the
    // scanner is the only "keyboard" the operator touches.
    inputRef.current?.focus()
  }

  // Re-focus on click anywhere in the wrapper — picks up cases where
  // the operator accidentally tabs out.
  useEffect(() => {
    const onWindowFocus = () => inputRef.current?.focus()
    if (autoFocus && !cameraMode) {
      inputRef.current?.focus()
      window.addEventListener('focus', onWindowFocus)
      return () => window.removeEventListener('focus', onWindowFocus)
    }
  }, [autoFocus, cameraMode])

  // O.43: camera lifecycle. Dynamically import ZXing only when the
  // operator activates camera mode (saves ~300KB on every page that
  // doesn't use it).
  useEffect(() => {
    if (!cameraMode) return
    let stop: (() => void) | null = null
    let cancelled = false
    ;(async () => {
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        if (cancelled) return
        const reader = new BrowserMultiFormatReader()
        const video = videoRef.current
        if (!video) return
        // Prefer the rear camera on phones (warehouse use case).
        const constraints: MediaStreamConstraints = {
          video: { facingMode: { ideal: 'environment' } },
        }
        const controls = await reader.decodeFromConstraints(
          constraints,
          video,
          (result) => {
            if (!result) return
            const text = result.getText().trim()
            if (!text) return
            const last = lastScanRef.current
            if (last && last.value === text && Date.now() - last.at < 1500) {
              return // dedupe rapid re-fires
            }
            lastScanRef.current = { value: text, at: Date.now() }
            onScan(text)
            setFlashCheck(true)
            setAnnounce(`Scanned ${text}`)
            window.setTimeout(() => setFlashCheck(false), 600)
          },
        )
        stop = () => controls.stop()
      } catch (err: any) {
        if (cancelled) return
        setCameraError(err?.message ?? 'Camera unavailable')
        setCameraMode(false)
      }
    })()
    return () => {
      cancelled = true
      stop?.()
    }
  }, [cameraMode, onScan])

  return (
    <div className={cn('space-y-2', className)}>
      <label
        className={cn(
          'flex items-center gap-2 px-3 h-11 rounded border bg-white transition-colors',
          flashCheck ? 'border-emerald-400 bg-emerald-50' : 'border-slate-300 focus-within:border-blue-500',
          disabled && 'opacity-60 cursor-not-allowed',
        )}
      >
        {flashCheck ? <Check size={16} className="text-emerald-600" /> : <ScanLine size={16} className="text-slate-400" />}
        <span className="sr-only">{label}</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={disabled || cameraMode}
          autoFocus={autoFocus && !cameraMode}
          placeholder={cameraMode ? 'Camera scanning…' : placeholder}
          aria-label={label}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          className="flex-1 outline-none bg-transparent text-md font-mono tabular-nums placeholder:text-slate-400"
        />
        {enableCamera && (
          <button
            type="button"
            onClick={() => {
              setCameraError(null)
              setCameraMode((v) => !v)
            }}
            disabled={disabled}
            title={cameraMode ? 'Stop camera' : 'Scan with camera'}
            className={cn(
              'h-8 w-8 rounded inline-flex items-center justify-center transition-colors',
              cameraMode
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            {cameraMode ? <CameraOff size={14} /> : <Camera size={14} />}
          </button>
        )}
        {/* Live region for screen-reader announcements on each scan. */}
        <span aria-live="polite" aria-atomic="true" className="sr-only">{announce}</span>
      </label>
      {cameraMode && (
        <div className="relative rounded border border-slate-300 overflow-hidden bg-black">
          <video
            ref={videoRef}
            className="w-full max-h-72 object-cover"
            autoPlay
            playsInline
            muted
          />
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="border-2 border-blue-400/70 w-3/5 h-1/3 rounded shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]" />
          </div>
        </div>
      )}
      {cameraError && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-1.5">
          {cameraError}
        </div>
      )}
    </div>
  )
}
