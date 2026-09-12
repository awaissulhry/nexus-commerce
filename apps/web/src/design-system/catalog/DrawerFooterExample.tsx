'use client'

import { useState } from 'react'
import { Drawer } from '../components/Drawer'
import { Disclosure } from '../components/Disclosure'
import { Button } from '../primitives/Button'

export function DrawerFooterExample() {
  const [open, setOpen] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  return <section id="drawer-footer-example">
    <h3>Responsive drawer actions</h3>
    <Button onClick={() => setOpen(true)}>Open drawer with multiple actions</Button>
    <Drawer open={open} title="Review example" onClose={() => setOpen(false)} footer={<>
      <Button onClick={() => setOpen(false)}>Close example</Button>
      <Button onClick={() => setOpen(false)}>Back to examples</Button>
      <Button variant="primary" onClick={() => setOpen(false)}>Finish this review example</Button>
    </>}>
      Footer actions wrap within narrow panels. Resize the viewport to 390px and verify every action stays visible while the body scrolls.
    </Drawer>
    <Button onClick={() => setKeyboardOpen(true)}>Open drawer with collapsed actions</Button>
    <Drawer open={keyboardOpen} title="Drawer keyboard navigation" onClose={() => setKeyboardOpen(false)}>
      <p>Shift+Tab from Close must wrap to the visible summary below. Expand it, then verify the action joins the tab sequence. Escape returns to the opener.</p>
      <Button>Visible action</Button>
      <Disclosure summary="Additional actions"><Button>Action inside collapsed content</Button></Disclosure>
    </Drawer>
  </section>
}
