'use client'

/**
 * CHMAP — write a channel file (Amazon's own `.xlsm` template, our eBay `.xlsx` workbook, or — NCF — Shopify's own
 * product `.csv`) for chosen products, through an ACTIVE mapping version. The server re-checks everything; its refusal is shown
 * word for word, and a refusal that an uploaded template answers offers the upload right here.
 */
import { useState } from 'react'
import type { MappingSetSummary } from '@nexus/shared/channel-mapping'
import { Button, Textarea, Toggle } from '@/design-system/primitives'
import { Banner, Drawer, Field, useToast } from '@/design-system/components'
import { num } from '@/design-system/lib/format'
import { errorText, exportMappingSet, saveFile } from './api'
import { exportExtension, exportSummarySentence, formLabel, needsTemplateUpload, parseSkus, shopifyExportSummarySentence, truncatedSentence, type ExportSummary, type TemplateUploadResult } from './model'
import { TemplateUpload } from './TemplateUpload'
import styles from './files.module.css'

export function ExportDrawer({ set, onClose, onTemplateUploaded }: {
  set: MappingSetSummary
  onClose: () => void
  onTemplateUploaded: (result: TemplateUploadResult) => void
}) {
  const { toast } = useToast()
  const amazon = set.channel === 'AMAZON'
  const shopify = set.channel === 'SHOPIFY'
  const extension = exportExtension(set)
  const [text, setText] = useState('')
  const [includePrices, setIncludePrices] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ file: string; summary: string; details: ExportSummary | null } | null>(null)
  // Stays offered once a refusal asked for the template, so the upload's own answer stays on screen.
  const [offerUpload, setOfferUpload] = useState(false)
  const skus = parseSkus(text)

  const run = async () => {
    setBusy(true); setError(null); setDone(null)
    try {
      const out = await exportMappingSet(set.id, amazon || shopify ? { skus, includePrices } : { skus })
      const file = out.filename ?? `${formLabel(set)} v${set.version}${extension}`
      saveFile(out.blob, file)
      const summary = out.summary
        ? (shopify ? shopifyExportSummarySentence(out.summary, num) : exportSummarySentence(out.summary, num))
        : 'The file was written; the server sent no summary of what it holds.'
      setDone({ file, summary, details: out.summary })
      toast(summary, 'success', { duration: 8000 })
    } catch (e) {
      const message = errorText(e)
      setError(message)
      if (amazon && needsTemplateUpload(message)) setOfferUpload(true)
    } finally { setBusy(false) }
  }

  return (
    <Drawer open onClose={onClose} width={560} title="Export a file" subtitle={`${formLabel(set)} · v${set.version} (active)`}
      footer={<>
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={busy || skus.length === 0} onClick={() => void run()}>
          {busy ? 'Writing the file…' : `Export ${extension}`}
        </Button>
      </>}>
      <div className={styles.drawerBody}>
        <Field label="Product SKUs" required
          hint="One per line or separated by commas. Each SKU brings its whole product group: the parent and every variation.">
          <Textarea rows={6} value={text} onChange={event => { setText(event.target.value); setError(null) }} placeholder="GALE-JACKET" />
        </Field>
        <p className={styles.plain} role="status">{skus.length ? `${num(skus.length)} SKU${skus.length === 1 ? '' : 's'}: ${skus.slice(0, 6).join(', ')}${skus.length > 6 ? ', …' : ''}` : 'No SKU yet.'}</p>
        {amazon && (
          <Field label="Include prices" hint="The file is always a partial update: a blank cell keeps Amazon's value.">
            <Toggle checked={includePrices} onChange={setIncludePrices} />
          </Field>
        )}
        {shopify && (
          <>
            <Field label="Include prices" hint="Price and compare-at price, as Nexus recorded them. Off: the columns are left out and Shopify keeps its prices.">
              <Toggle checked={includePrices} onChange={setIncludePrices} />
            </Field>
            <p className={styles.plain}>Only products Nexus links to Shopify are written. A column Nexus cannot fill for every product is left out, so Shopify keeps its values; handle, title, status and every option are always written. Upload it in Shopify with “Overwrite products with matching handles” ticked.</p>
          </>
        )}
        {error && <Banner tone="danger" title="The export was refused">{error}</Banner>}
        {offerUpload && (
          <section className={styles.section} aria-label="Upload the Amazon template">
            <h3 className={styles.sectionTitle}>Upload the Amazon template, then export again</h3>
            <TemplateUpload onUploaded={result => { setError(null); onTemplateUploaded(result) }} />
          </section>
        )}
        {done && <Banner tone="success" title={`Downloaded ${done.file}`}>{done.summary}</Banner>}
        {done?.details?.refused && done.details.refused.length > 0 && (
          <Banner tone="warning" title={`Not written (${num(done.details.gaps)})`}>
            <ul className={styles.keyList}>{done.details.refused.map((r, i) => <li key={i}>{r.sku}: {r.reason}</li>)}</ul>
          </Banner>
        )}
        {/* B4 — warn, not refuse (the Owner's decision): the items past the template's last column are not in the file. */}
        {done?.details?.truncated && done.details.truncated.count > 0 && (
          <Banner tone="warning" title={`Lists longer than the template (${num(done.details.truncated.count)})`}>
            <ul className={styles.keyList}>{done.details.truncated.items.map((t, i) => <li key={i}>{truncatedSentence(t, num)}</li>)}</ul>
            {done.details.truncated.count > done.details.truncated.items.length && <p className={styles.plain}>And {num(done.details.truncated.count - done.details.truncated.items.length)} more.</p>}
          </Banner>
        )}
        {done?.details?.notes && done.details.notes.count > 0 && (
          <Banner tone="info" title={`Before you upload (${num(done.details.notes.count)})`}>
            <ul className={styles.keyList}>{done.details.notes.items.map((n, i) => <li key={i}>{n}</li>)}</ul>
            {done.details.notes.count > done.details.notes.items.length && <p className={styles.plain}>And {num(done.details.notes.count - done.details.notes.items.length)} more.</p>}
          </Banner>
        )}
      </div>
    </Drawer>
  )
}
