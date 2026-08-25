'use client'

/**
 * F1 + F2 — the template library, and applying one across many schedules at once.
 *
 * RankScheduleTemplate and its full CRUD have existed for a while, reachable only from a modal
 * inside the builder — so a template could be saved and loaded one schedule at a time, which is
 * the least useful shape for the thing. The point of a template is "author once, apply to many":
 * Pacvue's templatised dayparting is the pattern, and it is the highest-leverage control on this
 * page once you run more than a handful of schedules.
 *
 * Reached from the schedules list's bulk selection bar, next to Enable and Pause — the place N
 * schedules are already selected. No new page, no new nav.
 *
 * Each template renders its own week shape via the shared WeekShape, so you pick by looking at the
 * plan rather than by trusting its name.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trash2, Check } from 'lucide-react'
import { WeekShape } from './WeekShape'
import type { TargetPalette } from './ScheduleVersions'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, ToolbarButton } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'

interface Template {
  id: string; name: string; windows: unknown[]; defaultTargetKey: string | null; updatedAt: string
}

export function TemplateLibrary({ groupIds, groupNames, palette, onClose, onApplied }: {
  /** The schedules the template will be applied to. */
  groupIds: string[]
  groupNames: string[]
  palette: TargetPalette
  onClose: () => void
  onApplied: () => void
}) {
  const [items, setItems] = useState<Template[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    setItems(null)
    fetch(`${getBackendUrl()}/api/advertising/rank-templates`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setItems(Array.isArray(j?.items) ? j.items : []))
      .catch(() => setItems([]))
  }, [])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose, busy])

  const chosen = useMemo(() => items?.find((t) => t.id === picked) ?? null, [items, picked])
  const windowCount = (t: Template) => (Array.isArray(t.windows) ? t.windows.filter((w) => !!(w as { targetKey?: string })?.targetKey).length : 0)

  const apply = async () => {
    if (!picked || busy) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/apply-template`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: picked, groupIds }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) { setErr(j?.error ?? 'Could not apply the template.'); return }
      const failed = Array.isArray(j?.failed) ? j.failed.length : 0
      setMsg(`Applied "${j?.template?.name ?? 'template'}" to ${j?.applied ?? 0} schedule${j?.applied === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}. Each schedule keeps its own campaigns and its armed/paused state.`)
      onApplied()
    } catch { setErr('Request failed — please retry.') }
    finally { setBusy(false) }
  }

  const remove = async (t: Template) => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-templates/${t.id}`, { method: 'DELETE' })
      if (!r.ok) { setErr('Could not delete that template.'); return }
      if (picked === t.id) setPicked(null)
      load()
    } catch { setErr('Request failed — please retry.') }
    finally { setBusy(false) }
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      /* `md` is 560px — the width `.h10-ntm.wide` actually rendered. Two rules declared that
         class, 620px then 560px, and at equal specificity the later one had been winning. */
      size="md"
      title="Apply a template"
      subtitle={<>
        {/* Stated plainly, because this REPLACES a plan on schedules that may be live. */}
        Replaces the windows and baseline on <b>{groupIds.length}</b> selected schedule{groupIds.length === 1 ? '' : 's'}
        {groupNames.length > 0 && <> — {groupNames.slice(0, 3).join(', ')}{groupNames.length > 3 ? ` +${groupNames.length - 3} more` : ''}</>}.
        Campaigns, portfolio scope and armed/paused state are untouched.
      </>}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>{msg ? 'Close' : 'Cancel'}</Button>
        {!msg && (
          <Button variant="primary" size="sm" disabled={!chosen || busy} onClick={() => void apply()}>
            {busy ? 'Applying…' : <><Check size={14} /> Apply to {groupIds.length}</>}
          </Button>
        )}
      </>}
    >
      {items === null ? (
        <div className="h10-hist-msg">Loading templates…</div>
      ) : items.length === 0 ? (
        <div className="h10-hist-msg">
          No templates yet. Save one from any schedule&rsquo;s ⋯ menu — &ldquo;Save as template&rdquo; stores its
          windows and baseline for reuse here.
        </div>
      ) : (
        <div className="h10-tpl-list">
          {items.map((t) => (
            <label key={t.id} className={`h10-tpl-r ${picked === t.id ? 'on' : ''}`}>
              <input type="radio" name="tpl" checked={picked === t.id} onChange={() => setPicked(t.id)} />
              <span className="body">
                <span className="nm">{t.name}</span>
                <span className="meta">
                  {windowCount(t)} window{windowCount(t) === 1 ? '' : 's'}
                  {t.defaultTargetKey ? ` · baseline ${palette.name(t.defaultTargetKey)}` : ' · no baseline'}
                </span>
              </span>
              {/* Pick by looking at the plan, not by trusting the name. */}
              <WeekShape
                windows={t.windows}
                baselineKey={t.defaultTargetKey ?? ''}
                colorOf={palette.color}
                nameOf={palette.name}
                baselineName={t.defaultTargetKey ? palette.name(t.defaultTargetKey) : 'Baseline'}
              />
              {/* This sits inside the row's `<label>`, so the click MUST `preventDefault()` or
                  deleting a template also selects it. `ToolbarButton` takes the native handler
                  signature as of 2026-08-25, which is what makes this convertible. */}
              <ToolbarButton
                tone="danger" size="sm" className="del"
                icon={<Trash2 size={13} />} label={`Delete ${t.name}`} description="Delete this template"
                onClick={(e) => { e.preventDefault(); void remove(t) }}
              />
            </label>
          ))}
        </div>
      )}
      {err && <div className="h10-ntm-err">{err}</div>}
      {msg && <div className="h10-ntm-ok">{msg}</div>}
    </Modal>
  )
}
