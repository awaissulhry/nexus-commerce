import { Suspense } from 'react'
import type { Metadata } from 'next'
import { DocTemplateEditorPage } from '../../../../../../../../areas/admin/documents/template-editor/DocTemplateEditorPage'

export const metadata: Metadata = { title: 'Document template · Nexus Factory' }

/** Admin › Documents & numbering › a document template's version (SCR-631, B-W2b-432: the builder page, its PDF beside it). */
export default async function Page({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params
  return (
    <Suspense>
      <DocTemplateEditorPage templateId={decodeURIComponent(templateId)} />
    </Suspense>
  )
}
