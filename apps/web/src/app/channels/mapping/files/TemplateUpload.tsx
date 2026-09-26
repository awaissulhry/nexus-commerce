'use client'

/**
 * CHMAP — store an Amazon template once. Nexus keeps the file as the export base and finds (or makes)
 * the mapping version it reads with. Used in its own drawer from the list header, and inline where an
 * export was refused because Nexus does not hold the template.
 */
import { useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Banner, Drawer, FileDropzone } from '@/design-system/components'
import { errorText, uploadAmazonTemplate } from './api'
import { templateResultSentence, type TemplateUploadResult } from './model'
import styles from './files.module.css'

const MAX_BYTES = 10 * 1024 * 1024 // the server's own limit (`request.file({ limits: { fileSize } })`)

export function TemplateUpload({ onUploaded }: { onUploaded: (result: TemplateUploadResult) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TemplateUploadResult | null>(null)

  const upload = async (file: File) => {
    setBusy(file.name); setError(null); setResult(null)
    try {
      const stored = await uploadAmazonTemplate(file)
      setResult(stored)
      onUploaded(stored)
    } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  return (
    <div className={styles.section}>
      <FileDropzone accept=".xlsm,.xlsx" maxBytes={MAX_BYTES} disabled={busy != null}
        hint="The .xlsm or .xlsx template you downloaded from Seller Central · up to 10MB"
        onFiles={files => { if (files[0]) void upload(files[0]) }} />
      {busy && <p className={styles.plain} role="status">Storing {busy}…</p>}
      {error && <Banner tone="danger" title="The template was refused">{error}</Banner>}
      {result && (
        <Banner tone="success" title="Template stored">{templateResultSentence(result)}</Banner>
      )}
      {result && result.warnings.length > 0 && (
        <Banner tone="warning" title={`${result.warnings.length} note${result.warnings.length === 1 ? '' : 's'} on this template`}>
          <ul className={styles.keyList}>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Banner>
      )}
    </div>
  )
}

export function TemplateUploadDrawer({ onClose, onUploaded }: { onClose: () => void; onUploaded: (result: TemplateUploadResult) => void }) {
  return (
    <Drawer open onClose={onClose} width={520} title="Upload an Amazon template"
      subtitle="Nexus keeps it as the base for exports and shows the mapping version it reads with."
      footer={<Button onClick={onClose}>Close</Button>}>
      <div className={styles.drawerBody}>
        <TemplateUpload onUploaded={onUploaded} />
      </div>
    </Drawer>
  )
}
