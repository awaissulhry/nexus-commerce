'use client'

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { cn } from '@/lib/utils'

/**
 * Imperative edit handlers registered by each EditableCell under its
 * `${rowId}:${columnId}` key.
 *
 *   enterEdit(prefill?)
 *     - undefined    → Step 3.5 keyboard / dblclick path. Open the
 *                      input with the existing value selected.
 *     - any string   → type-to-replace; the typed character becomes
 *                      the new draft, cursor sits at end.
 *
 *   applyValue(value)
 *     - Step 4 paste path. Sets the cell's local draftValue without
 *       opening edit mode, so the cell renders the pasted value with
 *       the dirty (yellow) tint immediately. The parent is responsible
 *       for also writing the change into the changesMap.
 */
export interface EditHandle {
  enterEdit: (prefill?: string) => void
  applyValue: (value: unknown) => void
}
export const editHandlers: Map<string, EditHandle> = new Map()
export function editKey(rowId: string, columnId: string) {
  return `${rowId}:${columnId}`
}

/**
 * Cell editor type system. The bulk-ops audit (2026-05-09) flagged
 * EditableCell as supporting only 3 of Airtable's 16 cell types;
 * Wave 2 expands this union one type per commit. All rendering
 * branches off `meta.fieldType`.
 */
export type FieldType =
  | 'text'
  | 'number'
  | 'select'
  /**
   * W2.1 — boolean toggle. Display shows ✓ / ✗; edit mode renders a
   * checkbox. Coerces 'true'/'false'/'1'/'0' on paste.
   */
  | 'boolean'
  /**
   * W2.2 — currency. Like 'number' but the meta carries an ISO 4217
   * currency code (EUR / USD / GBP …) which the cell uses to format
   * the value in the operator's locale. Also accepts a free-form
   * `currency` override per row when the column itself is multi-
   * currency (Xavia sells across IT/DE/FR/UK/US so several pricing
   * fields hold different currencies per channel).
   */
  | 'currency'
  /**
   * W2.3 — date (yyyy-mm-dd, no time). Edit mode renders an
   * <input type="date">; display formats via Intl.DateTimeFormat in
   * meta.locale (default it-IT → "9 mag 2026"). The data flows as
   * an ISO 8601 date string ('2026-05-09') in/out of the changesMap,
   * keeping clipboard roundtrips clean.
   */
  | 'date'
  /**
   * W2.3 — datetime. Edit mode renders an <input type="datetime-local">;
   * display formats with both date + time in the operator's locale.
   * Data flows as ISO 8601 ('2026-05-09T14:30:00').
   */
  | 'datetime'
  /**
   * W2.4 — URL. Edit mode is a plain text input with type="url" so
   * mobile keyboards surface the right glyphs; display renders an
   * <a> with the hostname trimmed for legibility (full URL on hover).
   * Paste validates basic shape ('http(s)://…' or naked domain).
   */
  | 'url'
  /**
   * W2.4 — email. type="email" + RFC-5322-lite validation (good
   * enough for the catalog: vendor / supplier / contact emails). The
   * display is the address itself with a mailto: anchor.
   */
  | 'email'
  /**
   * W2.4 — phone. type="tel" + light E.164 normalisation. Display
   * renders the number with non-breaking spaces between groups so
   * the cell stays single-line at common widths.
   */
  | 'phone'
  /**
   * W2.5 — color. Edit mode renders <input type="color"> alongside
   * a hex text input so operators can paste #RRGGBB or pick from
   * the OS picker. Display shows a swatch + hex code. Stored as
   * lowercase '#rrggbb'.
   */
  | 'color'
  /**
   * W2.6 — multi-select. Stores a string[]; display renders chips;
   * edit pops a checkbox list of meta.options. Paste accepts a
   * comma-separated list and validates each entry against options
   * (when provided). Use cases: per-product channel list,
   * categories, marketplace tags.
   */
  | 'multiSelect'
  /**
   * W2.7 — image. Stores an image URL; display renders a 32×32
   * thumbnail + the URL; edit reveals the URL as a text input. The
   * thumbnail's onError handler downgrades to a broken-image
   * placeholder so a 404'd CDN doesn't blank the cell.
   */
  | 'image'

export interface EditableMeta {
  editable: true
  fieldType: FieldType
  options?: string[]
  numeric?: boolean
  prefix?: string
  parse?: (raw: string) => unknown
  format?: (v: unknown) => string
  /**
   * W2.2 — ISO 4217 code applied to fieldType='currency'. When unset
   * the cell falls back to EUR (Xavia's home currency) so a column
   * with no explicit currency still renders sensibly.
   */
  currency?: string
  /**
   * W2.2 — locale used for Intl.NumberFormat. Defaults to 'it-IT' so
   * Awa sees thousand separators / decimal commas the way the rest
   * of the app does.
   */
  locale?: string
}

/**
 * W2.2 — format a numeric value as a currency string in the operator's
 * locale. Falls back to EUR + it-IT (Xavia's home market) when the
 * meta doesn't provide overrides. Empty / non-numeric inputs render
 * as the empty-state dash (handled by the caller — this returns the
 * empty string).
 */
export function formatCurrency(
  value: unknown,
  currency: string = 'EUR',
  locale: string = 'it-IT',
): string {
  if (value === null || value === undefined || value === '') return ''
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? parseFloat(value)
        : NaN
  if (!Number.isFinite(n)) return ''
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    // Unknown ISO currency or runtime missing locale data — degrade
    // gracefully so a typo'd code never blanks the cell.
    return `${currency} ${n.toFixed(2)}`
  }
}

/**
 * W2.3 — coerce a date-ish input into the canonical YYYY-MM-DD wire
 * format used by the date cell type. Accepts:
 *   - already-canonical 'YYYY-MM-DD'
 *   - full ISO 8601 ('2026-05-09T14:30:00.000Z') — date portion wins
 *   - Date instance
 *   - common European display forms 'dd/mm/yyyy' / 'dd.mm.yyyy'
 * Returns null for unparseable input.
 */
export function coerceDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  // Read LOCAL components — not toISOString — so a Date constructed
  // from a date-only string at local midnight ('2026-05-09T00:00:00')
  // doesn't shift back a day when the operator is east of UTC. Awa's
  // CEST timezone made this surface immediately during W2.3 verify.
  const pad = (n: number) => String(n).padStart(2, '0')
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  }
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
    // dd/mm/yyyy or dd.mm.yyyy (Italian / German operator habit)
    const eu = trimmed.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/)
    if (eu) {
      const [, dd, mm, yyyy] = eu
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
    }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) {
      const d = new Date(parsed)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
  }
  return null
}

/**
 * W2.3 — coerce a datetime-ish input to the canonical ISO 8601 form
 * the datetime cell type writes back. Same input shapes as
 * coerceDate plus the time portion. The output uses local time
 * minutes precision ('YYYY-MM-DDTHH:MM') because that matches what
 * <input type="datetime-local"> emits.
 */
export function coerceDateTime(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    // Local-time datetime-local format
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(v.getHours())}:${pad(v.getMinutes())}`
  }
  if (typeof v === 'string') {
    const trimmed = v.trim()
    // datetime-local already correct
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) return trimmed
    // Full ISO with seconds / Z — strip seconds + zone for local form
    const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
    if (iso) return `${iso[1]}T${iso[2]}`
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) return coerceDateTime(new Date(parsed))
  }
  return null
}

/**
 * W2.3 — render a date string in the operator's locale. Locale
 * defaults to 'it-IT'. Empty / unparseable inputs return ''.
 */
export function formatDate(value: unknown, locale: string = 'it-IT'): string {
  const iso = coerceDate(value)
  if (!iso) return ''
  // Date-only ISO: append T00:00 so the JS Date parser doesn't drift
  // into UTC and shift the displayed day.
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(d)
  } catch {
    return iso
  }
}

/** W2.3 — render a datetime in the operator's locale. */
export function formatDateTime(
  value: unknown,
  locale: string = 'it-IT',
): string {
  const iso = coerceDateTime(value)
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d)
  } catch {
    return iso
  }
}

/**
 * W2.6 — coerce arbitrary input to a string[] for the multiSelect
 * cell. Accepts: actual arrays, JSON-string arrays, comma /
 * semicolon / pipe separated strings. Trims + de-dupes. Returns []
 * for empty / null. Order preserved from the source.
 */
export function coerceMultiSelect(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return []
  if (Array.isArray(v)) {
    return Array.from(
      new Set(v.map((x) => String(x).trim()).filter((x) => x.length > 0)),
    )
  }
  const s = String(v).trim()
  if (!s) return []
  // JSON array literal
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return coerceMultiSelect(parsed)
    } catch {
      // fall through to delimiter parsing
    }
  }
  // Common operator delimiters
  const parts = s.split(/[,;|]/).map((x) => x.trim()).filter((x) => x.length > 0)
  return Array.from(new Set(parts))
}

/**
 * W2.5 — coerce arbitrary input to a canonical lowercase '#rrggbb'.
 * Accepts:
 *   - '#abc' / 'abc'      → expanded to '#aabbcc'
 *   - '#aabbcc' / 'aabbcc'
 *   - 'rgb(170, 187, 204)' / 'rgb(170 187 204)'
 *   - CSS named colors (a small allowlist for common ones)
 * Returns null when nothing matches.
 */
const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
}

export function coerceColor(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim().toLowerCase()
  if (!s) return null
  // #rrggbb / rrggbb
  const long = s.match(/^#?([0-9a-f]{6})$/)
  if (long) return `#${long[1]}`
  // #rgb / rgb (3-digit shorthand)
  const short = s.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/)
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  }
  // rgb(r,g,b) / rgb(r g b)
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/)
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((x) =>
      Math.max(0, Math.min(255, parseInt(x, 10))),
    )
    const hex = (n: number) => n.toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
  }
  if (NAMED_COLORS[s]) return NAMED_COLORS[s]
  return null
}

// W2.4 — URL / email / phone validators. Deliberately permissive —
// the bulk-ops grid is a power-user surface; we surface a clear
// error in the paste-preview modal but let an editing operator
// commit anything they type (they can fix it before save). Strict
// validation lives at the API boundary.

/**
 * Returns the URL string normalised to include a protocol when one
 * was missing, or null when the input doesn't look like a URL at
 * all. Accepts naked domains ('xavia.it') as 'https://xavia.it'.
 */
export function coerceUrl(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  try {
    // URL constructor needs a scheme — try as-is first, then with
    // an https:// prefix, so 'xavia.it' and 'http://x.io' both work.
    const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
      ? new URL(s)
      : new URL(`https://${s}`)
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Returns the trimmed email when it parses, otherwise null. */
export function coerceEmail(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  return EMAIL_RE.test(s) ? s : null
}

/**
 * Light E.164 normalisation: strip spaces / dashes / parens, keep a
 * leading '+'. Doesn't validate country codes — wholesale phone-
 * library work belongs at the API boundary, not in the grid cell.
 */
export function coercePhone(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const cleaned = s.replace(/[\s().-]/g, '')
  // Must be all digits (after optional leading +) and length-feasible
  if (!/^\+?\d{4,15}$/.test(cleaned)) return null
  return cleaned
}

/**
 * Coerce arbitrary input (string from paste, value from initialValue,
 * etc.) into a real boolean for the boolean cell type. Falsy strings
 * ('', '0', 'false', 'no', 'off') → false; everything else truthy is
 * true. null / undefined → null (cell shows the empty-state dash).
 */
export function coerceBoolean(v: unknown): boolean | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on')
    return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === 'off')
    return false
  // Anything else falls back to truthiness of the string itself.
  return s.length > 0
}

interface Props {
  rowId: string
  columnId: string
  /** Canonical server value. When the parent updates products[] (after
   * a successful save), this prop changes and the memo comparator
   * triggers a re-render — only for cells whose value actually changed. */
  initialValue: unknown
  meta: EditableMeta
  onCommit: (rowId: string, columnId: string, value: unknown) => void
  /** Set when a backend save rejected this specific cell. undefined for
   * the vast majority of cells; only failed cells re-render when this
   * map updates. */
  cellError?: string
  /** When this number changes, the cell resets its draftValue back to
   * initialValue. Used to revert pending edits that were rejected by a
   * higher-level flow (e.g., user cancelled the cascade choice modal).
   * Undefined means "no reset request"; treat as 0. */
  resetKey?: number
  /** True when this cell's pending change is a cascade. Drives the
   * orange-tinted background instead of yellow. */
  cellCascading?: boolean
  /** Step 3.5: pressing Enter / Tab / Shift+Tab inside the input
   * commits and asks the parent to move the selection by the given
   * delta (Excel semantics). */
  onCommitNavigate?: (dRow: number, dCol: number) => void
  /** P2 #5 — when a paste / fill targets a virtualised-out cell, the
   * parent has the change in its changes Map but the cell's local
   * draftValue can't be set (cell isn't mounted). On the next mount
   * (operator scrolls back into view), pass the pending value here
   * so the initial draftValue picks it up — yellow tint shows
   * immediately. Undefined when no pending change. */
  pendingValue?: unknown
}

const defaultFormat = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  return String(v)
}

const defaultParse = (raw: string, fieldType: FieldType): unknown => {
  if (fieldType === 'number') {
    if (raw === '' || raw === '-') return null
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  return raw
}

/**
 * Single editable cell.
 *
 * Performance contract:
 *   - Re-renders ONLY when (rowId, columnId, initialValue) actually
 *     changes. Custom memo comparator enforces this.
 *   - Local state owns only isEditing + draftValue. isDirty is DERIVED
 *     from `draftValue !== initialValue` — no separate state. When a
 *     successful save updates products[] in the parent, ONLY the cells
 *     whose value changed get a new initialValue prop (object identity
 *     stays for unchanged rows), so only those cells re-render. Yellow
 *     highlight clears automatically because draftValue and the new
 *     initialValue now match.
 *   - Commit reports the cell's current draftValue to the parent via
 *     onCommit; parent decides whether to add or remove the entry from
 *     its changesMap based on equality with the original.
 */
export const EditableCell = memo(
  function EditableCell({
    rowId,
    columnId,
    initialValue,
    meta,
    onCommit,
    cellError,
    resetKey,
    cellCascading,
    onCommitNavigate,
    pendingValue,
  }: Props) {
    const [isEditing, setIsEditing] = useState(false)
    // P2 #5 — seed draftValue from pendingValue when the cell is
    // mounting fresh and a paste already wrote a pending change for
    // it. Otherwise initialValue (canonical server value).
    const [draftValue, setDraftValue] = useState<unknown>(() =>
      pendingValue !== undefined ? pendingValue : initialValue,
    )
    const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null)

    // Derived, NOT tracked as state. When the parent updates products[]
    // after a save, the new initialValue flows in via props, the memo
    // comparator triggers a re-render, and isDirty naturally evaluates
    // to false (because draftValue now equals the new server value).
    const isDirty = !shallowEquals(draftValue, initialValue)

    // resetKey reset: parent bumped the counter to ask us to throw away
    // local state (e.g., cascade modal cancelled). Only fires when the
    // value actually changes — initial undefined → undefined is a no-op.
    useEffect(() => {
      if (resetKey === undefined) return
      setDraftValue(initialValue)
      setIsEditing(false)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey])

    // Step 3.5: enterEdit can be called with a prefill character.
    //   - undefined: opened via dblclick / F2 / Enter — keep current
    //     value, select-all so any next keystroke replaces it.
    //   - any string: opened via type-to-replace — start the draft at
    //     the typed character with the cursor at the end.
    const enterEdit = useCallback(
      (prefill?: string) => {
        if (prefill !== undefined) {
          setDraftValue(prefill)
        }
        setIsEditing(true)
        requestAnimationFrame(() => {
          const el = inputRef.current
          if (!el) return
          el.focus()
          if (prefill === undefined) {
            if ('select' in el && typeof el.select === 'function') {
              el.select()
            }
          } else if (
            'setSelectionRange' in el &&
            typeof (el as HTMLInputElement).setSelectionRange === 'function'
          ) {
            const len = prefill.length
            ;(el as HTMLInputElement).setSelectionRange(len, len)
          }
        })
      },
      [],
    )

    // Register/unregister the imperative edit handlers so the parent
    // can drive the cell from outside (keyboard nav, paste) without
    // re-rendering it on every selection change.
    useEffect(() => {
      const k = `${rowId}:${columnId}`
      const handle: EditHandle = {
        enterEdit,
        applyValue: (v) => setDraftValue(v),
      }
      editHandlers.set(k, handle)
      return () => {
        if (editHandlers.get(k) === handle) editHandlers.delete(k)
      }
    }, [rowId, columnId, enterEdit])

    const handleBlur = useCallback(() => {
      setIsEditing(false)
      // Always notify the parent — it'll add or remove from changesMap
      // based on whether draftValue equals the original. Parent has the
      // canonical comparison logic; cell just reports its current value.
      onCommit(rowId, columnId, draftValue)
    }, [draftValue, rowId, columnId, onCommit])

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          inputRef.current?.blur()
          // Excel: Enter in edit mode commits + moves down.
          onCommitNavigate?.(1, 0)
        } else if (e.key === 'Tab') {
          e.preventDefault()
          inputRef.current?.blur()
          // Tab moves right; Shift+Tab moves left.
          onCommitNavigate?.(0, e.shiftKey ? -1 : 1)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraftValue(initialValue)
          setIsEditing(false)
          // Don't commit; isDirty stays as it was before this edit
        }
      },
      [initialValue, onCommitNavigate]
    )

    if (isEditing) {
      const baseInputClass =
        'w-full h-full px-2 outline-none ring-2 ring-blue-500 bg-white text-md select-text'
      if (meta.fieldType === 'select') {
        return (
          <select
            ref={(el) => {
              inputRef.current = el
            }}
            value={String(draftValue ?? '')}
            onChange={(e) => setDraftValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={cn(baseInputClass, meta.numeric && 'tabular-nums text-right')}
          >
            {(meta.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        )
      }
      // W2.7 — image edit: URL text input. Future revision will add
      // an upload handler (Cloudinary / S3) but for now operators
      // paste an asset URL — same wire shape as everywhere else in
      // the catalog (Product.images stores URLs).
      if (meta.fieldType === 'image') {
        return (
          <input
            ref={(el) => {
              inputRef.current = el
            }}
            type="url"
            value={
              draftValue === null || draftValue === undefined
                ? ''
                : String(draftValue)
            }
            onChange={(e) => setDraftValue(e.target.value || null)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="https://cdn.xavia.it/..."
            className={baseInputClass}
          />
        )
      }
      // W2.6 — multiSelect edit: a popover-style checkbox list inside
      // the cell. Operators tick on/off; blur commits the array. When
      // meta.options isn't provided we fall back to a comma-separated
      // text input (so an unbounded tag column still works).
      if (meta.fieldType === 'multiSelect') {
        const selected = coerceMultiSelect(draftValue)
        if (meta.options && meta.options.length > 0) {
          return (
            <div
              ref={(el) => {
                inputRef.current = el as unknown as HTMLInputElement
              }}
              tabIndex={0}
              onBlur={handleBlur}
              onKeyDown={
                handleKeyDown as unknown as React.KeyboardEventHandler<HTMLDivElement>
              }
              className="absolute z-10 left-0 top-0 min-w-full bg-white ring-2 ring-blue-500 rounded-sm shadow-md max-h-48 overflow-auto p-1 outline-none"
            >
              {meta.options.map((opt) => {
                const checked = selected.includes(opt)
                return (
                  <label
                    key={opt}
                    className="flex items-center gap-2 px-2 py-1 text-md hover:bg-slate-50 cursor-pointer rounded"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? selected.filter((x) => x !== opt)
                          : [...selected, opt]
                        setDraftValue(next)
                      }}
                    />
                    <span className="truncate">{opt}</span>
                  </label>
                )
              })}
            </div>
          )
        }
        // Free-form fallback: comma-separated text editor.
        return (
          <input
            ref={(el) => {
              inputRef.current = el
            }}
            type="text"
            value={selected.join(', ')}
            onChange={(e) => setDraftValue(coerceMultiSelect(e.target.value))}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="tag, tag, tag"
            className={baseInputClass}
          />
        )
      }
      // W2.5 — color edit: native <input type="color"> + a parallel
      // hex text input so operators can either pick visually or paste
      // a hex value. Both are bound to draftValue; whichever changes
      // wins until blur.
      if (meta.fieldType === 'color') {
        const hex = coerceColor(draftValue) ?? '#000000'
        const rawText = draftValue === null || draftValue === undefined
          ? ''
          : String(draftValue)
        return (
          <div className="w-full h-full flex items-stretch bg-white ring-2 ring-blue-500">
            <input
              type="color"
              value={hex}
              onChange={(e) => setDraftValue(e.target.value.toLowerCase())}
              onBlur={handleBlur}
              className="w-7 border-r border-slate-200 cursor-pointer"
              aria-label="Pick color"
            />
            <input
              ref={(el) => {
                inputRef.current = el
              }}
              type="text"
              value={rawText}
              onChange={(e) => setDraftValue(e.target.value || null)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder="#rrggbb"
              className="flex-1 px-2 outline-none text-md tabular-nums"
            />
          </div>
        )
      }
      // W2.4 — URL / email / phone edit: plain text inputs with the
      // right `type` so mobile keyboards switch glyphs (.com key for
      // url, @ key for email, dial pad for phone). Validation is
      // deferred — operators can type freely and we re-check on
      // commit; the paste-preview modal already rejects garbage.
      if (
        meta.fieldType === 'url' ||
        meta.fieldType === 'email' ||
        meta.fieldType === 'phone'
      ) {
        const inputType =
          meta.fieldType === 'url'
            ? 'url'
            : meta.fieldType === 'email'
              ? 'email'
              : 'tel'
        return (
          <input
            ref={(el) => {
              inputRef.current = el
            }}
            type={inputType}
            value={
              draftValue === null || draftValue === undefined
                ? ''
                : String(draftValue)
            }
            onChange={(e) => setDraftValue(e.target.value || null)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={baseInputClass}
          />
        )
      }
      // W2.3 — date / datetime edit: native pickers. The browser's
      // own popover handles the calendar UI, locale, and keyboard
      // navigation; we just hand it the canonical wire value.
      if (meta.fieldType === 'date') {
        return (
          <input
            ref={(el) => {
              inputRef.current = el
            }}
            type="date"
            value={coerceDate(draftValue) ?? ''}
            onChange={(e) => setDraftValue(e.target.value || null)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={cn(baseInputClass, 'tabular-nums')}
          />
        )
      }
      if (meta.fieldType === 'datetime') {
        return (
          <input
            ref={(el) => {
              inputRef.current = el
            }}
            type="datetime-local"
            value={coerceDateTime(draftValue) ?? ''}
            onChange={(e) => setDraftValue(e.target.value || null)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={cn(baseInputClass, 'tabular-nums')}
          />
        )
      }
      // W2.2 — currency edit: numeric input on the data side, with the
      // currency code rendered as a non-editable chip on the left edge
      // so the operator never types the symbol. Commit / navigation /
      // escape semantics match the generic number path.
      if (meta.fieldType === 'currency') {
        const code = (meta.currency ?? 'EUR').toUpperCase()
        return (
          <div className="w-full h-full flex items-stretch bg-white ring-2 ring-blue-500">
            <span className="flex items-center px-2 text-xs uppercase tracking-wide text-slate-500 bg-slate-50 border-r border-slate-200">
              {code}
            </span>
            <input
              ref={(el) => {
                inputRef.current = el
              }}
              type="number"
              step="0.01"
              value={
                draftValue === null || draftValue === undefined
                  ? ''
                  : String(draftValue)
              }
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '' || raw === '-') {
                  setDraftValue(null)
                  return
                }
                const n = parseFloat(raw)
                setDraftValue(Number.isNaN(n) ? raw : n)
              }}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              className="flex-1 px-2 outline-none text-md tabular-nums text-right"
            />
          </div>
        )
      }
      // W2.1 — boolean edit: a single checkbox the operator clicks.
      // Enter / Tab commit + navigate (Excel semantics); Space toggles
      // when the input owns focus; Escape reverts. Render is wrapped
      // in a flex container so the checkbox sits visually centred and
      // the Excel-style ring still highlights the cell.
      if (meta.fieldType === 'boolean') {
        return (
          <div
            className={cn(
              'w-full h-full flex items-center justify-center bg-white ring-2 ring-blue-500',
            )}
          >
            <input
              ref={(el) => {
                inputRef.current = el as unknown as HTMLInputElement
              }}
              type="checkbox"
              checked={coerceBoolean(draftValue) === true}
              onChange={(e) => setDraftValue(e.target.checked)}
              onBlur={handleBlur}
              onKeyDown={
                handleKeyDown as unknown as React.KeyboardEventHandler<HTMLInputElement>
              }
              className="w-4 h-4 cursor-pointer"
              aria-label="Toggle"
            />
          </div>
        )
      }
      return (
        <input
          ref={(el) => {
            inputRef.current = el
          }}
          type={meta.fieldType === 'number' ? 'number' : 'text'}
          step={meta.fieldType === 'number' ? 'any' : undefined}
          value={
            draftValue === null || draftValue === undefined
              ? ''
              : String(draftValue)
          }
          onChange={(e) => {
            const parsed = meta.parse
              ? meta.parse(e.target.value)
              : defaultParse(e.target.value, meta.fieldType)
            setDraftValue(parsed)
          }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className={cn(baseInputClass, meta.numeric && 'tabular-nums text-right')}
        />
      )
    }

    // W2.7 — image display: 32×32 thumbnail + filename. Wrapped in a
    // small component so the broken-image state is local — the cell
    // itself doesn't need to track load failures across re-renders.
    if (meta.fieldType === 'image') {
      const url = draftValue === null || draftValue === undefined
        ? ''
        : String(draftValue)
      return (
        <div
          onDoubleClick={() => enterEdit()}
          title={cellError ?? url}
          className={cn(
            'w-full h-full px-2 flex items-center gap-2 text-md cursor-cell',
            isDirty && !cellError && !cellCascading && 'bg-yellow-50',
            isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
            cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          )}
        >
          {url ? (
            <ImageCellThumb url={url} />
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </div>
      )
    }

    // W2.6 — multiSelect display: chips of the selected values. The
    // chip count is capped to keep the cell single-line; overflow
    // shows '+N more' with a tooltip listing the rest.
    if (meta.fieldType === 'multiSelect') {
      const tags = coerceMultiSelect(draftValue)
      const VISIBLE = 3
      const visible = tags.slice(0, VISIBLE)
      const overflow = tags.length - visible.length
      return (
        <div
          onDoubleClick={() => enterEdit()}
          title={cellError ?? tags.join(', ')}
          className={cn(
            'w-full h-full px-2 flex items-center gap-1 text-md cursor-cell overflow-hidden',
            isDirty && !cellError && !cellCascading && 'bg-yellow-50',
            isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
            cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          )}
        >
          {tags.length === 0 ? (
            <span className="text-slate-300">—</span>
          ) : (
            <>
              {visible.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center max-w-[120px] truncate px-1.5 py-0.5 text-xs rounded bg-slate-100 text-slate-700 border border-slate-200"
                >
                  {tag}
                </span>
              ))}
              {overflow > 0 && (
                <span className="text-xs text-slate-500 flex-shrink-0">
                  +{overflow}
                </span>
              )}
            </>
          )}
        </div>
      )
    }

    // W2.5 — color display: 16×16 swatch + canonical hex. Invalid
    // raw values render with the amber tint so they're spotted.
    if (meta.fieldType === 'color') {
      const raw = draftValue === null || draftValue === undefined
        ? ''
        : String(draftValue)
      const normalised = coerceColor(raw)
      return (
        <div
          onDoubleClick={() => enterEdit()}
          title={cellError ?? raw}
          className={cn(
            'w-full h-full px-2 flex items-center gap-2 text-md cursor-cell',
            isDirty && !cellError && !cellCascading && 'bg-yellow-50',
            isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
            cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          )}
        >
          {normalised ? (
            <>
              <span
                className="w-4 h-4 rounded border border-slate-300 flex-shrink-0"
                style={{ backgroundColor: normalised }}
                aria-label={`Color swatch ${normalised}`}
              />
              <span className="truncate tabular-nums text-slate-700">
                {normalised}
              </span>
            </>
          ) : raw ? (
            <span className="truncate text-amber-700" title="Invalid color">
              {raw}
            </span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </div>
      )
    }

    // W2.4 — URL display: clickable anchor. Hostname is the visible
    // text (cleaner at common cell widths), the full href is the
    // tooltip. Click opens in a new tab to avoid losing grid state.
    if (meta.fieldType === 'url') {
      const raw = draftValue === null || draftValue === undefined ? '' : String(draftValue)
      const normalised = coerceUrl(raw)
      const display = normalised
        ? (() => {
            try {
              return new URL(normalised).hostname
            } catch {
              return normalised
            }
          })()
        : raw
      return (
        <div
          onDoubleClick={() => enterEdit()}
          title={cellError ?? normalised ?? raw}
          className={cn(
            'w-full h-full px-2 flex items-center text-md cursor-cell',
            isDirty && !cellError && !cellCascading && 'bg-yellow-50',
            isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
            cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          )}
        >
          {raw ? (
            normalised ? (
              <a
                href={normalised}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="truncate text-blue-600 hover:underline"
              >
                {display}
              </a>
            ) : (
              <span className="truncate text-amber-700" title="Invalid URL">
                {raw}
              </span>
            )
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </div>
      )
    }

    // W2.4 — email display: mailto: anchor when valid, plain text
    // (with amber tint as a soft signal) when not.
    if (meta.fieldType === 'email') {
      const raw = draftValue === null || draftValue === undefined ? '' : String(draftValue)
      const valid = coerceEmail(raw)
      return (
        <div
          onDoubleClick={() => enterEdit()}
          title={cellError ?? raw}
          className={cn(
            'w-full h-full px-2 flex items-center text-md cursor-cell',
            isDirty && !cellError && !cellCascading && 'bg-yellow-50',
            isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
            cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          )}
        >
          {raw ? (
            valid ? (
              <a
                href={`mailto:${valid}`}
                onClick={(e) => e.stopPropagation()}
                className="truncate text-blue-600 hover:underline"
              >
                {valid}
              </a>
            ) : (
              <span className="truncate text-amber-700" title="Invalid email">
                {raw}
              </span>
            )
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </div>
      )
    }

    // W2.4 — phone display: tel: anchor when normalisable.
    if (meta.fieldType === 'phone') {
      const raw = draftValue === null || draftValue === undefined ? '' : String(draftValue)
      const valid = coercePhone(raw)
      return (
        <div
          onDoubleClick={() => enterEdit()}
          title={cellError ?? raw}
          className={cn(
            'w-full h-full px-2 flex items-center text-md cursor-cell tabular-nums',
            isDirty && !cellError && !cellCascading && 'bg-yellow-50',
            isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
            cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          )}
        >
          {raw ? (
            valid ? (
              <a
                href={`tel:${valid}`}
                onClick={(e) => e.stopPropagation()}
                className="truncate text-blue-600 hover:underline"
              >
                {valid}
              </a>
            ) : (
              <span className="truncate text-amber-700" title="Invalid phone">
                {raw}
              </span>
            )
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </div>
      )
    }

    // W2.3 — date / datetime display: locale-formatted ('9 mag 2026',
    // '9 mag 2026, 14:30'). Empty values render as the standard dash.
    if (meta.fieldType === 'date' || meta.fieldType === 'datetime') {
      const formatted =
        meta.fieldType === 'date'
          ? formatDate(draftValue, meta.locale)
          : formatDateTime(draftValue, meta.locale)
      return (
        <div
          onDoubleClick={() => enterEdit()}
          title={cellError ?? (cellCascading && isDirty ? 'Will cascade to children' : undefined)}
          className={cn(
            'w-full h-full px-2 flex items-center text-md cursor-cell tabular-nums',
            isDirty && !cellError && !cellCascading && 'bg-yellow-50',
            isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
            cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          )}
        >
          {formatted ? (
            <span className="truncate">{formatted}</span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </div>
      )
    }

    // W2.2 — currency display: locale-formatted, right-aligned,
    // tabular numerics. Empty values render as the standard dash.
    if (meta.fieldType === 'currency') {
      const formatted = formatCurrency(draftValue, meta.currency, meta.locale)
      return (
        <div
          onDoubleClick={() => enterEdit()}
          title={cellError ?? (cellCascading && isDirty ? 'Will cascade to children' : undefined)}
          className={cn(
            'w-full h-full px-2 flex items-center justify-end text-md cursor-cell tabular-nums',
            isDirty && !cellError && !cellCascading && 'bg-yellow-50',
            isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
            cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          )}
        >
          {formatted ? (
            <span className="truncate">{formatted}</span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </div>
      )
    }

    // W2.1 — boolean display: ✓ / ✗ glyph, centred, click-or-dblclick
    // toggles into edit mode (operators expect a single click on a
    // checkbox to flip; pressing Space inside a focused checkbox
    // toggles natively). Falls through to the generic rendering for
    // every other type.
    if (meta.fieldType === 'boolean') {
      const b = coerceBoolean(draftValue)
      return (
        <div
          onDoubleClick={() => enterEdit()}
          onClick={() => enterEdit()}
          title={cellError ?? (cellCascading && isDirty ? 'Will cascade to children' : undefined)}
          className={cn(
            'w-full h-full px-2 flex items-center justify-center text-md cursor-pointer',
            isDirty && !cellError && !cellCascading && 'bg-yellow-50',
            isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
            cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          )}
        >
          {b === true ? (
            <span className="text-emerald-600 font-semibold" aria-label="True">✓</span>
          ) : b === false ? (
            <span className="text-slate-400 font-semibold" aria-label="False">✗</span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </div>
      )
    }

    const display = meta.format ? meta.format(draftValue) : defaultFormat(draftValue)

    return (
      <div
        // Step 3.5: single-click is selection-only (handled by the
        // wrapper above us). Double-click enters edit. The parent's
        // global keydown drives F2 / Enter / type-to-replace based on
        // the registered editHandlers entry above.
        onDoubleClick={() => enterEdit()}
        title={cellError ?? (cellCascading && isDirty ? 'Will cascade to children' : undefined)}
        className={cn(
          'w-full h-full px-2 flex items-center text-md cursor-cell',
          isDirty && !cellError && !cellCascading && 'bg-yellow-50',
          isDirty && !cellError && cellCascading && 'bg-orange-50 ring-1 ring-inset ring-orange-300',
          cellError && 'bg-red-50 ring-1 ring-inset ring-red-400',
          meta.numeric && 'tabular-nums justify-end'
        )}
      >
        {meta.prefix && display && <span className="text-slate-500 mr-1">{meta.prefix}</span>}
        <span className="truncate">{display || <span className="text-slate-300">—</span>}</span>
      </div>
    )
  },
  (prev, next) =>
    prev.rowId === next.rowId &&
    prev.columnId === next.columnId &&
    shallowEquals(prev.initialValue, next.initialValue) &&
    prev.meta === next.meta &&
    prev.onCommit === next.onCommit &&
    prev.cellError === next.cellError &&
    prev.resetKey === next.resetKey &&
    prev.cellCascading === next.cellCascading &&
    prev.onCommitNavigate === next.onCommitNavigate
)

function shallowEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  // Numbers: compare as numbers (handles 5 vs 5.0)
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}

/**
 * W2.7 — image-cell thumbnail with local broken-image fallback. Lives
 * outside EditableCell so its `failed` state is per-thumbnail, not
 * per-cell — keeps EditableCell's memo comparator honest (no extra
 * state slot to invalidate on every value change).
 */
function ImageCellThumb({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  // Reset the failed flag when the URL itself changes — operators
  // edit a 404'd path to a working one and expect the thumbnail to
  // come back without remounting the cell.
  useEffect(() => {
    setFailed(false)
  }, [url])
  const filename = (() => {
    try {
      return new URL(url).pathname.split('/').filter(Boolean).pop() ?? url
    } catch {
      return url
    }
  })()
  return (
    <>
      {failed ? (
        <span
          className="w-7 h-7 flex items-center justify-center rounded bg-slate-100 border border-slate-200 text-slate-400 text-[10px]"
          aria-label="Broken image"
          title="Broken image"
        >
          ⚠
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="w-7 h-7 object-cover rounded border border-slate-200 flex-shrink-0"
        />
      )}
      <span className="truncate text-xs text-slate-600">{filename}</span>
    </>
  )
}
