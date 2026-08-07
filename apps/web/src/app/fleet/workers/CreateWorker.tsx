'use client'

/**
 * NAF.SB.W.8 — create a worker.
 *
 * Operator decision 2026-08-07: "create a worker" means a new INSTANCE of a
 * charter type that already exists in code — new name, scope, budget, cadence
 * and an appended instruction. Never a new capability.
 *
 * The UI's job is to make that limit legible rather than to apologise for it.
 * The review step is GENERATED from the template — "what it will never be able
 * to do" written by hand would be marketing; read off the template's own tool
 * list and evidence feeds, it is a fact.
 *
 * A drawer, not a route: Agentforce moved Testing Center out of Setup and into
 * the Studio precisely because a separate surface got ignored. Creating a
 * worker belongs beside the list of workers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Check, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Template {
  key: string
  name: string
  tier: string
  domain: string
  description: string | null
  autonomyCap: string
  observationKeys: string[]
  toolNames: string[]
  dailyBudgetUSD: number
  maxTokensPerRun: number
  maxFindingsPerRun: number
  diagnostic: boolean
}

/** name → a kebab-case key that is unmistakably an id. */
function slug(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function CreateWorker({ onCreated, onClose }: {
  onCreated: () => void
  onClose: () => void
}) {
  const backend = getBackendUrl()
  const [templates, setTemplates] = useState<Template[]>([])
  const [templateKey, setTemplateKey] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [key, setKey] = useState('')
  const [marketplace, setMarketplace] = useState('')
  const [budget, setBudget] = useState('')
  const [cadence, setCadence] = useState('')
  const [overlay, setOverlay] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void fetch(`${backend}/api/agent/fleet/worker-templates`, { cache: 'no-store' })
      .then(async (r) => { if (r.ok) setTemplates(((await r.json()) as { templates: Template[] }).templates) })
      .catch(() => setErr('Could not read the list of worker types.'))
  }, [backend])

  const t = useMemo(() => templates.find((x) => x.key === templateKey) ?? null, [templates, templateKey])

  // The key follows the name until the operator edits it themselves.
  useEffect(() => { if (!keyTouched) setKey(slug(name)) }, [name, keyTouched])

  const submit = useCallback(async () => {
    if (!t) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${backend}/api/agent/fleet/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          templateKey: t.key,
          key,
          name: name.trim(),
          scopeMarketplaces: marketplace ? [marketplace] : [],
          dailyBudgetUSD: budget ? Number(budget) : undefined,
          cadence: cadence.trim() || null,
          promptOverlay: overlay.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setErr(b.error ?? `create failed: ${res.status}`)
        return
      }
      onCreated()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [backend, t, key, name, marketplace, budget, cadence, overlay, onCreated, onClose])

  /* The review must never promise more than the server will grant. Typing a
     budget above the template's ceiling used to make it read "spend at most
     $5.00 a day" for a worker the API then refused to create. */
  const budgetNum = Number(budget)
  const budgetOverCeiling = !!t && Number.isFinite(budgetNum) && budgetNum > t.dailyBudgetUSD
  const effectiveBudget = t
    ? (Number.isFinite(budgetNum) && budgetNum > 0 ? Math.min(budgetNum, t.dailyBudgetUSD) : t.dailyBudgetUSD)
    : 0

  const canSubmit = !!t && name.trim().length >= 2
    && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(key)
    && !budgetOverCeiling

  return (
    <div className="sbw-drawerwrap" role="dialog" aria-modal="true" aria-label="Create a worker"
         onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sbw-drawer">
        <header className="sbw-drawerhead">
          <h3>Create a worker</h3>
          <button className="acr-btn" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </header>

        <div className="sbw-drawerbody">
          <p className="acr-pg-intro">
            A new worker is a narrower copy of one that already exists in code. You choose what it
            is called, where it looks, what it may spend and when it runs — and you can add
            instructions. You cannot give it a new ability: the tools and the evidence it reads
            come from the type you start from, which is what keeps every worker inside the same
            safety rules.
          </p>

          {err ? <div className="acr-banner err" role="alert">{err}</div> : null}

          {/* 1 — start from */}
          <label className="sbw-field"><span>1 · Start from</span></label>
          <div className="sbw-tmpls">
            {templates.filter((x) => !x.diagnostic).map((x) => (
              <button
                key={x.key}
                type="button"
                className={`sbw-tmpl ${templateKey === x.key ? 'on' : ''}`}
                aria-pressed={templateKey === x.key}
                onClick={() => setTemplateKey(x.key)}
              >
                <span className="sbw-avatar" aria-hidden><Bot size={14} /></span>
                <span className="txt">
                  <b>{x.name}</b>
                  <span className="sbw-note">{x.tier} · {x.domain}</span>
                  {x.description ? <span className="sbw-note">{x.description}</span> : null}
                </span>
                {templateKey === x.key ? <Check size={15} /> : null}
              </button>
            ))}
          </div>

          {t ? (
            <>
              {/* 2 — identity */}
              <label className="sbw-field">
                <span>2 · Call it</span>
                <input value={name} onChange={(e) => setName(e.target.value)}
                       placeholder={`${t.name} — Germany`} maxLength={80} />
              </label>
              <label className="sbw-field">
                <span>Its id, used in links and logs</span>
                <input value={key} onChange={(e) => { setKeyTouched(true); setKey(e.target.value) }}
                       placeholder="negative-miner-de" spellCheck={false} />
              </label>

              {/* 3 — narrowing */}
              <label className="sbw-field">
                <span>3 · Where it looks — one marketplace, or leave empty for everywhere</span>
                <input value={marketplace} onChange={(e) => setMarketplace(e.target.value.toUpperCase())}
                       placeholder="DE" maxLength={4} />
              </label>
              <label className="sbw-field">
                <span>What it may spend a day — at most ${t.dailyBudgetUSD.toFixed(2)}, its type&apos;s limit</span>
                <input type="number" step="0.01" min="0.01" max={t.dailyBudgetUSD}
                       value={budget} onChange={(e) => setBudget(e.target.value)}
                       placeholder={t.dailyBudgetUSD.toFixed(2)} />
                {budgetOverCeiling ? (
                  <span className="sbw-fielderr">
                    {/* One expression, not five JSX text nodes around three
                        interpolations — that spelling lost the space and read
                        "$5.00is above". */}
                    {`$${budgetNum.toFixed(2)} is above this type's limit of $${t.dailyBudgetUSD.toFixed(2)}. A worker you create can only narrow what its type allows, never widen it.`}
                  </span>
                ) : null}
              </label>
              <label className="sbw-field">
                <span>When it runs — a cron expression, or leave empty for &ldquo;only when asked&rdquo;</span>
                <input value={cadence} onChange={(e) => setCadence(e.target.value)}
                       placeholder="0 5 * * *" spellCheck={false} />
              </label>
              <label className="sbw-field">
                <span>Extra instructions — added to what its type already says, never replacing it</span>
                <textarea value={overlay} onChange={(e) => setOverlay(e.target.value)} rows={3}
                          placeholder="e.g. Prefer German long-tail terms and ignore brand variants." />
              </label>

              {/* 4 — the review, generated from the template */}
              <div className="sbw-review">
                <div>
                  <h4>What it will be able to do</h4>
                  <ul>
                    <li>Read: {t.observationKeys.map((k) => k.replace(/-/g, ' ')).join(', ') || 'nothing yet'}</li>
                    <li>Report at most {t.maxFindingsPerRun} findings a run</li>
                    <li>Spend at most ${effectiveBudget.toFixed(2)} a day</li>
                    <li>Rise as far as <b>{t.autonomyCap}</b> — never further</li>
                  </ul>
                </div>
                <div>
                  <h4>What it will never be able to do</h4>
                  <ul>
                    <li>Use any tool beyond {t.toolNames.length ? t.toolNames.join(', ') : 'none — it has no tools at all'}</li>
                    <li>Change anything on Amazon without passing the approval gate</li>
                    <li>Read evidence its type does not already read</li>
                    <li>Exceed its type&apos;s limits — you may narrow them, never widen</li>
                  </ul>
                </div>
              </div>

              <p className="sbw-note">
                It is created <b>switched off</b>, like every worker, and it will not run until you
                turn it on. A new worker does not join the nightly sweep on its own — wire it into
                a routine on Workflows, or run it by hand.
              </p>
            </>
          ) : null}
        </div>

        <footer className="sbw-drawerfoot">
          <button className="acr-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="acr-btn go" onClick={() => void submit()} disabled={!canSubmit || busy}>
            {busy ? 'Creating…' : 'Create it, switched off'}
          </button>
        </footer>
      </div>
    </div>
  )
}
