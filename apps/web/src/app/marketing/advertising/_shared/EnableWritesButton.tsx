'use client'

/**
 * AD.4 — Two-step "Abilita scritture live" button.
 *
 * Step 1: POST /preview-writes → returns a confirmationToken + preview
 * with the consequences. Step 2: POST /enable-writes with the token.
 * Both steps surface confirmation in a modal so accidental clicks
 * don't flip a connection live.
 */

import { useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Preview {
  profileId: string
  marketplace: string
  accountLabel: string | null
  mode: string
  consequencesIfEnabled: string[]
}

export function EnableWritesButton({
  profileId,
  marketplace,
  onSuccess,
}: {
  profileId: string
  marketplace: string
  onSuccess?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ token: string; preview: Preview } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function startPreview() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/connection/preview-writes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId }),
        },
      )
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'preview_failed')
        return
      }
      setPreview({ token: json.confirmationToken, preview: json.preview })
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/connection/enable-writes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmationToken: preview.token }),
        },
      )
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'enable_failed')
        return
      }
      setPreview(null)
      if (onSuccess) onSuccess()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={startPreview}
        disabled={busy}
        className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs rounded ring-1 ring-inset ring-rose-300 bg-white text-rose-700 hover:bg-rose-50 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-800 disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
        Abilita scritture live ({marketplace})
      </button>

      {preview && (
        <div className="fixed inset-0 bg-slate-950/40 dark:bg-slate-950/70 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-900 rounded-md shadow-xl max-w-lg w-full p-4 border border-rose-300 dark:border-rose-800">
            <div className="text-sm font-medium text-rose-900 dark:text-rose-100 mb-2">
              Conferma: abilita scritture live per {preview.preview.marketplace}
            </div>
            <div className="text-xs text-slate-600 dark:text-slate-400 mb-2 space-y-1">
              <div>
                <span className="font-mono">{preview.preview.profileId}</span> ·{' '}
                {preview.preview.accountLabel ?? 'unlabeled'} ·{' '}
                <span className="text-rose-700 dark:text-rose-300">{preview.preview.mode}</span>
              </div>
            </div>
            <div className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed mb-3">
              <div className="font-medium mb-1">Conseguenze:</div>
              <ul className="list-disc pl-4 space-y-1">
                {preview.preview.consequencesIfEnabled.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
            {error && (
              <div className="text-xs text-rose-700 dark:text-rose-300 mb-2 p-2 bg-rose-50 dark:bg-rose-950/40 rounded">
                {error}
              </div>
            )}
            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => setPreview(null)}
                disabled={busy}
                className="px-3 py-1 text-sm rounded text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={busy}
                className="inline-flex items-center gap-1 px-3 py-1 text-sm rounded ring-1 ring-inset ring-rose-300 bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"
              >
                {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                Conferma live
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
