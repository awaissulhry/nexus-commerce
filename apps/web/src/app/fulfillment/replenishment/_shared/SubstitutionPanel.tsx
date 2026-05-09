'use client'

/**
 * W9.6m — Substitution panel (R.17 origin).
 *
 * Extracted from ReplenishmentWorkspace.tsx. Shows raw vs adjusted
 * velocity and the list of products this SKU substitutes for (or
 * is substituted by), with inline fraction edit + add/delete.
 *
 * Adds dark-mode classes throughout (panel surface, role select,
 * SKU input, fraction input, add-form, list rows, delete button).
 */

import { useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import type { DetailResponse } from './types'

export function SubstitutionPanel({
  productId,
  rec,
  substitutions,
  onChanged,
}: {
  productId: string
  rec: DetailResponse['recommendation']
  substitutions: NonNullable<DetailResponse['substitutions']>
  onChanged: () => void | Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [newSku, setNewSku] = useState('')
  const [newRole, setNewRole] = useState<'PRIMARY' | 'SUBSTITUTE'>('PRIMARY')
  const [newFraction, setNewFraction] = useState('0.5')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const raw = rec?.rawVelocity != null ? Number(rec.rawVelocity) : null
  const delta =
    rec?.substitutionAdjustedDelta != null
      ? Number(rec.substitutionAdjustedDelta)
      : null
  const adjusted = raw != null && delta != null ? raw + delta : null

  async function handleAdd() {
    setBusy(true)
    setError(null)
    try {
      const fraction = Number(newFraction)
      if (!(fraction > 0 && fraction <= 1))
        throw new Error('fraction must be in (0, 1]')
      const otherSku = newSku.trim()
      if (!otherSku) throw new Error('SKU required')
      const body =
        newRole === 'PRIMARY'
          ? {
              primarySku: otherSku,
              substituteProductId: productId,
              substitutionFraction: fraction,
            }
          : {
              primaryProductId: productId,
              substituteSku: otherSku,
              substitutionFraction: fraction,
            }
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/substitutions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setNewSku('')
      setNewFraction('0.5')
      setAdding(false)
      await onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleUpdateFraction(id: string, fraction: number) {
    if (!(fraction > 0 && fraction <= 1)) return
    setBusy(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/substitutions/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ substitutionFraction: fraction }),
        },
      )
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    setBusy(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/substitutions/${id}`,
        { method: 'DELETE' },
      )
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Substitution-aware demand
        </h4>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          {adding ? 'cancel' : '+ link'}
        </button>
      </div>

      {raw != null && adjusted != null && (
        <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-slate-500 dark:text-slate-400">Raw velocity</div>
            <div className="font-mono text-slate-900 dark:text-slate-100">
              {raw.toFixed(2)}/d
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">Adjusted</div>
            <div className="font-mono text-slate-900 dark:text-slate-100">
              {adjusted.toFixed(2)}/d
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">Δ</div>
            <div
              className={`font-mono ${
                delta! > 0
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : delta! < 0
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              {delta! > 0 ? '+' : ''}
              {delta!.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {adding && (
        <div className="mb-3 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-2 text-xs">
          <div className="mb-2 grid grid-cols-3 gap-2">
            <select
              value={newRole}
              onChange={(e) =>
                setNewRole(e.target.value as 'PRIMARY' | 'SUBSTITUTE')
              }
              className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-1 py-0.5"
            >
              <option value="PRIMARY">Primary is…</option>
              <option value="SUBSTITUTE">Substitute is…</option>
            </select>
            <input
              type="text"
              placeholder="other SKU"
              value={newSku}
              onChange={(e) => setNewSku(e.target.value)}
              className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-1 py-0.5 font-mono"
            />
            <input
              type="number"
              step="0.05"
              min="0.05"
              max="1"
              value={newFraction}
              onChange={(e) => setNewFraction(e.target.value)}
              className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-1 py-0.5"
            />
          </div>
          {error && (
            <div className="mb-2 text-rose-600 dark:text-rose-400">{error}</div>
          )}
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={busy || !newSku.trim()}
            className="rounded bg-indigo-600 dark:bg-indigo-500 px-2 py-1 text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}

      {substitutions.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          No substitution links. Add one when stockouts on this SKU drive
          customers to a related product (or vice versa).
        </p>
      ) : (
        <ul className="space-y-1.5">
          {substitutions.map((s) => {
            const isSubstituteSide = s.substituteProductId === productId
            const other = isSubstituteSide ? s.primary : s.substitute
            return (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <div className="flex-1 truncate">
                  <span className="text-slate-500 dark:text-slate-400">
                    {isSubstituteSide ? 'substitutes for' : 'substituted by'}
                  </span>{' '}
                  <span className="font-mono text-slate-900 dark:text-slate-100">
                    {other?.sku ?? '(missing)'}
                  </span>{' '}
                  <span className="text-slate-400 dark:text-slate-500">
                    — {other?.name ?? ''}
                  </span>
                </div>
                <input
                  type="number"
                  step="0.05"
                  min="0.05"
                  max="1"
                  defaultValue={Number(s.substitutionFraction)}
                  onBlur={(e) => {
                    const v = Number(e.target.value)
                    if (v !== Number(s.substitutionFraction))
                      void handleUpdateFraction(s.id, v)
                  }}
                  className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-1 py-0.5 text-right font-mono"
                />
                <button
                  type="button"
                  onClick={() => void handleDelete(s.id)}
                  className="text-rose-600 dark:text-rose-400 hover:underline"
                >
                  delete
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
