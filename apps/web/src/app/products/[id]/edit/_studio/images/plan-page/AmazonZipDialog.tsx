'use client'

import { useEffect, useRef, useState } from 'react'
import { AMAZON_ARCHIVE_KINDS, type AmazonArchiveKind } from '@nexus/shared/media-plan-archive'
import type { MediaAsset } from '@nexus/shared/media-plan-channels'

import { Banner, Field, Modal, Thumbnail } from '@/design-system/components'
import { Button, SegmentedControl, Select, Spinner } from '@/design-system/primitives'

import { MediaRequestError } from '../ebay/transport'
import { downloadArchive, requestArchivePreview, type DownloadProgress } from './archiveApi'
import { ARCHIVE_LIMITS, archiveKindHint, archiveKindLabel, archiveSummary, busyLabel, filesByAsin, type ArchivePreview } from './archiveModel'
import { destinationLabel, type MediaDestinationRow, type MediaRead } from './model'
import styles from './planPage.module.css'

export interface AmazonZipDialogProps {
  read: MediaRead
  destination: MediaDestinationRow
  assets: Map<string, MediaAsset>
  open: boolean
  /** The market the scope selector points at: the window opens on it (Owner, 2026-09-29: ZIP files by market). */
  initialMarket?: string | null
  /** What it opens on: All Amazon markets, or "Only <market>" when the page shows that market's own photos. */
  initialKind?: AmazonArchiveKind
  onClose(): void
}

type Check = { state: 'checking' } | { state: 'ready'; preview: ArchivePreview } | { state: 'failed'; message: string }

/**
 * Images rebuild P4d — "Export ZIP for Seller Central" (PLAN.md §7.1): one market, one kind (All Amazon markets, safety
 * images, Only <market>: every photo that market shows). The window shows every file the ZIP will hold (ASIN.SLOT.jpg)
 * and the SKUs left out, with the reason; the download is bound to that list, so the ZIP holds exactly what was shown.
 * Nothing is sent to Amazon.
 */
export function AmazonZipDialog({ read, destination: d, assets, open, initialMarket = null, initialKind = 'slots', onClose }: AmazonZipDialogProps) {
  const start = initialMarket && d.markets.includes(initialMarket) ? initialMarket : d.markets[0] ?? ''
  const [market, setMarket] = useState(start)
  const [kind, setKind] = useState<AmazonArchiveKind>(initialKind)
  const [check, setCheck] = useState<Check>({ state: 'checking' })
  const [again, setAgain] = useState(0)
  const [busy, setBusy] = useState(false)
  // Set once the server has answered: the ZIP is made and the file is arriving.
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [failure, setFailure] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  // The answer to Download shows above the list; bring it into view, as the button sits below a list that scrolls.
  const outcome = useRef<HTMLDivElement>(null)
  useEffect(() => { if (failure || saved) outcome.current?.scrollIntoView({ block: 'nearest' }) }, [failure, saved])

  // Each opening starts clean: the answer to an earlier download belongs to that earlier list.
  useEffect(() => { if (open) { setFailure(''); setSaved(null); setMarket(start); setKind(initialKind) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  // A new read of the page (someone edited the photos) or another choice checks the list again.
  useEffect(() => {
    if (!open || !market) return
    const controller = new AbortController()
    setCheck({ state: 'checking' }); setSaved(null)
    requestArchivePreview(read.rootId, { accountId: d.accountId, market, kind }, controller.signal)
      .then(preview => setCheck({ state: 'ready', preview }))
      .catch((error: unknown) => { if (!controller.signal.aborted) setCheck({ state: 'failed', message: error instanceof Error ? error.message : String(error) }) })
    return () => controller.abort()
  }, [open, market, kind, again, read, d.accountId])

  const choose = (next: { market?: string; kind?: AmazonArchiveKind }) => {
    setFailure('')
    if (next.market) setMarket(next.market)
    if (next.kind) setKind(next.kind)
  }
  const preview = check.state === 'ready' ? check.preview : null
  // Until the list arrives, the page's own read names the API's language and first market.
  const hint = archiveKindHint(kind, market, preview?.language ?? null,
    preview ? { language: preview.apiLanguage, market: preview.apiMarket } : { language: d.languages.find(l => l !== 'mul') ?? null, market: d.markets[0] ?? market })
  const canDownload = !!preview && !busy && preview.issues.length === 0 && preview.files.length > 0

  const download = async () => {
    if (!preview || !canDownload) return
    setBusy(true); setProgress(null); setFailure(''); setSaved(null)
    try {
      // One update per whole MB: a 500 MB file arrives in thousands of pieces.
      const blob = await downloadArchive(read.rootId, { accountId: d.accountId, market, kind, digest: preview.digest },
        next => setProgress(prev => prev && Math.floor(prev.received / 1_000_000) === Math.floor(next.received / 1_000_000) && prev.total === next.total ? prev : next))
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = preview.filename
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setSaved(preview.filename)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      // The photos changed since this list: show the new list; the sentence above says why.
      if (error instanceof MediaRequestError && error.status === 409) setAgain(n => n + 1)
    } finally { setBusy(false); setProgress(null) }
  }

  return <Modal open={open} onClose={() => { if (!busy) onClose() }} size="xl" title="Export ZIP for Seller Central"
    subtitle={`${destinationLabel(d)} · Nothing is sent to Amazon.`}
    footer={<>
      <Button size="sm" disabled={busy} onClick={onClose}>Close</Button>
      <Button size="sm" variant="primary" disabled={!canDownload} onClick={() => void download()}>
        {busy ? busyLabel(progress) : preview?.files.length ? `Download ZIP · ${preview.files.length} file${preview.files.length === 1 ? '' : 's'}` : 'Download ZIP'}
      </Button>
    </>}>
    <div className={styles.zipBody}>
      <div className={styles.zipControls}>
        <Field label="Market">
          <Select size="sm" value={market} disabled={busy} onChange={e => choose({ market: e.target.value })}>
            {d.markets.map(m => <option key={m} value={m}>Amazon {m}</option>)}
          </Select>
        </Field>
        <Field label="What to export">
          <SegmentedControl ariaLabel="What to export" size="sm" wrap disabled={busy} value={kind} onChange={value => choose({ kind: value as AmazonArchiveKind })}
            options={AMAZON_ARCHIVE_KINDS.map(k => ({ value: k, label: archiveKindLabel(k, market) }))} />
        </Field>
      </div>
      <p className={styles.zipText}>{hint.holds}</p>
      <Banner tone="info" title="Where to upload it">{hint.upload}</Banner>

      {check.state === 'checking' && <p className={styles.zipStatus} role="status"><Spinner size={14} /> Checking the photos…</p>}
      {check.state === 'failed' && <Banner tone="danger" title="The list could not be made">
        <p className={styles.zipText}>{check.message}</p>
        <Button size="sm" variant="secondary" onClick={() => setAgain(n => n + 1)}>Check again</Button>
      </Banner>}
      {(failure || saved) && <div ref={outcome}>
        {failure && <Banner tone="danger" title="The ZIP could not be made">{failure}</Banner>}
        {saved && <Banner tone="success" title={`Saved ${saved}`}>
          Upload it in Seller Central as described above. Amazon checks the photos there; Nexus did not send them and cannot see Amazon’s result.
        </Banner>}
      </div>}

      {preview && <>
        <p className={styles.zipSummary} role="status">{archiveSummary(preview)}</p>
        <p className={styles.zipLimits}>{ARCHIVE_LIMITS}</p>
        {preview.issues.length > 0 && <Banner tone="danger" title="Fix these on the Media page before downloading">
          <ul className={styles.checkList}>{preview.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
        </Banner>}
        {preview.warnings.length > 0 && <Banner tone="warning" title={`${preview.warnings.length} warning${preview.warnings.length === 1 ? '' : 's'} — the ZIP can still be downloaded`}>
          <ul className={styles.checkList}>{preview.warnings.map(line => <li key={line}>{line}</li>)}</ul>
        </Banner>}
        {preview.skipped.length > 0 && <Banner tone="warning" title={`Left out — ${preview.skipped.length} SKU${preview.skipped.length === 1 ? '' : 's'}`}>
          <ul className={styles.checkList}>{preview.skipped.map(line => <li key={line}>{line}</li>)}</ul>
        </Banner>}
        {preview.files.length > 0 && <ul className={styles.zipGroups} aria-label="Files in the ZIP">
          {filesByAsin(preview.files).map(group => <li key={group.asin} className={styles.zipGroup}>
            <p className={styles.zipGroupHead}><span className={styles.zipName}>{group.asin}</span> <span className={styles.zipSkus}>{group.skus.join(', ')}</span></p>
            <ol className={styles.zipFiles}>
              {group.files.map(file => <li key={file.name} className={styles.zipFile}>
                <Thumbnail src={assets.get(file.assetId)?.url ?? null} alt={file.photo} title={`${file.name} · ${file.photo}`} />
                <span className={styles.zipName}>{file.slot}</span>
                <span className={styles.zipPhoto}>{file.photo}</span>
              </li>)}
            </ol>
          </li>)}
        </ul>}
      </>}
    </div>
  </Modal>
}
