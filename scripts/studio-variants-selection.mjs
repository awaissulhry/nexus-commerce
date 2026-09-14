/** Selection and channel inclusion are independent. Both Variants states must use gridSelection(). */
export async function assertVariantsSelection(page) {
  const errors = []
  // AG renders a separate row fragment for pinned columns. Measure one logical row across
  // all fragments; a center fragment does not own the pinned identity/selection cells.
  const measure = () => page.locator('.ag-row[row-id]').evaluateAll(rows => {
    const groups = new Map()
    for (const row of rows) {
      const id = row.getAttribute('row-id')
      groups.set(id, [...(groups.get(id) ?? []), row])
    }
    return [...groups].map(([id, fragments]) => {
      const selection = fragments.flatMap(row => [...row.querySelectorAll('.ag-selection-checkbox input')])
      const identity = fragments.flatMap(row => [...row.querySelectorAll('[col-id="identity"], [col-id="__identity"]')])
      return { id, selection: selection.length === 1, identityCount: identity.length,
        selectionRight: selection[0]?.closest('.ag-cell')?.getBoundingClientRect().right, identityLeft: identity[0]?.getBoundingClientRect().left,
        beforeIdentity: selection.length === 1 && identity.length === 1 && selection[0].closest('.ag-cell').getBoundingClientRect().right <= identity[0].getBoundingClientRect().left,
        selectionWidth: selection[0]?.closest('.ag-cell')?.getBoundingClientRect().width }
    })
  })
  // NexusGrid pins selection on the next tick; AG then animates the identity column.
  // Wait for the actual band boundary, retaining the same assertion on timeout.
  let boxes = await measure()
  const deadline = Date.now() + 2000
  while (boxes.some(row => !row.beforeIdentity) && Date.now() < deadline) {
    await page.waitForTimeout(50)
    boxes = await measure()
  }
  if (!boxes.length) errors.push('No variant rows measured')
  for (const row of boxes) if (!row.selection || !row.beforeIdentity || row.selectionWidth !== 43) errors.push(`${row.id}: selection must occupy 43px before the identity band (${JSON.stringify(row)})`)
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
