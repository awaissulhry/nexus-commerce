'use client'

/**
 * RPT.5 — the saved-report strip above the runner.
 *
 * Three jobs: load a saved definition, save the current one, and show its
 * history. The "unsaved changes" state is the important one — without it an
 * operator tweaks a filter, exports, and believes they exported the saved
 * report. The strip says plainly which of the two they are looking at.
 */
import { useCallback, useEffect, useState } from 'react'
import { Bookmark, BookmarkPlus, History, RotateCcw, Trash2, X } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Pill } from '@/design-system/primitives/Pill'
import { Input } from '@/design-system/primitives/Input'
import { ToolbarButton } from '@/design-system/primitives/ToolbarButton'
import {
  archiveSaved,
  createSaved,
  listSaved,
  listVersions,
  paramsToQuery,
  queryDiffers,
  queryToParams,
  restoreVersion,
  updateSaved,
  type SavedReport,
  type SavedVersion,
} from './saved-api'
import type { ReportParams } from './report-api'

export function SavedReportBar({
  params,
  onApply,
}: {
  params: ReportParams
  onApply: (next: ReportParams) => void
}) {
  const [saved, setSaved] = useState<SavedReport[]>([])
  const [active, setActive] = useState<SavedReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [saveOpen, setSaveOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [historyFor, setHistoryFor] = useState<SavedReport | null>(null)
  const [versions, setVersions] = useState<SavedVersion[]>([])

  const reload = useCallback(() => {
    listSaved(params.reportId)
      .then(setSaved)
      .catch((e: unknown) => setError((e as Error).message))
  }, [params.reportId])

  useEffect(() => {
    reload()
  }, [reload])

  // Switching report clears the active definition — a saved "Campaign" report
  // has nothing to say about the search-term screen.
  useEffect(() => {
    setActive((a) => (a && a.reportId !== params.reportId ? null : a))
  }, [params.reportId])

  const dirty = active ? queryDiffers(active.query, paramsToQuery(params)) : false

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doCreate = () =>
    guard(async () => {
      const created = await createSaved(draftName.trim(), paramsToQuery(params))
      setActive(created)
      setSaveOpen(false)
      setDraftName('')
      reload()
    })

  const doUpdate = () =>
    guard(async () => {
      if (!active) return
      const updated = await updateSaved(active.id, { query: paramsToQuery(params) })
      setActive(updated)
      reload()
    })

  const openHistory = (r: SavedReport) =>
    guard(async () => {
      setVersions(await listVersions(r.id))
      setHistoryFor(r)
    })

  const doRestore = (version: number) =>
    guard(async () => {
      if (!historyFor) return
      const restored = await restoreVersion(historyFor.id, version)
      setActive(restored)
      onApply(queryToParams(restored.query, params))
      setVersions(await listVersions(restored.id))
      reload()
    })

  const doArchive = (r: SavedReport) =>
    guard(async () => {
      await archiveSaved(r.id)
      if (active?.id === r.id) setActive(null)
      setHistoryFor(null)
      reload()
    })

  return (
    <div className="rpt-saved">
      <span className="rpt-saved-lbl">
        <Bookmark size={13} aria-hidden /> Saved
      </span>

      {saved.length === 0 && <span className="rpt-saved-empty">None yet</span>}

      {saved.map((r) => (
        <span key={r.id} className={`rpt-chip${active?.id === r.id ? ' on' : ''}`}>
          <button
            type="button"
            className="rpt-chip-main"
            title={`${r.name} — v${r.version}, updated ${new Date(r.updatedAt).toLocaleDateString('en-GB')}`}
            onClick={() => {
              setActive(r)
              onApply(queryToParams(r.query, params))
            }}
          >
            {r.name}
            <span className="v">v{r.version}</span>
          </button>
          <button
            type="button"
            className="rpt-chip-icon"
            title={`History of "${r.name}"`}
            aria-label={`History of ${r.name}`}
            onClick={() => openHistory(r)}
          >
            <History size={12} aria-hidden />
          </button>
        </span>
      ))}

      <span className="rpt-saved-actions">
        {active && dirty && (
          <>
            <Pill tone="warning">Unsaved changes</Pill>
            <Button size="sm" variant="secondary" disabled={busy} onClick={doUpdate}>
              Update “{active.name}”
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setDraftName(active ? `${active.name} copy` : '')
            setSaveOpen(true)
          }}
        >
          <BookmarkPlus size={13} aria-hidden /> Save as…
        </Button>
      </span>

      {error && (
        <span className="rpt-saved-err" role="alert">
          {error}
          <ToolbarButton icon={<X size={12} />} label="Dismiss" tooltip={false} onClick={() => setError(null)} />
        </span>
      )}

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save this report"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button disabled={!draftName.trim() || busy} onClick={doCreate}>Save</Button>
          </>
        }
      >
        <p className="rpt-modal-p">
          Saves the current filters, grouping, columns and sort — not the page you are on.
          This is the unit that scheduled delivery will send.
        </p>
        <label className="rpt-field">
          <span>Name</span>
          <Input
            value={draftName}
            autoFocus
            placeholder="e.g. Italy · high-ACOS search terms"
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draftName.trim()) doCreate()
            }}
          />
        </label>
      </Modal>

      <Modal
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
        title={historyFor ? `History — ${historyFor.name}` : 'History'}
        footer={
          <>
            {historyFor && (
              <Button
                variant="danger"
                onClick={() => doArchive(historyFor)}
                disabled={busy}
              >
                <Trash2 size={13} aria-hidden /> Delete report
              </Button>
            )}
            <Button variant="secondary" onClick={() => setHistoryFor(null)}>Close</Button>
          </>
        }
      >
        <p className="rpt-modal-p">
          Every save appends a version; nothing is overwritten. Restoring adds a new
          version with the old content, so the history stays complete.
        </p>
        <ol className="rpt-versions">
          {versions.map((v) => (
            <li key={v.id} className={v.isCurrent ? 'is-current' : undefined}>
              <div className="hd">
                <b>v{v.version}</b>
                {v.isCurrent && <Pill tone="success">Current</Pill>}
                <span className="when">
                  {new Date(v.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                {!v.isCurrent && (
                  <Button size="sm" className="rpt-row-act" disabled={busy} onClick={() => doRestore(v.version)}>
                    <RotateCcw size={12} aria-hidden /> Restore
                  </Button>
                )}
              </div>
              <div className="note">{v.changeNote ?? '—'}</div>
            </li>
          ))}
        </ol>
      </Modal>
    </div>
  )
}
