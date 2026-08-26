'use client'

/**
 * RDX/B2 — per-schedule row actions: Rename · Save as template · Delete.
 *
 * WHY THERE IS NO "DUPLICATE" HERE
 * The data model enforces one campaign → one AdSchedule row: saveRankScheduleGroup rebinds every
 * member campaign to whichever group saved last (ads-create.service.ts). So duplicating a schedule
 * *with* its campaigns would MOVE them to the copy and strand the original at zero members — the
 * exact orphan pattern DPS.1/DPS.2 diagnosed and cleaned up. And duplicating *without* campaigns
 * produces a group that opens blank in the builder, because the builder seeds its windows from
 * member schedules, not from the group row.
 * The real need behind "duplicate" is "use this shape somewhere else", and that is what
 * RankScheduleTemplate already models. So the action is Save as template.
 *
 * The menu renders fixed-position from the button's own rect rather than as a child popover: the
 * grid card clips overflow, which would cut the last item off on a short table.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal, Pencil, Trash2, BookmarkPlus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, Input } from '@/design-system/primitives'
import { Menu, Modal } from '@/design-system/components'

export interface RowTarget {
  id: string
  name: string
  campaigns: number
  windowsRaw: unknown[]
  baselineKey: string
}

type Dialog = 'rename' | 'template' | 'delete'

const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`

export function ScheduleRowActions({ row, onRenamed, onDeleted }: {
  row: RowTarget
  onRenamed: (id: string, name: string) => void
  onDeleted: (id: string) => void
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null)


  return (
    <>
      {/*
        PORTALLED — not a styling nicety, a correctness requirement, and the reason this is the DS
        `Menu` rather than a hand-rolled popover kept for old times' sake: `Menu` portals to
        `document.body` at --nds-z-popover (1450). The trigger lives in the grid's sticky first
        column, and `.nds-wsgrid td.nm` carries `position: sticky; z-index: 3`, which opens a
        STACKING CONTEXT — any z-index on a descendant is resolved inside it, so the old menu
        composited beneath the app sidebar however high the number went.

        The wrapping span is load-bearing too. `AdsDataGrid` gives this row an `onRowClick` that
        opens the Activity drawer, so every control inside it stops propagation; `Menu` owns the
        trigger's `onClick` (a `triggerProps.onClick` would replace its toggle), so the stop
        happens one level out. The menu panel itself is at body level and never bubbles here.
      */}
      <span onClick={(e) => e.stopPropagation()} role="presentation">
        <Menu
          className="h10-rowmenu-wrap"
          label={<MoreHorizontal size={15} />}
          triggerProps={{ className: 'nds-btn h10-rowmenu-btn', 'aria-label': `Actions for ${row.name}` }}
          items={[
            { id: 'rename', icon: <Pencil size={13} />, label: 'Rename', onSelect: () => setDialog('rename') },
            { id: 'template', icon: <BookmarkPlus size={13} />, label: 'Save as template', onSelect: () => setDialog('template') },
            // `MenuItemDef` carries no tone (DS-GAPS), so the danger ink rides on the label.
            { id: 'delete', icon: <Trash2 size={13} />, label: <span className="h10-menu-danger">Delete</span>, onSelect: () => setDialog('delete') },
          ]}
        />
      </span>

      {/* Same stacking trap, same fix: the confirm/rename modals are also children of the sticky cell. */}
      {dialog && typeof document !== 'undefined' && createPortal(
        <RowDialog kind={dialog} row={row} onClose={() => setDialog(null)} onRenamed={onRenamed} onDeleted={onDeleted} />,
        document.body,
      )}
    </>
  )
}

function RowDialog({ kind, row, onClose, onRenamed, onDeleted }: {
  kind: Dialog; row: RowTarget; onClose: () => void
  onRenamed: (id: string, name: string) => void
  onDeleted: (id: string) => void
}) {
  const [value, setValue] = useState(kind === 'template' ? `${row.name} template` : row.name)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')

  const esc = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }, [onClose, busy])
  useEffect(() => { document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc) }, [esc])

  const windowCount = row.windowsRaw.filter((w) => !!(w as { targetKey?: string })?.targetKey).length

  const submit = async () => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      if (kind === 'rename') {
        const name = value.trim()
        if (!name) { setErr('A schedule needs a name.'); return }
        if (name === row.name) { onClose(); return }
        const r = await fetch(api(`/rank-schedule-groups/${row.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
        if (!r.ok) { const j = await r.json().catch(() => null); setErr(j?.error ?? 'Rename failed — please retry.'); return }
        onRenamed(row.id, name); onClose()
      } else if (kind === 'template') {
        const name = value.trim()
        if (!name) { setErr('Give the template a name.'); return }
        const r = await fetch(`${getBackendUrl()}/api/advertising/rank-templates`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, windows: row.windowsRaw, defaultTargetKey: row.baselineKey || null }),
        })
        if (!r.ok) { setErr('Could not save the template — please retry.'); return }
        setDone(`Saved "${name}". Load it from the Templates button in the schedule builder.`)
      } else {
        const r = await fetch(api(`/rank-schedule-groups/${row.id}`), { method: 'DELETE' })
        if (!r.ok) { setErr('Delete failed — please retry.'); return }
        onDeleted(row.id); onClose()
      }
    } catch { setErr('Request failed — please retry.') }
    finally { setBusy(false) }
  }

  const TITLE: Record<Dialog, string> = { rename: 'Rename schedule', template: 'Save as template', delete: 'Delete schedule' }
  const CTA: Record<Dialog, string> = { rename: 'Rename', template: 'Save template', delete: 'Delete' }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      title={TITLE[kind]}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>{done ? 'Close' : 'Cancel'}</Button>
        {!done && (
          <Button
            variant={kind === 'delete' ? 'danger' : 'primary'} size="sm"
            onClick={() => void submit()} disabled={busy}
          >
            {busy ? 'Working…' : CTA[kind]}
          </Button>
        )}
      </>}
    >
      <p className="h10-ntm-say">
        {kind === 'rename' && <>Renaming changes the schedule only — its campaigns, windows and baseline are untouched.</>}
        {kind === 'template' && <>Saves this schedule&rsquo;s {windowCount} window{windowCount === 1 ? '' : 's'} and its baseline as a reusable template. The schedule itself is not changed.</>}
        {/* Every consequence, stated. A campaign is not "released" to some default — the engine
            simply stops holding a rank for it, and whatever bid it last set on Amazon stays. */}
        {kind === 'delete' && (
          <>
            Deletes <b>{row.name}</b> and removes the schedule from its <b>{row.campaigns}</b> campaign{row.campaigns === 1 ? '' : 's'}.
            The rank loop stops holding a rank for {row.campaigns === 1 ? 'it' : 'them'}; the bids it last set on Amazon <b>stay as they are</b> — nothing is reverted.
            This cannot be undone.
          </>
        )}
      </p>

      {done ? <div className="h10-ntm-ok">{done}</div> : kind === 'delete' ? null : (
        <Input
          fieldClassName="h10-ntm-field" autoFocus
          value={value} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          aria-label={kind === 'rename' ? 'Schedule name' : 'Template name'}
          placeholder={kind === 'rename' ? 'Schedule name' : 'Template name'}
        />
      )}
      {err && <div className="h10-ntm-err">{err}</div>}
    </Modal>
  )
}
