import { expect, test } from './fixture'
import { armSavedTiming, readSavedTiming, stopSavedTiming, firstEditableScalarMs } from './savedTiming'

async function pageWithStatus(page: import('@playwright/test').Page) {
  await page.setContent('<div class="ag-popup-editor"><input aria-label="Draft"></div><div class="nds-grid-sheet-status"><span class="nds-cell-muted">Saved 12:00</span></div>')
  await page.getByRole('textbox', { name: 'Draft' }).focus()
}

test('@sheet timing control · a prior Saved label cannot confirm a new commit', async ({ page }) => {
  await pageWithStatus(page)
  await armSavedTiming(page)
  try {
    await page.keyboard.press('Enter')
    await expect(readSavedTiming(page, 150)).rejects.toThrow('Saving')
  } finally { await stopSavedTiming(page) }
})

test('@sheet timing control · measures the actual Saving to Saved transition from Enter', async ({ page }) => {
  await pageWithStatus(page)
  await armSavedTiming(page)
  await page.evaluate(() => {
    document.querySelector('input')!.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return
      const status = document.querySelector('.nds-grid-sheet-status')!
      status.innerHTML = '<span class="nds-grid-sheet-status-pending">Saving…</span>'
      setTimeout(() => { status.innerHTML = '<span class="nds-cell-muted">Saved 12:00</span>' }, 25)
    })
  })
  try {
    await page.keyboard.press('Enter')
    const timing = await readSavedTiming(page)
    expect(timing.savedMs).toBeGreaterThanOrEqual(timing.pendingMs)
    expect(timing.pendingMs).toBeGreaterThanOrEqual(0)
    expect(timing.savedMs).toBeGreaterThanOrEqual(20)
  } finally { await stopSavedTiming(page) }
})

test('@sheet timing control · a refusal does not count as a completed save', async ({ page }) => {
  await pageWithStatus(page)
  await armSavedTiming(page)
  await page.evaluate(() => {
    document.querySelector('input')!.addEventListener('keydown', event => {
      if (event.key === 'Enter') document.querySelector('.nds-grid-sheet-status')!.innerHTML = '<span class="nds-grid-sheet-status-refused">1 refused</span>'
    })
  })
  try {
    await page.keyboard.press('Enter')
    await expect(readSavedTiming(page)).rejects.toThrow('refused')
  } finally { await stopSavedTiming(page) }
})

test('@sheet timing control · an offline result cannot reuse the old Saved label', async ({ page }) => {
  await pageWithStatus(page)
  await armSavedTiming(page)
  try {
    await page.keyboard.press('Enter')
    await page.evaluate(() => { document.querySelector('.nds-grid-sheet-status')!.innerHTML = '<span class="nds-grid-sheet-status-pending">Saving…</span>' })
    await page.evaluate(() => { document.querySelector('.nds-grid-sheet-status')!.innerHTML = '<span class="nds-grid-sheet-note offline">Connection lost — reconnecting…</span><span class="nds-cell-muted">Saved 12:00</span>' })
    await expect(readSavedTiming(page)).rejects.toThrow('unconfirmed')
  } finally { await stopSavedTiming(page) }
})

test('@sheet timing control · Saved column layout unavailable is not a save confirmation', async ({ page }) => {
  await pageWithStatus(page)
  await armSavedTiming(page)
  try {
    await page.keyboard.press('Enter')
    await page.evaluate(() => { document.querySelector('.nds-grid-sheet-status')!.innerHTML = '<span class="nds-grid-sheet-status-pending">Saving…</span>' })
    await page.evaluate(() => { document.querySelector('.nds-grid-sheet-status')!.innerHTML = '<span class="nds-grid-sheet-note provenance">Saved column layout unavailable</span>' })
    await expect(readSavedTiming(page, 150)).rejects.toThrow('Saving')
  } finally { await stopSavedTiming(page) }
})

for (const readonly of [false, true]) test(`@sheet first edit control · requires a focused writable editor (readonly=${readonly})`, async ({ page }) => {
  await page.setContent('<div id="cell" tabindex="0" role="gridcell">Before</div>')
  await page.evaluate(readonly => {
    document.body.dataset.commits = '0'
    const cell = document.querySelector<HTMLElement>('#cell')!
    document.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target === cell) {
        const popup = document.createElement('div')
        popup.className = 'ag-popup-editor'
        const input = document.createElement('input')
        input.value = 'Before'
        input.readOnly = readonly
        popup.append(input); document.body.append(popup); input.focus()
      } else if (event.key === 'Enter') document.body.dataset.commits = String(Number(document.body.dataset.commits) + 1)
      else if (event.key === 'Escape') { document.querySelector('.ag-popup-editor')?.remove(); cell.focus() }
    })
  }, readonly)
  const result = firstEditableScalarMs(page, page.getByRole('gridcell'), 150)
  if (readonly) await expect(result).rejects.toThrow(/editable/i)
  else expect(Number.isFinite(await result)).toBe(true)
  await expect(page.locator('.ag-popup-editor')).toHaveCount(0)
  expect(await page.locator('body').getAttribute('data-commits')).toBe('0')
})
