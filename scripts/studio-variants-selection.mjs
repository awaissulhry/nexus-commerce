/** Selection and channel inclusion are independent. Both Variants states must use gridSelection(). */
export async function assertVariantsSelection(page) {
  const errors = []
  const boxes = await page.locator('.ag-row[row-id]').evaluateAll(rows => rows.map(row => {
    const selection = row.querySelector('.ag-selection-checkbox input')
    const identity = row.querySelector('[col-id="identity"], [col-id="__identity"]')
    return { id: row.getAttribute('row-id'), selection: !!selection,
      beforeIdentity: !!selection && !!identity && selection.getBoundingClientRect().right <= identity.getBoundingClientRect().left,
      selectionWidth: selection?.closest('.ag-cell')?.getBoundingClientRect().width }
  }))
  if (!boxes.length) errors.push('No variant rows measured')
  for (const row of boxes) if (!row.selection || !row.beforeIdentity || row.selectionWidth !== 43) errors.push(`${row.id}: selection must occupy 43px before the identity band`)
  const header = page.getByRole('checkbox', { name: 'Column with Header Selection', exact: true })
  if (await header.count() !== 1) return [...errors, 'Exactly one selection checkbox is required in the header']
  const read = () => page.evaluate(() => ({
    top: document.querySelector('.ag-header')?.getBoundingClientRect().top,
    included: [...document.querySelectorAll('.ag-row input[type=checkbox]')].filter(e => !e.closest('.ag-selection-checkbox')).map(e => [e.getAttribute('aria-label'), e.checked]),
    selected: [...document.querySelectorAll('.ag-row .ag-selection-checkbox input')].filter(e => e.checked).length,
  }))
  const before = await read()
  await header.click()
  const selected = await read()
  if (selected.selected !== boxes.length) errors.push(`Header selected ${selected.selected}/${boxes.length} rendered rows`)
  if (JSON.stringify(selected.included) !== JSON.stringify(before.included)) errors.push('Selecting rows changed inclusion')
  if (selected.top !== before.top) errors.push('Selection pushed the grid down')
  const clear = page.getByRole('button', { name: 'Clear selection', exact: true })
  if (await clear.count()) await clear.click()
  else await page.getByRole('button', { name: 'Clear', exact: true }).click()
  if ((await read()).selected !== 0) errors.push('Clear left rows selected')
  return errors
}
