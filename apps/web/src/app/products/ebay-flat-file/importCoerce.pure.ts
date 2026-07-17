/**
 * EI.1 — typed coercion for eBay flat-file imports (pure, fully testable).
 *
 * Files carry everything as text. Every imported cell is coerced against its
 * target column's metadata (kind/options/enumMode/min/maxLength) BEFORE it
 * reaches the grid, and every judgement is surfaced as a per-cell issue —
 * nothing is silently dropped or silently kept. This is the layer whose
 * absence caused the shared-SKU "duplicate SKU" incident (text 'TRUE' flags).
 *
 * Rules by kind:
 *  • boolean  — TRUE/VERO/Sì/1/…→true, FALSE/0/NO/…→false, blank stays blank
 *  • number   — EU comma decimals, currency symbols/thousand-separators
 *               stripped; unparseable → ERROR (raw kept); `min` clamps up (WARN)
 *  • enum     — canonicalized case-insensitively against options AND
 *               optionLabels (so "New with tags" → NEW_WITH_TAGS and a policy
 *               NAME → its policy id); strict mode flags unknown values as
 *               ERROR (raw kept), open mode keeps free text silently;
 *               multiValue splits on commas and canonicalizes each part
 *  • text     — trimmed; maxLength overflow → WARN (never truncated — the
 *               operator decides)
 *  • readonly — passed through untouched (identity keys: Item ID, Status)
 *
 * Special: the literal serialization junk '[object Object]' (a known export
 * artifact) is dropped to blank with a WARN wherever it appears.
 */

import { truthyFlag } from './validateRows.shared'

export interface CoerceColumnMeta {
  id: string
  label?: string
  kind: 'text' | 'longtext' | 'number' | 'enum' | 'boolean' | 'readonly'
  options?: string[]
  optionLabels?: Record<string, string>
  enumMode?: 'open' | 'strict'
  multiValue?: boolean
  min?: number
  maxLength?: number
}

export interface CoerceIssue {
  rowIndex: number
  columnId: string
  level: 'error' | 'warn'
  message: string
  raw: string
}

export interface CoerceResult {
  rows: Record<string, unknown>[]
  issues: CoerceIssue[]
  /** columnId → issue count, for quick per-column badges. */
  issuesByColumn: Record<string, number>
}

const FALSY_RE = /^(false|falso|falsch|faux|no|n|0|off)$/i

/** '1.234,56 €' → 1234.56 ; '49.90' → 49.9 ; '1,299.00' → 1299 */
export function parseImportNumber(raw: string): number | null {
  let s = raw.replace(/[€$£\s]|EUR|GBP|USD/gi, '').trim()
  if (s === '') return null
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the LAST one is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.')
    else s = s.replace(/,/g, '')
  } else if (lastComma !== -1) {
    // Comma only: decimal when followed by 1-2 digits (EU price), else thousands.
    const frac = s.length - lastComma - 1
    s = frac >= 1 && frac <= 2 ? s.replace(',', '.') : s.replace(/,/g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Case-insensitive canonical option for a value, matching options AND labels. */
function canonicalizeEnum(raw: string, col: CoerceColumnMeta): string | null {
  const needle = raw.trim().toLowerCase()
  if (needle === '') return ''
  for (const opt of col.options ?? []) {
    if (opt.toLowerCase() === needle) return opt
  }
  for (const [value, label] of Object.entries(col.optionLabels ?? {})) {
    if (label.toLowerCase() === needle) return value
  }
  return null
}

export function coerceEbayImportRows(
  rawRows: Record<string, unknown>[],
  columns: CoerceColumnMeta[],
): CoerceResult {
  const colById = new Map(columns.map((c) => [c.id, c]))
  const issues: CoerceIssue[] = []
  const issuesByColumn: Record<string, number> = {}
  const push = (i: CoerceIssue) => {
    issues.push(i)
    issuesByColumn[i.columnId] = (issuesByColumn[i.columnId] ?? 0) + 1
  }

  const rows = rawRows.map((src, rowIndex) => {
    const out: Record<string, unknown> = {}
    for (const [key, rawVal] of Object.entries(src)) {
      const col = colById.get(key)
      // Unknown target (internal fields etc.) — pass through untouched.
      if (!col) { out[key] = rawVal; continue }

      if (typeof rawVal !== 'string') { out[key] = rawVal; continue }
      const raw = rawVal.trim()

      if (raw === '[object Object]') {
        push({ rowIndex, columnId: key, level: 'warn', message: 'Serialization junk dropped (was "[object Object]")', raw })
        out[key] = ''
        continue
      }
      if (raw === '') { out[key] = ''; continue }

      switch (col.kind) {
        case 'boolean': {
          if (truthyFlag(raw)) out[key] = true
          else if (FALSY_RE.test(raw)) out[key] = false
          else {
            push({ rowIndex, columnId: key, level: 'error', message: `Not a yes/no value: "${raw}"`, raw })
            out[key] = raw
          }
          break
        }
        case 'number': {
          const n = parseImportNumber(raw)
          if (n == null) {
            push({ rowIndex, columnId: key, level: 'error', message: `Not a number: "${raw}"`, raw })
            out[key] = raw
            break
          }
          if (col.min != null && n < col.min) {
            push({ rowIndex, columnId: key, level: 'warn', message: `Below minimum ${col.min} — clamped`, raw })
            out[key] = col.min
          } else {
            out[key] = n
          }
          break
        }
        case 'enum': {
          const parts = col.multiValue ? raw.split(',').map((p) => p.trim()).filter(Boolean) : [raw]
          const outParts: string[] = []
          let failed = false
          for (const part of parts) {
            const canon = canonicalizeEnum(part, col)
            if (canon != null) {
              outParts.push(canon)
            } else if (col.enumMode === 'strict') {
              push({
                rowIndex, columnId: key, level: 'error', raw,
                message: `"${part}" is not an accepted value${col.options?.length ? ` (accepted: ${col.options.slice(0, 6).join(', ')}${col.options.length > 6 ? '…' : ''})` : ''}`,
              })
              failed = true
            } else {
              outParts.push(part) // open enum — free text is legitimate
            }
          }
          out[key] = failed ? raw : outParts.join(col.multiValue ? ',' : '')
          break
        }
        case 'text':
        case 'longtext': {
          if (col.maxLength != null && raw.length > col.maxLength) {
            push({ rowIndex, columnId: key, level: 'warn', message: `${raw.length} chars exceeds max ${col.maxLength} — will be rejected by eBay if pushed as-is`, raw })
          }
          out[key] = raw
          break
        }
        case 'readonly':
        default:
          out[key] = raw
      }
    }
    return out
  })

  return { rows, issues, issuesByColumn }
}
