'use client'

/**
 * PIM B.1 — Technical attributes editor for the Global tab.
 *
 * Renders Product.categoryAttributes as a list of key/value rows
 * (material: Cowhide, armor: CE2). Operator can add, edit, remove.
 * Stateless: parent owns the map + onChange.
 *
 * Values are stored as JSON-stringified primitives in the input; on
 * blur we attempt to parse numbers / booleans so categoryAttributes
 * doesn't drift to all-string. Strings stay strings.
 */

import { useCallback, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { IconButton } from '@/components/ui/IconButton'

interface Props {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  onRemoveKey?: (key: string) => Promise<void> | void
}

/** Heuristic JSON-ish parse: "true"/"false"/numbers → typed; rest stay
 *  as plain strings. Keeps the JSONB tidier without forcing operators
 *  to wrap every value in quotes. */
function parseValue(input: string): unknown {
  const trimmed = input.trim()
  if (trimmed === '') return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  const n = Number(trimmed)
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(trimmed)) return n
  return input
}

function formatValue(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

export default function TechAttrsEditor({ value, onChange, onRemoveKey }: Props) {
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const entries = Object.entries(value)

  const updateKey = useCallback(
    (oldKey: string, nextKey: string) => {
      if (nextKey === oldKey || nextKey === '') return
      if (nextKey in value) return // refuse silent collisions
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        next[k === oldKey ? nextKey : k] = v
      }
      onChange(next)
    },
    [value, onChange],
  )

  const updateValue = useCallback(
    (key: string, nextRaw: string) => {
      onChange({ ...value, [key]: parseValue(nextRaw) })
    },
    [value, onChange],
  )

  const removeKey = useCallback(
    async (key: string) => {
      if (onRemoveKey) await onRemoveKey(key)
      const next = { ...value }
      delete next[key]
      onChange(next)
    },
    [value, onChange, onRemoveKey],
  )

  const addRow = useCallback(() => {
    const k = newKey.trim()
    if (k === '' || k in value) return
    onChange({ ...value, [k]: parseValue(newValue) })
    setNewKey('')
    setNewValue('')
  }, [newKey, newValue, value, onChange])

  return (
    <div className="flex flex-col gap-2">
      {entries.length === 0 ? (
        <div className="text-xs italic text-zinc-400 px-1">
          No technical attributes yet. Add one below.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-center gap-1.5">
              <Input
                defaultValue={k}
                onBlur={(e) => updateKey(k, e.target.value.trim())}
                className="w-48 font-mono text-xs"
                aria-label={`Key for ${k}`}
              />
              <Input
                defaultValue={formatValue(v)}
                onBlur={(e) => updateValue(k, e.target.value)}
                className="flex-1"
                aria-label={`Value for ${k}`}
              />
              <IconButton aria-label={`Remove ${k}`} onClick={() => void removeKey(k)} size="sm">
                <X className="w-3.5 h-3.5" />
              </IconButton>
            </div>
          ))}
        </div>
      )}

      {/* Add-row: key + value + plus button */}
      <div className="flex items-center gap-1.5 pt-2 border-t border-dashed border-zinc-200 dark:border-zinc-700">
        <Input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="key (e.g. material)"
          className="w-48 font-mono text-xs"
          aria-label="New attribute key"
        />
        <Input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="value (e.g. Cowhide)"
          className="flex-1"
          aria-label="New attribute value"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addRow()
            }
          }}
        />
        <IconButton aria-label="Add attribute" onClick={addRow} size="sm">
          <Plus className="w-3.5 h-3.5" />
        </IconButton>
      </div>
    </div>
  )
}
