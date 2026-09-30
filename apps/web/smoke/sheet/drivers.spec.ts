import { expect, test } from './fixture'
import { arrowTo } from './drivers'

// This is a test of the driver, independent of the app: a non-wrapping list opens on its stored value.
for (const focus of ['option', 'search'] as const) {
  test(`@sheet driver reaches values above and below the stored value (${focus})`, async ({ page }) => {
    await page.setContent('<div class="ag-popup-editor"><input aria-label="Search"><div role="listbox"><button role="option">Alpha</button><button role="option">Beta</button><button role="option">Gamma</button></div></div>')
    await page.evaluate((mode) => {
      const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      let active = 2
      const paint = () => {
        for (const [index, option] of options.entries()) option.classList.toggle('active', mode === 'search' && index === active)
        if (mode === 'option') options[active].focus()
      }
      document.addEventListener('keydown', (event) => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        active = Math.max(0, Math.min(options.length - 1, active + (event.key === 'ArrowUp' ? -1 : 1)))
        paint()
      })
      if (mode === 'search') document.querySelector('input')!.focus()
      paint()
    }, focus)
    await arrowTo(page, 'Alpha')
    await expect(focus === 'option' ? page.locator('[role="option"]:focus') : page.locator('[role="option"].active')).toHaveText('Alpha')
    await arrowTo(page, 'Gamma')
    await expect(focus === 'option' ? page.locator('[role="option"]:focus') : page.locator('[role="option"].active')).toHaveText('Gamma')
  })
}

import { assertSaved, type Save } from './wire'

test('@sheet driver rejects a refused cell inside a successful unit', () => {
  const save: Pick<Save, 'status' | 'answer'> = { status: 200, answer: { saved: 1, failed: 0, units: [{ key: 'row', status: 200, body: {} }] } }
  expect(() => assertSaved(save, 'clean save')).not.toThrow()
  save.answer.units[0].body.errors = [{ id: 'row', field: 'totalStock', error: 'Choose a default warehouse.' }]
  expect(() => assertSaved(save, 'refused stock')).toThrow('refused cells')
  save.answer.units[0].body.errors = []
  save.answer.units[0].status = 400
  expect(() => assertSaved(save, 'refused unit')).toThrow('unit status')
})
