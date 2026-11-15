import { Suspense } from 'react'
import type { Metadata } from 'next'
import { MailTemplateEditorPage } from '../../../../../../../../areas/admin/documents/template-editor/MailTemplateEditorPage'

export const metadata: Metadata = { title: 'E-mail template · Nexus Factory' }

/** Admin › Documents & numbering › an e-mail template's version (SCR-633, B-W2b-432: the words, the preview with made-up values). */
export default async function Page({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params
  return (
    <Suspense>
      <MailTemplateEditorPage templateId={decodeURIComponent(templateId)} />
    </Suspense>
  )
}
