'use client'

/**
 * RV.9.6 — End-to-end test mode panel.
 *
 * Three actions:
 *   1. Preview HTML — render the localized sentiment-check email in
 *      the dashboard so the operator can eyeball copy + layout per
 *      locale before exposing real customers.
 *   2. Send test email — fire a real Resend send to an operator-
 *      controlled address with /r/__test__/* URLs. No DB mutations.
 *   3. Dry tick — show what a real mailer tick *would* do right now
 *      without sending anything. Surfaces env-gate state too.
 */

import { Beaker, Mail, Eye, Activity } from 'lucide-react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { Listbox } from '@/design-system/components/Listbox'

type Locale = 'it' | 'de' | 'fr' | 'es' | 'en'

export function TestModeClient() {
  const [locale, setLocale] = useState<Locale>('it')
  const [productName, setProductName] = useState('Casco Xavia Carbon')
  const [recipient, setRecipient] = useState('')
  const [sending, setSending] = useState(false)
  const [tickBusy, setTickBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [tickResult, setTickResult] = useState<{
    wouldProcess: number
    breakdown: { dueScheduled: number; dueRetries: number }
    mailerPaused: boolean
    envEnabled: boolean
    outboundEnabled: boolean
  } | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  const sendTest = async () => {
    if (!recipient.trim()) {
      setResult('Enter a recipient email first')
      return
    }
    setSending(true)
    setResult(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/reviews/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send-test',
          recipient: recipient.trim(),
          locale,
          productName,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setResult(`Sent to ${recipient}${data.dryRun ? ' (dry-run — outbound disabled)' : ''}`)
      } else if (data.suppressed) {
        setResult(`Recipient is on the suppression list — ${data.error}`)
      } else {
        setResult(`Send failed: ${data.error ?? 'unknown'}`)
      }
    } catch (e: unknown) {
      setResult(`Error: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setSending(false)
    }
  }

  const dryTick = async () => {
    setTickBusy(true)
    setTickResult(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/reviews/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dry-tick' }),
      })
      const data = await res.json()
      setTickResult(data)
    } finally {
      setTickBusy(false)
    }
  }

  return (
    <section className="mb-6">
      <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-1.5">
        <Beaker className="h-4 w-4 text-purple-500" />
        Test mode — exercise the pipeline without touching real customers
      </h2>

      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
          {/* Locale + product */}
          <div className="md:col-span-3 grid grid-cols-2 gap-3 pb-3 border-b border-subtle dark:border-slate-800">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                Locale
              </label>
              <Listbox
                value={locale}
                onChange={(value) => setLocale(value as Locale)}
                options={[
                  { value: 'it', label: 'Italiano (IT)' },
                  { value: 'de', label: 'Deutsch (DE/AT)' },
                  { value: 'fr', label: 'Français (FR/BE)' },
                  { value: 'es', label: 'Español (ES)' },
                  { value: 'en', label: 'English (UK/IE/fallback)' },
                ]}
                ariaLabel="Locale"
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                Product name (placeholder)
              </label>
              <input
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                className="w-full text-sm border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded px-2 py-1"
              />
            </div>
          </div>

          {/* Action 1 — preview */}
          <div className="border border-default dark:border-slate-800 rounded p-3 flex flex-col">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              <Eye className="h-3.5 w-3.5" /> Preview email HTML
            </div>
            <div className="text-[11px] text-slate-500 mb-3 flex-1">
              Render the localized sentiment-check email in an iframe. No send, no DB.
            </div>
            <button
              onClick={() => setShowPreview((v) => !v)}
              className="h-8 px-3 text-xs font-medium bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded hover:bg-slate-300 dark:hover:bg-slate-700"
            >
              {showPreview ? 'Hide preview' : 'Show preview'}
            </button>
          </div>

          {/* Action 2 — send test */}
          <div className="border border-default dark:border-slate-800 rounded p-3 flex flex-col">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              <Mail className="h-3.5 w-3.5" /> Send test email
            </div>
            <div className="text-[11px] text-slate-500 mb-2 flex-1">
              Real Resend send to an operator address. Token is{' '}
              <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">__test__</code> so no
              DB rows are created.
            </div>
            <input
              type="email"
              placeholder="you@example.com"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="w-full text-sm border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded px-2 py-1 mb-2"
            />
            <button
              onClick={sendTest}
              disabled={sending}
              className="h-8 px-3 text-xs font-medium bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send test email'}
            </button>
            {result && <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-400">{result}</div>}
          </div>

          {/* Action 3 — dry tick */}
          <div className="border border-default dark:border-slate-800 rounded p-3 flex flex-col">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              <Activity className="h-3.5 w-3.5" /> Dry tick
            </div>
            <div className="text-[11px] text-slate-500 mb-2 flex-1">
              Show what a real mailer tick would process right now. No state change.
            </div>
            <button
              onClick={dryTick}
              disabled={tickBusy}
              className="h-8 px-3 text-xs font-medium bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-50"
            >
              {tickBusy ? 'Running…' : 'Run dry tick'}
            </button>
            {tickResult && (
              <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-400 space-y-0.5">
                <div>
                  Would process:{' '}
                  <strong className="text-slate-900 dark:text-slate-100">{tickResult.wouldProcess}</strong>
                  {' '}({tickResult.breakdown.dueScheduled} due, {tickResult.breakdown.dueRetries} retry)
                </div>
                <div>
                  Mailer paused:{' '}
                  <span className={tickResult.mailerPaused ? 'text-rose-600' : 'text-emerald-600'}>
                    {String(tickResult.mailerPaused)}
                  </span>
                </div>
                <div>
                  Ingest enabled:{' '}
                  <span className={tickResult.envEnabled ? 'text-emerald-600' : 'text-rose-600'}>
                    {String(tickResult.envEnabled)}
                  </span>
                </div>
                <div>
                  Outbound enabled:{' '}
                  <span className={tickResult.outboundEnabled ? 'text-emerald-600' : 'text-amber-600'}>
                    {String(tickResult.outboundEnabled)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {showPreview && (
          <div className="border-t border-default dark:border-slate-800 p-3">
            <iframe
              src={`/marketing/reviews/requests/test/preview?locale=${locale}&productName=${encodeURIComponent(productName)}`}
              className="w-full bg-white"
              style={{ height: '720px' }}
              title="Email preview"
            />
          </div>
        )}
      </div>
    </section>
  )
}
