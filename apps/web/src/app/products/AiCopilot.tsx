'use client'

/**
 * ACP.2b — products copilot drawer.
 *
 * A self-contained floating "Ask AI" widget that talks to the read-only
 * copilot (POST /api/agent/chat) with the current page context. Renders
 * the reply + a compact tool-trace line ("used: listing-health,
 * draft-seo"). Read-only — no apply buttons (that is Phase 3). Built to
 * be droppable on any page (Phase 7) via the `pageContext` prop.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, Send, X, Loader2, Wrench, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  toolsUsed?: string[]
}

export default function AiCopilot({
  pageContext,
}: {
  pageContext: { route: string; productId?: string }
}) {
  const backend = getBackendUrl()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loading])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return
    const next: ChatMsg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${backend}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          pageContext,
        }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok || !d?.ok) {
        setError(d?.error ?? 'The copilot hit an error.')
        return
      }
      setMessages([
        ...next,
        { role: 'assistant', content: d.reply ?? '', toolsUsed: d.toolsUsed ?? [] },
      ])
    } catch {
      setError('Could not reach the copilot.')
    } finally {
      setLoading(false)
    }
  }, [input, loading, messages, backend, pageContext])

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 h-12 px-4 rounded-full bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 shadow-lg inline-flex items-center gap-2 hover:opacity-90"
        >
          <Sparkles className="w-4 h-4" /> Ask AI
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Products copilot"
          className="fixed inset-y-0 right-0 z-50 w-full sm:w-[440px] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col"
        >
          <header className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-slate-700 dark:text-slate-300" />
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                Products copilot
              </span>
              <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded px-1.5 py-0.5">
                <ShieldCheck className="w-3 h-3" /> read-only
              </span>
            </div>
            <button
              type="button"
              aria-label="Close copilot"
              onClick={() => setOpen(false)}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X className="w-5 h-5" />
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-base text-slate-500 dark:text-slate-400">
                <p className="mb-2">
                  Ask about your catalog — I can read products, orders, stock,
                  pricing, and listing health, and draft content. I only
                  suggest; I never change anything.
                </p>
                <ul className="list-disc pl-5 space-y-1 text-sm">
                  <li>&ldquo;Which SKUs are missing images?&rdquo;</li>
                  <li>&ldquo;What&apos;s blocking GALE-JACKET from publishing?&rdquo;</li>
                  <li>&ldquo;Draft better bullets + SEO for SKU&nbsp;…&rdquo;</li>
                </ul>
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  'rounded-lg px-3 py-2 text-base',
                  m.role === 'user'
                    ? 'bg-slate-100 dark:bg-slate-800 ml-8'
                    : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 mr-2',
                )}
              >
                <div className="whitespace-pre-wrap break-words text-slate-800 dark:text-slate-200">
                  {m.content}
                </div>
                {m.role === 'assistant' && m.toolsUsed && m.toolsUsed.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-sm text-slate-400 dark:text-slate-500 inline-flex items-center gap-1.5 flex-wrap">
                    <Wrench className="w-3 h-3" />
                    used: {m.toolsUsed.join(' → ')}
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="inline-flex items-center gap-2 text-base text-slate-500 dark:text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> thinking + running
                tools…
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-200"
              >
                {error}
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 dark:border-slate-700 p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={2}
                placeholder="Ask about your catalog…"
                disabled={loading}
                className="flex-1 resize-none text-base border border-slate-200 dark:border-slate-700 rounded-md px-3 py-2 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={loading || !input.trim()}
                aria-label="Send"
                className="h-10 w-10 flex-shrink-0 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 inline-flex items-center justify-center disabled:opacity-40"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </button>
            </div>
            <p className="mt-1.5 text-sm text-slate-400 dark:text-slate-500">
              Read-only — suggestions only. High-stakes actions (pricing,
              publishing, messages) will need your approval.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
