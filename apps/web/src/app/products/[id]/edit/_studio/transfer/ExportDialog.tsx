'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ProductTransferOptions } from '@nexus/shared/catalog-transfer'
import { Button, CheckboxCard, SegmentedControl, Skeleton } from '@/design-system/primitives'
import { Banner, Field, Modal, useToast } from '@/design-system/components'
import { sheetTransferApi, type ExportNotes } from './sheetTransferApi'
import { defaultExportChoice, exportBlocker, exportDestinations, exportLanguages, exportProductIds, exportSelection, languageName, type ExportChoice, type ExportContext } from './exportModel'
import styles from './sheetTransfer.module.css'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * PSIE — Export: one small dialog, then Download. Every choice has a default (the whole family, Shared, the channel on
 * screen, all columns), so the common case is Export → Download. The file is the sheet: its channel tabs hold exactly
 * the columns this sheet shows for each channel market, in that market's language, one row per listing alias.
 */
export function ExportDialog({ open, onClose, context, visibleFields, onReference }: { open: boolean; onClose(): void; context: ExportContext; visibleFields?: string[]; onReference?(): void }) {
  const { toast } = useToast()
  const [options, setOptions] = useState<ProductTransferOptions | null>(null)
  const [choice, setChoice] = useState<ExportChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<ExportNotes | null>(null)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setError(null); setNotes(null)
    sheetTransferApi.options(context.productId, controller.signal)
      .then(loaded => { setOptions(loaded); setChoice(defaultExportChoice(loaded, context)) })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) })
    return () => controller.abort()
    // The dialog reads the scope it was opened on; a later scope change reopens it.
  }, [open, context.productId]) // eslint-disable-line react-hooks/exhaustive-deps

  const derived = useMemo(() => {
    if (!options || !choice) return null
    const productIds = exportProductIds(options, context, choice.products)
    const destinations = exportDestinations(options, productIds)
    const selection = exportSelection(options, context, choice)
    const languages = exportLanguages(options, context, destinations.filter(d => choice.destinations.includes(d.key)))
    return { productIds, destinations, selection, languages, blocker: exportBlocker(selection) }
  }, [options, choice, context])

  const selectedRows = options ? options.products.filter(p => context.selectedIds.includes(p.id)).length : 0
  const update = (patch: Partial<ExportChoice>) => setChoice(current => current ? { ...current, ...patch } : current)
  const toggleDestination = (key: string) => update({ destinations: choice?.destinations.includes(key) ? choice.destinations.filter(k => k !== key) : [...choice?.destinations ?? [], key] })

  const download = async () => {
    if (!derived || derived.blocker || !choice) return
    setBusy(true); setError(null); setNotes(null)
    try {
      const { filename, notes: exportNotes } = await sheetTransferApi.export(context.productId, { market: context.market, selection: derived.selection,
        ...(choice.columns === 'visible' && visibleFields?.length ? { fields: visibleFields } : {}) })
      toast(`Downloaded ${filename}`, 'success')
      if (exportNotes.total) setNotes(exportNotes)
      else onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} size="md" title="Export" subtitle="Download a file to edit. Import it back when you are done."
      footer={<>
        {onReference && <Button size="sm" variant="ghost" title="A CSV of the table on screen, for reading only. It cannot be imported." onClick={() => { onReference(); onClose() }}>Export table</Button>}
        <span className="grow" />
        <Button size="sm" variant="secondary" onClick={onClose}>{notes ? 'Close' : 'Cancel'}</Button>
        <Button size="sm" variant="primary" disabled={!derived || !!derived.blocker || busy} onClick={download}>{busy ? 'Preparing file…' : 'Download'}</Button>
      </>}>
      <div className={styles.body}>
        {error && <Banner tone="danger" title="The file could not be made">{error}</Banner>}
        {notes && <Banner tone="warning" title="Downloaded. Some things are not in the file">
          <ul className={styles.list}>{notes.notes.map(note => <li key={note}>{note}</li>)}</ul>
          {notes.total > notes.notes.length && <p className={styles.muted}>And {notes.total - notes.notes.length} more.</p>}
        </Banner>}
        {!derived || !choice ? <div className={styles.loading} aria-busy="true"><Skeleton height={28} /><Skeleton height={56} /><Skeleton height={56} /></div> : <>
          <Field label="Products">
            <SegmentedControl ariaLabel="Products" size="sm" wrap value={choice.products} onChange={value => update({ products: value as ExportChoice['products'] })} options={[
              { value: 'product', label: 'This product' },
              { value: 'family', label: `Whole family · ${options!.products.length}` },
              { value: 'selected', label: `Selected rows · ${selectedRows}`, disabled: !selectedRows, title: selectedRows ? undefined : 'Select rows in the sheet first' },
            ]} />
          </Field>
          <Field label="What to include" htmlFor="export-shared">
            <div className={styles.choices}>
              <CheckboxCard id="export-shared" title="Shared details" description="Titles, descriptions and attributes that every channel uses" checked={choice.shared} selected={choice.shared}
                onChange={() => update({ shared: !choice.shared })} />
              {derived.destinations.map(destination => {
                const checked = choice.destinations.includes(destination.key)
                return <CheckboxCard key={destination.key} title={destination.label} checked={checked} selected={checked} onChange={() => toggleDestination(destination.key)}
                  description={[plural(destination.listings, 'listing'), destination.aliases ? plural(destination.aliases, 'extra listing alias', 'extra listing aliases') : '', destination.language ? languageName(destination.language) : ''].filter(Boolean).join(' · ')} />
              })}
              {!derived.destinations.length && <p className={styles.muted}>These products are not listed on a channel yet. The file holds the shared details only.</p>}
            </div>
          </Field>
          <Field label="Columns">
            <SegmentedControl ariaLabel="Columns" size="sm" value={choice.columns} onChange={value => update({ columns: value as ExportChoice['columns'] })} options={[
              { value: 'all', label: 'All columns' },
              { value: 'visible', label: 'Only columns on screen', disabled: !visibleFields?.length },
            ]} />
          </Field>
          <p className={styles.muted}>
            {choice.shared && derived.languages.length ? `Shared text in ${derived.languages.map(languageName).join(', ')}. ` : ''}
            Each channel tab uses its market&apos;s language. Leave a cell as it is to keep it; type #clear to empty it.
          </p>
          {derived.blocker && <p className={styles.warning} role="status">{derived.blocker}</p>}
        </>}
      </div>
    </Modal>
  )
}
