'use client'

// O.14 — Barcode scan input. USB barcode scanners emit a fast
// sequence of keystrokes followed by Enter; this is just a text
// input with autoFocus + onSubmit on Enter, plus a small "scanned"
// flash to acknowledge successful reads. Mobile camera scanning is
// out of scope for this commit — separate engagement when we install
// @zxing/browser.
//
// Used by the pack station (O.13) for scan-to-verify SKU. Reusable
// for future pick-list scan-driven workflow.

import { useEffect, useRef, useState } from 'react'
import { ScanLine, Check } from 'lucide-react'
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
  className?: string
}

export function BarcodeScanInput({
  onScan,
  label = 'Scan',
  placeholder = 'Aim scanner here…',
  autoFocus = true,
  disabled = false,
  className,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [flashCheck, setFlashCheck] = useState(false)

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
    if (autoFocus) {
      inputRef.current?.focus()
      window.addEventListener('focus', onWindowFocus)
      return () => window.removeEventListener('focus', onWindowFocus)
    }
  }, [autoFocus])

  return (
    <label
      className={cn(
        'flex items-center gap-2 px-3 h-11 rounded border bg-white transition-colors',
        flashCheck ? 'border-emerald-400 bg-emerald-50' : 'border-slate-300 focus-within:border-blue-500',
        disabled && 'opacity-60 cursor-not-allowed',
        className,
      )}
    >
      {flashCheck ? <Check size={16} className="text-emerald-600" /> : <ScanLine size={16} className="text-slate-400" />}
      <span className="sr-only">{label}</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
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
      {/* Live region for screen-reader announcements on each scan. */}
      <span aria-live="polite" aria-atomic="true" className="sr-only">{announce}</span>
    </label>
  )
}
