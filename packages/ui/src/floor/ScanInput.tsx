'use client'

/**
 * ScanInput — the floor's scan field (gap G3, SCR-020, 021, 024, 089, 092–098): a hardware scanner first, the camera as
 * the fallback, always listening, and a "scanned" flash on every read. Promoted from the legacy
 * `apps/web/src/components/ui/BarcodeScanInput.tsx` (its wedge + Enter idea, its camera dedupe), rebuilt on the floor
 * density and with no hard-coded words.
 *
 *   <ScanInput label="Scansiona" scannedLabel={(c) => `Letto ${c}`} onScan={(code, source) => open(code)} />
 *
 * Always listening, without stealing focus from a keyboard user:
 *   - In the field: the field keeps the text; Enter or Tab ends it. A scanner's burst is a `wedge`, a person's typing is
 *     `typed`; `acceptTyped={false}` refuses typed codes (badge-only sign-in).
 *   - Anywhere else (focus on a tile, a button or nothing): a document listener reads scanner bursts (`scanWedge.ts`)
 *     and hands them to `onScan`; a person's single keys pass through, so Enter on a focused tile still presses it.
 *     Another text field, or an open dialog, keeps its own keys. The first character of a burst cannot be told from a
 *     person's key and reaches the focused element: a screen with a PIN pad clears it on a scan.
 *   - `keepFocus` (default true) focuses the field on mount and takes focus back when it drops to nothing.
 *   - No on-screen keyboard pops up over the screen: the field asks for none (`inputmode="none"`). `keyboardLabel` adds a
 *     button that opens it for typing a code by hand.
 *
 * Camera: injected, never bundled. The design system adds no dependency, so the app passes a `CameraScanner` (in Nexus
 * apps a few lines over `@zxing/browser`, loaded only when the camera opens — see the catalogue's `zxingCamera.ts`).
 * Repeat reads of one code within 1.5 s count once.
 *
 * Feedback: the field flashes green with a tick for every read (`flashMs`), and a polite live region says
 * `scannedLabel(code)`. Whether the code was RIGHT is the screen's to answer, with `confirmFeedback` (G8).
 */
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Camera, CameraOff, Check, Keyboard, ScanLine } from 'lucide-react'

import { FloorButton } from './FloorButton'
import { classifyBurst, createWedgeReader, isCameraRepeat, nextStamps, WEDGE_DEFAULTS, type ScanSource } from './scanWedge'
import './floor.css'

/** Reads codes from a camera into a `<video>`. The app supplies it (ZXing in Nexus); the design system draws the UI. */
export interface CameraScanner {
  /**
   * Start the camera into `video` and call `onCode` for every code read. Resolves to the function that stops it;
   * rejects when the camera cannot start (no permission, no camera).
   */
  start(video: HTMLVideoElement, onCode: (code: string) => void): Promise<() => void>
}

export interface ScanCamera {
  scanner: CameraScanner
  /** "Fotocamera" */
  startLabel: string
  /** "Chiudi fotocamera" */
  stopLabel: string
  /** "Fotocamera non disponibile" */
  errorLabel: string
}

export interface ScanInputProps {
  /** A code was read. `source`: a scanner (`wedge`), the camera, or typed by hand. */
  onScan: (code: string, source: ScanSource) => void
  /** The field's name ("Scansiona"). */
  label: string
  /** Keep the label for screen readers only. */
  hideLabel?: boolean
  placeholder?: string
  /** A line under the field ("Scansiona il cartellino del fascio"). */
  hint?: ReactNode
  /** What a screen reader hears after a read: (code) => "Letto BND-000417". */
  scannedLabel: (code: string) => string
  disabled?: boolean
  /** Focus the field on mount and take focus back when it drops to nothing. Default true. */
  keepFocus?: boolean
  /** Read scanner bursts while focus is elsewhere (not in another text field). Default true. */
  listenGlobally?: boolean
  /** Accept a code typed by a person. Default true; false for scan-only steps (badge sign-in). */
  acceptTyped?: boolean
  maxKeyGapMs?: number
  minLength?: number
  terminators?: readonly string[]
  /** How long the green "scanned" state shows, ms. Default 600. */
  flashMs?: number
  /** Words for a button that opens the on-screen keyboard ("Digita"). None: scan only. */
  keyboardLabel?: string
  /** The camera fallback. */
  camera?: ScanCamera
  id?: string
  className?: string
}

const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'])

/** Focus is in a field that types text of its own. */
function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && !NOT_TEXT.has((el as HTMLInputElement).type)
}

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export function ScanInput({
  onScan,
  label,
  hideLabel,
  placeholder,
  hint,
  scannedLabel,
  disabled = false,
  keepFocus = true,
  listenGlobally = true,
  acceptTyped = true,
  maxKeyGapMs = WEDGE_DEFAULTS.maxKeyGapMs,
  minLength = WEDGE_DEFAULTS.minLength,
  terminators = WEDGE_DEFAULTS.terminators,
  flashMs = 600,
  keyboardLabel,
  camera,
  id,
  className,
}: ScanInputProps) {
  const autoId = useId()
  const fieldId = id ?? `${autoId}-scan`
  const hintId = `${fieldId}-hint`
  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const valueRef = useRef('')
  const stamps = useRef<number[]>([])
  const [value, setValue] = useState('')
  const [flash, setFlash] = useState(false)
  const [announce, setAnnounce] = useState('')
  const [typing, setTyping] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [cameraFailed, setCameraFailed] = useState(false)
  const lastCamera = useRef<{ code: string; at: number } | null>(null)
  const timers = useRef<{ flash?: ReturnType<typeof setTimeout>; speak?: ReturnType<typeof setTimeout> }>({})
  const latest = useRef({ onScan, scannedLabel })
  latest.current = { onScan, scannedLabel }
  const terminatorKey = terminators.join('|')

  const focusField = useCallback(() => inputRef.current?.focus({ preventScroll: true }), [])

  const accept = useCallback(
    (code: string, source: ScanSource) => {
      latest.current.onScan(code, source)
      setFlash(true)
      // Clear, then speak: the same code read twice is announced twice.
      setAnnounce('')
      clearTimeout(timers.current.flash)
      clearTimeout(timers.current.speak)
      timers.current.flash = setTimeout(() => setFlash(false), flashMs)
      timers.current.speak = setTimeout(() => setAnnounce(latest.current.scannedLabel(code)), 30)
    },
    [flashMs],
  )

  useEffect(() => {
    const t = timers.current
    return () => {
      clearTimeout(t.flash)
      clearTimeout(t.speak)
    }
  }, [])

  const clearField = () => {
    valueRef.current = ''
    stamps.current = []
    setValue('')
  }

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value
    stamps.current = nextStamps(stamps.current, valueRef.current, next, e.nativeEvent.timeStamp || clock())
    valueRef.current = next
    setValue(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!terminators.includes(e.key)) return
    const code = valueRef.current.trim()
    if (code.length === 0) return
    e.preventDefault()
    const source: ScanSource = classifyBurst(stamps.current, maxKeyGapMs) === 'wedge' ? 'wedge' : 'typed'
    clearField()
    if (typing) setTyping(false)
    if (code.length < minLength || (source === 'typed' && !acceptTyped)) return
    accept(code, source)
  }

  // Focus on mount, and back whenever it drops to nothing (a tap on empty space, the window regaining focus).
  useEffect(() => {
    if (!keepFocus || disabled) return
    focusField()
    const onWindowFocus = () => {
      if (!document.activeElement || document.activeElement === document.body) focusField()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [keepFocus, disabled, focusField])

  const onBlur = () => {
    if (typing) setTyping(false)
    if (!keepFocus) return
    setTimeout(() => {
      const a = document.activeElement
      if (!a || a === document.body) focusField()
    }, 0)
  }

  // Scanner bursts while focus is elsewhere.
  useEffect(() => {
    if (!listenGlobally || disabled) return
    const reader = createWedgeReader({ maxKeyGapMs, minLength, terminators: terminatorKey.split('|') })
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const active = document.activeElement
      if (e.ctrlKey || e.metaKey || e.altKey || active === inputRef.current || isTextField(active) || active?.closest('[aria-modal="true"]')) {
        reader.reset()
        return
      }
      const step = reader.key(e.key, e.timeStamp || clock())
      if (step.kind === 'char' && step.burst) {
        e.preventDefault()
        e.stopPropagation()
      } else if (step.kind === 'scan') {
        e.preventDefault()
        e.stopPropagation()
        accept(step.code, 'wedge')
        if (keepFocus) focusField()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [listenGlobally, disabled, maxKeyGapMs, minLength, terminatorKey, accept, keepFocus, focusField])

  // The on-screen keyboard: open it for one code, then back to scan-only.
  useEffect(() => {
    if (typing) focusField()
  }, [typing, focusField])

  // Camera lifecycle: started when opened, stopped when closed or unmounted.
  const scanner = camera?.scanner
  useEffect(() => {
    if (!cameraOn || !scanner) return
    const video = videoRef.current
    if (!video) return
    let stop: (() => void) | null = null
    let cancelled = false
    scanner
      .start(video, (raw) => {
        const code = raw.trim()
        if (code.length < minLength) return
        const at = clock()
        if (isCameraRepeat(lastCamera.current, code, at)) return
        lastCamera.current = { code, at }
        accept(code, 'camera')
      })
      .then(
        (s) => {
          if (cancelled) s()
          else stop = s
        },
        () => {
          if (cancelled) return
          setCameraFailed(true)
          setCameraOn(false)
        },
      )
    return () => {
      cancelled = true
      stop?.()
    }
  }, [cameraOn, scanner, minLength, accept])

  const cls = ['nds-floor-scan', className ?? ''].filter(Boolean).join(' ')
  return (
    <div className={cls} data-camera={cameraOn ? 'on' : 'off'}>
      <label htmlFor={fieldId} className={hideLabel ? 'nds-floor-sr' : 'nds-floor-scan-label'}>
        {label}
      </label>
      <div className="nds-floor-scan-field" data-scanned={flash ? 'true' : 'false'} data-disabled={disabled ? 'true' : undefined}>
        <span className="nds-floor-icon nds-floor-scan-icon" aria-hidden>
          {flash ? <Check /> : <ScanLine />}
        </span>
        <input
          ref={inputRef}
          id={fieldId}
          className="nds-floor-scan-input"
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          inputMode={typing ? 'text' : 'none'}
          enterKeyHint="go"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={hint ? hintId : undefined}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
        {keyboardLabel && !disabled ? (
          <FloorButton
            size="sm"
            variant="quiet"
            icon={<Keyboard />}
            aria-pressed={typing}
            // Keep focus in the field: a blur would close the keyboard before this press toggles it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setTyping((v) => !v)}
          >
            {keyboardLabel}
          </FloorButton>
        ) : null}
        {camera && !disabled ? (
          <FloorButton
            size="sm"
            variant={cameraOn ? 'primary' : 'secondary'}
            icon={cameraOn ? <CameraOff /> : <Camera />}
            aria-pressed={cameraOn}
            onClick={() => {
              setCameraFailed(false)
              setCameraOn((v) => !v)
            }}
          >
            {cameraOn ? camera.stopLabel : camera.startLabel}
          </FloorButton>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="nds-floor-scan-hint">
          {hint}
        </p>
      ) : null}
      {camera && cameraOn ? (
        <div className="nds-floor-scan-camera">
          <video ref={videoRef} autoPlay playsInline muted />
          <span className="nds-floor-scan-aim" aria-hidden />
        </div>
      ) : null}
      {camera && cameraFailed ? (
        <p className="nds-floor-scan-error" role="alert">
          {camera.errorLabel}
        </p>
      ) : null}
      <span className="nds-floor-sr" aria-live="polite" aria-atomic="true">
        {announce}
      </span>
    </div>
  )
}
