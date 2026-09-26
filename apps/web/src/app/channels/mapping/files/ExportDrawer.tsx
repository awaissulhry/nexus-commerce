'use client'

/**
 * CHMAP — write a channel file (Amazon's own `.xlsm` template, or our eBay `.xlsx` workbook) for chosen
 * products, through an ACTIVE mapping version. The server re-checks everything; its refusal is shown
 * word for word, and a refusal that an uploaded template answers offers the upload right here.
 */
import { useState } from 'react'
import type { MappingSetSummary } from '@nexus/shared/channel-mapping'
import { Button, Textarea, Toggle } from '@/design-system/primitives'
import { Banner, Drawer, Field, useToast } from '@/design-system/components'
import { num } from '@/design-system/lib/format'
import { errorText, exportMappingSet, saveFile } from './api'
import { exportSummarySentence, formLabel, needsTemplateUpload, parseSkus, type TemplateUploadResult } from './model'
import { TemplateUpload } from './TemplateUpload'
import styles from './files.module.css'

export function ExportDrawer({ set, onClose, onTemplateUploaded }: {
  set: MappingSetSummary
  onClose: () => void
  onTemplateUploaded: (result: TemplateUploadResult) => void
}) {
  const { toast } = useToast()
  const amazon = set.channel === 'AMAZON'
  const [text, setText] = useState('')
  const [includePrices, setIncludePrices] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ file: string; summary: string } | null>(null)
  // Stays offered once a refusal asked for the template, so the upload's own answer stays on screen.
  const [offerUpload, setOfferUpload] = useState(false)
  const skus = parseSkus(text)

  const run = async () => {
    setBusy(true); setError(null); setDone(null)
    try {
      const out = await exportMappingSet(set.id, amazon ? { skus, includePrices } : { skus })
      const file = out.filename ?? `${formLabel(set)} v${set.version}.${amazon ? 'xlsm' : 'xlsx'}`
      saveFile(out.blob, file)
      const summary = out.summary
        ? exportSummarySentence(out.summary, num)
        : 'The file was written; the server sent no summary of what it holds.'
      setDone({ file, summary })
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
          {busy ? 'Writing the file…' : `Export ${amazon ? '.xlsm' : '.xlsx'}`}
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
        {error && <Banner tone="danger" title="The export was refused">{error}</Banner>}
        {offerUpload && (
          <section className={styles.section} aria-label="Upload the Amazon template">
            <h3 className={styles.sectionTitle}>Upload the Amazon template, then export again</h3>
            <TemplateUpload onUploaded={result => { setError(null); onTemplateUploaded(result) }} />
          </section>
        )}
        {done && <Banner tone="success" title={`Downloaded ${done.file}`}>{done.summary}</Banner>}
      </div>
    </Drawer>
  )
}
