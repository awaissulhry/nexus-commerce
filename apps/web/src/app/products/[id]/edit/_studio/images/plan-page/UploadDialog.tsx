'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MediaSetRef } from '@nexus/shared/media-plan'

import { Banner, FileDropzone, JobProgress, MetricStrip, Modal, Thumbnail } from '@/design-system/components'
import { Button, Input, SegmentedControl, Select, Tag } from '@/design-system/primitives'

import { getBackendUrl } from '@/lib/backend-url'

import { apiSend, routes } from '../api'
import { CHANNEL_LABEL, destinationCells, destinationLabel, setRows, swatchRows, type LayerView, type MediaChannel, type MediaRead } from './model'
import { fileNameContext, libraryUpdate, placedAsset, placementOps, rowFromFile, versionRows, type UploadRow } from './uploadModel'
import { uploadPhoto } from './uploadApi'
import type { MediaPlanState } from './useMediaPlan'
import styles from './planPage.module.css'

const LANGUAGES: Array<[string, string]> = [['zxx', 'No text'], ['mul', 'Several languages'], ['it', 'Italian'], ['de', 'German'], ['fr', 'French'],
  ['es', 'Spanish'], ['en', 'English'], ['nl', 'Dutch'], ['pl', 'Polish'], ['sv', 'Swedish']]
const languageLabel = (tag: string) => LANGUAGES.find(([t]) => t === tag)?.[1] ?? tag.toUpperCase()
const OPS_PER_EDIT = 50

type Where = 'SHARED' | 'CHANNEL' | 'LISTING'
type Phase = 'idle' | 'working' | 'placing' | 'done'
interface Done { placed: number; fresh: number; skipped: string[]; refs: MediaSetRef[]; steps: number; undone: boolean }

export interface UploadDialogProps {
  read: MediaRead
  plan: MediaPlanState
  open: boolean
  /** Files dropped on the page before the dialog opened. */
  files: File[]
  onClose(): void
  onReview?(): void
}

/**
 * Images rebuild P4b — "Upload photos" (PLAN.md §4.6, §5.5; the PSIE dialog pattern): drop files, see what each file
 * name says (set, position, language) and what the library's duplicate check found, change any guess, then place them
 * all in one step. Nothing is sent to a channel. Cancel removes the photos this window added to the library.
 */
export function UploadDialog({ read, plan, open, files, onClose, onReview }: UploadDialogProps) {
  const [rows, setRows_] = useState<UploadRow[]>([])
  const [where, setWhere] = useState<Where>('SHARED')
  const channels = useMemo(() => [...new Set(read.destinations.filter(d => d.targetable).map(d => d.channel))], [read.destinations])
  const [channel, setChannel] = useState<MediaChannel>(channels[0] ?? 'EBAY')
  const listings = read.destinations.filter(d => d.targetable)
  const [destination, setDestination] = useState<string>(listings[0]?.key ?? '')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const [started, setStarted] = useState<number | null>(null)
  const fileOf = useRef(new Map<string, File>())
  const previews = useRef(new Set<string>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const context = useMemo(() => fileNameContext(read), [read])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  /** Set once this window's new photos were removed (Cancel), so leaving the page does not remove them twice. */
  const cleared = useRef(false)

  const view: LayerView = where === 'SHARED' ? { layer: 'SHARED' } : where === 'CHANNEL' ? { layer: 'CHANNEL', channel } : { layer: 'LISTING', destination }
  const patch = useCallback((key: string, change: Partial<UploadRow>) => setRows_(list => list.map(r => r.key === key ? { ...r, ...change } : r)), [])

  /** One file at a time through the library's duplicate check (two parallel uploads of the same bytes could both pass). */
  const send = useCallback((key: string, force = false) => {
    const file = fileOf.current.get(key)
    if (!file) return
    patch(key, { status: { kind: 'uploading' } })
    queue.current = queue.current.then(async () => {
      let status = await uploadPhoto(read.rootId, file, force)
      // Language versions look alike (a size chart in IT and DE): a file in another language than the photo it looks
      // like is a version of it, not a duplicate — it is uploaded, and the version group joins them.
      if (status.kind === 'similar') {
        const candidate = status.candidate.id
        const mine = rowsRef.current.find(r => r.key === key)?.language ?? 'zxx'
        const theirs = rowsRef.current.find(r => placedAsset(r) === candidate)?.language ?? read.library.find(a => a.id === candidate)?.languageTag ?? 'zxx'
        if (mine !== 'zxx' && theirs !== 'zxx' && mine !== theirs) { patch(key, { choice: 'upload' }); status = await uploadPhoto(read.rootId, file, true) }
      }
      patch(key, { status })
    })
  }, [patch, read.library, read.rootId])

  const add = useCallback((list: File[]) => {
    const images = list.filter(f => f.type.startsWith('image/'))
    if (!images.length) { setError('Choose image files (JPEG, PNG, WebP …).'); return }
    setError(null); setDone(null); setPhase('working'); setStarted(s => s ?? Date.now())
    const made = images.map(file => {
      const key = crypto.randomUUID()
      fileOf.current.set(key, file)
      const preview = URL.createObjectURL(file)
      previews.current.add(preview)
      return rowFromFile(key, file.name, preview, context)
    })
    setRows_(current => [...current, ...made])
    for (const row of made) send(row.key)
  }, [context, send])

  // A new opening starts from the files dropped on the page; closing frees the previews.
  useEffect(() => {
    if (!open) return
    setRows_([]); setDone(null); setError(null); setPhase('idle'); setStarted(null); fileOf.current.clear(); cleared.current = false
    if (files.length) add(files)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { for (const url of previews.current) URL.revokeObjectURL(url); previews.current.clear() }, [open])

  const uploading = rows.some(r => r.status.kind === 'waiting' || r.status.kind === 'uploading')
  useEffect(() => { if (phase === 'working' && !uploading) setPhase('idle') }, [phase, uploading])

  const counts = {
    files: rows.length,
    fresh: rows.filter(r => r.status.kind === 'new').length,
    exact: rows.filter(r => r.status.kind === 'exact').length,
    similar: rows.filter(r => r.status.kind === 'similar').length,
    failed: rows.filter(r => r.status.kind === 'failed').length,
  }
  const placement = useMemo(() => placementOps(read, view, rows), [read, rows, where, channel, destination]) // eslint-disable-line react-hooks/exhaustive-deps
  // What Place will really do: photos going into sets (versions and photos already there are not counted) and swatches.
  const placing = placement.sets.reduce((n, s) => n + s.count, 0) + placement.ops.filter(op => op.op === 'swatch').length

  // Language versions a market lacks show that market the nearest version (D6) — said before placing, not after.
  const versionNotes = useMemo(() => {
    const markets = [...new Set(read.destinations.flatMap(d => d.languages).filter(l => l !== 'mul' && l !== 'zxx'))]
    return versionRows(rows.filter(r => placedAsset(r))).flatMap(keys => {
      const group = rows.filter(r => keys.includes(r.key))
      const have = new Set(group.map(r => r.language))
      const missing = markets.filter(l => !have.has(l))
      const shown = group.find(r => r.language === read.mainLanguage) ?? group[0]
      return missing.length ? [`${group[0].base.replace(/-/g, ' ')}: no ${missing.map(l => l.toUpperCase()).join(', ')} version yet — ${missing.length === 1 ? 'that market shows' : 'those markets show'} the ${languageLabel(shown.language)} one until you add ${missing.length === 1 ? 'it' : 'them'}.`] : []
    })
  }, [read.destinations, read.mainLanguage, rows])

  const setOptions = [...setRows(read, view, { skus: true }).filter(r => r.kind !== 'sku' || rows.some(x => x.set === r.ref)).map(r => ({ value: r.ref as string, label: r.label })),
    ...swatchRows(read, view).map(s => ({ value: `swatch:${s.value}`, label: `${s.label} swatch` }))]

  const place = async () => {
    setPhase('placing'); setError(null)
    const update = libraryUpdate(rows)
    if (update.languages.some(l => l.languageTag !== 'zxx') || update.groups.length) {
      const res = await apiSend<unknown>(`/api/products/${encodeURIComponent(read.rootId)}/media/library`, 'PATCH', update)
      if (!res.ok) { setError(res.message); setPhase('idle'); return }
    }
    const fresh = (await plan.reload(true)) ?? read
    const planned = placementOps(fresh, view, rows)
    const parts: typeof planned.ops[] = []
    for (let i = 0; i < planned.ops.length; i += OPS_PER_EDIT) parts.push(planned.ops.slice(i, i + OPS_PER_EDIT))
    for (const [i, ops] of parts.entries()) {
      const outcome = await plan.edit(view, ops, parts.length > 1 ? `Place photos (${i + 1} of ${parts.length})` : `Place ${placing} photo${placing === 1 ? '' : 's'}`)
      if (!outcome.ok) { setError(outcome.message); setPhase('idle'); return }
    }
    const placedNow = planned.sets.reduce((n, set) => n + set.count, 0) + planned.ops.filter(op => op.op === 'swatch').length
    setDone({ placed: placedNow, fresh: counts.fresh, skipped: planned.skipped, refs: planned.sets.map(s => s.ref), steps: parts.length, undone: false })
    setPhase('done')
  }

  /** The photos this window added leave the library again (a photo that was already there stays). */
  const removeAdded = async () => {
    await queue.current
    const added = rowsRef.current.flatMap(r => r.status.kind === 'new' ? [r.status.assetId] : [])
    cleared.current = true
    for (const id of added) await apiSend<unknown>(routes.masterImage(read.rootId, id), 'DELETE')
    if (added.length) await plan.reload(true)
  }

  // Leaving the page (another tab of the studio, another page, closing the browser tab) with photos uploaded but not
  // placed removes them too, so an abandoned upload never leaves unused photos behind in the library.
  useEffect(() => {
    const abandon = () => {
      if (cleared.current || phaseRef.current === 'done') return
      const added = rowsRef.current.flatMap(r => r.status.kind === 'new' ? [r.status.assetId] : [])
      if (!added.length) return
      cleared.current = true
      for (const id of added) void fetch(`${getBackendUrl()}${routes.masterImage(read.rootId, id)}`, { method: 'DELETE', credentials: 'include', keepalive: true }).catch(() => undefined)
    }
    window.addEventListener('pagehide', abandon)
    return () => { window.removeEventListener('pagehide', abandon); abandon() }
  }, [read.rootId])
  /** Cancel before placing removes what this window added. */
  const cancel = async () => {
    if (phase !== 'done' && rows.some(r => r.status.kind === 'new' || r.status.kind === 'uploading')) { setPhase('placing'); await removeAdded() }
    onClose()
  }

  const followers = done ? read.destinations.filter(d => d.targetable && destinationCells(read, d).some(c => done.refs.includes(c.ref)
    && (view.layer === 'SHARED' ? c.source === 'shared' : view.layer === 'CHANNEL' ? c.source === 'channel' && d.channel === view.channel : d.key === view.destination))).length : 0

  // A list, not a grid: every choice is a native Tab stop, in order, and the lines stack on a phone.
  const columns: Array<{ key: string; label: string; render(row: UploadRow): ReactNode }> = [
    { key: 'photo', label: 'Photo', render: r => <Thumbnail src={r.preview} alt={r.fileName} hoverPreview={false} /> },
    { key: 'file', label: 'File', render: r => <span className={styles.uploadFile}><span>{r.fileName}</span><span className={styles.muted}>{r.reason}</span></span> },
    { key: 'set', label: 'Set', render: r => <Select size="xs" aria-label={`Set for ${r.fileName}`} value={r.swatch ? `swatch:${r.set.slice('value:'.length)}` : r.set} disabled={phase === 'placing' || phase === 'done'}
      onChange={e => { const v = e.target.value; patch(r.key, v.startsWith('swatch:') ? { set: `value:${v.slice('swatch:'.length)}` as MediaSetRef, swatch: true } : { set: v as MediaSetRef, swatch: false }) }}>
      {setOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select> },
    { key: 'position', label: 'Position', render: r => r.swatch ? '—' : <Input size="xs" type="number" min={1} max={24} inputMode="numeric" aria-label={`Position of ${r.fileName}`} placeholder="End"
      value={r.position ?? ''} disabled={phase === 'placing' || phase === 'done'}
      onChange={e => { const n = Number(e.target.value); patch(r.key, { position: e.target.value === '' || !Number.isInteger(n) || n < 1 ? null : n }) }} /> },
    { key: 'language', label: 'Language', render: r => <Select size="xs" aria-label={`Language of ${r.fileName}`} value={r.language} disabled={phase === 'placing' || phase === 'done' || r.status.kind === 'exact' || r.status.kind === 'similar'}
      onChange={e => patch(r.key, { language: e.target.value })}>
      {LANGUAGES.map(([tag, label]) => <option key={tag} value={tag}>{label}</option>)}
    </Select> },
    { key: 'status', label: 'Status', render: r => {
      const s = r.status
      if (s.kind === 'waiting') return <span className={styles.muted}>Waiting</span>
      if (s.kind === 'uploading') return <span className={styles.muted}>Uploading…</span>
      if (s.kind === 'new') return <Tag tone="success">New</Tag>
      if (s.kind === 'exact') return <span className={styles.uploadStatus}><Tag tone="neutral">Already in the library</Tag><span className={styles.muted}>That photo is used.</span></span>
      if (s.kind === 'failed') return <span className={styles.uploadStatus}><Tag tone="danger">Not uploaded</Tag><span className={styles.refusal}>{s.message}</span></span>
      return <span className={styles.uploadStatus}>
        <span className={styles.cell}><Thumbnail src={s.candidate.url} alt={s.candidate.label} /> Looks like {s.candidate.label}</span>
        <span className={styles.muted}>Another language of that photo? Choose Upload anyway.</span>
        <SegmentedControl size="sm" ariaLabel={`What to do with ${r.fileName}`} value={r.choice} disabled={phase === 'placing' || phase === 'done'}
          onChange={v => { if (v === 'upload') { patch(r.key, { choice: 'upload' }); send(r.key, true) } else patch(r.key, { choice: 'use' }) }}
          options={[{ value: 'use', label: 'Use that photo' }, { value: 'upload', label: 'Upload anyway' }]} />
      </span>
    } },
  ]

  const placeLabel = placing ? `Place ${placing} file${placing === 1 ? '' : 's'}${placement.sets.length ? ` · ${placement.sets.map(s => `${s.label} ${s.count}`).join(' · ')}` : ''}` : 'Nothing to place'
  const footer = phase === 'done' && done ? <>
    {done.steps === 1 && !done.undone && <Button size="sm" variant="secondary" onClick={() => { plan.undo(); setDone({ ...done, undone: true }) }}>Undo</Button>}
    {done.undone && done.fresh > 0 && <Button size="sm" variant="secondary" onClick={() => void removeAdded().then(onClose)}>Remove the {done.fresh} new photo{done.fresh === 1 ? '' : 's'} from the library</Button>}
    {onReview && !done.undone && <Button size="sm" variant="secondary" onClick={() => { onClose(); onReview() }}>Review &amp; publish</Button>}
    <span className={styles.spacer} />
    <Button size="sm" variant="primary" onClick={onClose}>Done</Button>
  </> : <>
    {counts.fresh > 0 && <span className={styles.muted}>Cancel removes the {counts.fresh} photo{counts.fresh === 1 ? '' : 's'} this window added.</span>}
    <span className={styles.spacer} />
    <Button size="sm" variant="secondary" disabled={phase === 'placing'} onClick={() => void cancel()}>Cancel</Button>
    <Button size="sm" variant="primary" disabled={!placing || uploading || phase === 'placing'} onClick={() => void place()}>{phase === 'placing' ? 'Placing…' : placeLabel}</Button>
  </>

  return <Modal open={open} onClose={() => { if (phase !== 'placing') void cancel() }} size="xxl" title={phase === 'done' ? 'Photos placed' : rows.length ? `Add ${rows.length} file${rows.length === 1 ? '' : 's'}` : 'Upload photos'}
    subtitle={rows.length ? undefined : 'Name files like "gale-nero-01.jpg" or "size-chart-de.jpg": the set, the position and the language are read from the name.'} footer={footer}>
    <div className={styles.compareBody}>
      {error && <Banner tone="danger" title="This did not work" onDismiss={() => setError(null)}>{error}</Banner>}
      {phase === 'done' && done ? <Banner tone="success" title={done.undone ? 'Placement undone' : `${done.placed} file${done.placed === 1 ? '' : 's'} placed${done.fresh ? ` (${done.fresh} new in the library)` : ''}`}>
        {done.undone ? 'The sets are as they were. The new photos stay in the library, unused.'
          : `${followers} destination${followers === 1 ? '' : 's'} follow${followers === 1 ? 's' : ''} them. Nothing was sent to a channel.${done.skipped.length ? ` Already in their set, so skipped: ${done.skipped.join(', ')}.` : ''}`}
      </Banner> : <>
        <FileDropzone accept="image/*" multiple disabled={phase === 'placing'} onFiles={add}
          hint={rows.length ? 'Drop more files here.' : 'Or drop files anywhere on the Media page. Unknown names go to Common, where one click moves them.'} />
        {rows.length > 0 && <>
          <MetricStrip metrics={[
            { label: 'Files', value: counts.files },
            { label: 'New', value: counts.fresh },
            { label: 'Already in the library', value: counts.exact },
            { label: 'Looks like a library photo', value: counts.similar },
            ...(counts.failed ? [{ label: 'Not uploaded', value: counts.failed }] : []),
          ]} />
          {uploading && started && <JobProgress label="Uploading to the library" value={rows.filter(r => !['waiting', 'uploading'].includes(r.status.kind)).length} max={rows.length}
            detail={`${rows.filter(r => !['waiting', 'uploading'].includes(r.status.kind)).length} of ${rows.length} files`} startedAt={started} />}
          <div className={styles.uploadWhere} role="group" aria-label="Put them in">
            <span className={styles.control}>Put them in</span>
            <SegmentedControl size="sm" ariaLabel="Put them in" value={where} onChange={v => setWhere(v as Where)} disabled={phase === 'placing'}
              options={[{ value: 'SHARED', label: 'Shared — every channel' }, { value: 'CHANNEL', label: 'One channel' }, { value: 'LISTING', label: 'One listing' }]} />
            {where === 'CHANNEL' && <Select size="sm" aria-label="Channel" value={channel} onChange={e => setChannel(e.target.value as MediaChannel)}>
              {channels.map(c => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
            </Select>}
            {where === 'LISTING' && <Select size="sm" aria-label="Listing" value={destination} onChange={e => setDestination(e.target.value)}>
              {listings.map(d => <option key={d.key} value={d.key}>{destinationLabel(d)}</option>)}
            </Select>}
          </div>
          {versionNotes.map(note => <Banner key={note} tone="warning">{note}</Banner>)}
          <div className={styles.uploadTable}>
            <div className={styles.uploadHead} aria-hidden>{columns.map(c => <span key={c.key}>{c.label}</span>)}</div>
            <ul className={styles.uploadLines} aria-label="Files to place">
              {rows.map(r => <li key={r.key} className={styles.uploadLine}>{columns.map(c => <div key={c.key} className={styles.uploadCell} data-col={c.key}>
                {['set', 'position', 'language'].includes(c.key) && <span className={styles.uploadLabel} aria-hidden>{c.label}</span>}{c.render(r)}
              </div>)}</li>)}
            </ul>
          </div>
        </>}
      </>}
    </div>
  </Modal>
}
