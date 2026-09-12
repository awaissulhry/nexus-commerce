'use client'

import { useState } from 'react'
import { Drawer } from '../components/Drawer'
import { Button } from '../primitives/Button'

export function EmbeddedDrawerExample() {
  const [open, setOpen] = useState(false)
  return <section id="embedded-drawer-example">
    <h3>Embedded editor</h3>
    <p>The editor stays within its host. Workspace navigation remains visible and Escape only closes the editor when focus is inside it.</p>
    <Button onClick={() => setOpen(true)}>Open embedded editor</Button>
    <div style={{ height: 260, marginTop: 'var(--nds-space-12)' }}>
      <Drawer mode="embedded" open={open} onClose={() => setOpen(false)} title="Embedded editor" footer={<Button onClick={() => setOpen(false)}>Close editor</Button>}>
        This uses the shared drawer header, scrolling body and footer without covering the page.
      </Drawer>
    </div>
  </section>
}
