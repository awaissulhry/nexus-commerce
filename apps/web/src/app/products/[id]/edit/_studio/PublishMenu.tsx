'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/design-system/primitives'
import { useStudioProduct, useStudioScope } from './contracts'
import { PublishDialog } from './publication/PublishDialog'

/** Publishing is available on every studio tab and keeps the selected destination. */
export function PublishMenu() {
  const product = useStudioProduct()
  const { canChangeEditor } = useStudioScope()
  const [open, setOpen] = useState(false)
  const [unsavedEditor, setUnsavedEditor] = useState(false)
  return <>
    <Button size="sm" variant="primary" disabled={!!product.deletedAt} onClick={() => { setUnsavedEditor(canChangeEditor?.() === false); setOpen(true) }}><Send size={14} aria-hidden />Publish</Button>
    {open && <PublishDialog unsavedEditor={unsavedEditor} onClose={() => setOpen(false)} />}
  </>
}
