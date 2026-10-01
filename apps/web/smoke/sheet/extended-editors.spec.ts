import { expect, test as base } from './fixture'
import { focusCell, readSheet } from './grid'
import { clickAway, editorSeed, editorScope, openEditorFixture, reloadEditorFixture, restoreEditorValue, rowIn, storedEditorProducts, storedReceipt, truthfulCleanup } from './extendedFixture'
import { assertSaved, Wire, type Save } from './wire'
import type { ProductMediaWorkspace } from '@nexus/shared/product-media'
import type { Request } from '@playwright/test'
import { browserMutation } from './browserRequest'
import { NetworkMetrics } from './metrics'

const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(`page: ${error.message}`))
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
    try { await use(errors) }
    finally {
      if (errors.length) await info.attach('browser-errors', { body: JSON.stringify(errors), contentType: 'application/json' })
      expect(errors, 'all browser errors remain visible').toEqual([])
    }
  }, { auto: true }],
})

const seed = editorSeed(), scope = editorScope(seed), product = seed.children[0]
const modes = [
  { name: 'desktop light', colorScheme: 'light', viewport: { width: 1680, height: 1000 } },
  { name: 'desktop dark', colorScheme: 'dark', viewport: { width: 1680, height: 1000 } },
  { name: 'phone light', colorScheme: 'light', viewport: { width: 390, height: 844 } },
  { name: 'phone dark', colorScheme: 'dark', viewport: { width: 390, height: 844 } },
] as const

for (const mode of modes) test.describe(`@sheet supplemental editors · ${mode.name}`, () => {
  test.use({ colorScheme: mode.colorScheme, viewport: mode.viewport })
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('nexus:theme', theme), mode.colorScheme)
    expect(page.viewportSize()).toEqual(mode.viewport)
  })

  for (const editor of ['record', 'protectors', 'native long text'] as const) test(`${editor} stores every supported gesture`, async ({ page }) => {
    const key = editor === 'record' ? 'p3composition' : editor === 'protectors' ? 'impactProtectors' : 'p3note'
    const openedScope = editor === 'native long text' ? { ...scope, page: scope.page.replace('tab=sheet', 'tab=variants') } : scope
    const initial = await openEditorFixture(page, seed, openedScope)
    const column = initial.columns.find(column => column.key === key)
    expect(column?.editable).toBe(true)
    const original = rowIn(initial, product).values[key].value
    const allBefore = await storedEditorProducts(seed)
    const sqlBefore = allBefore.find(row => row.id === product)!
    // An axis value is also kept in the variant's one variation store (R-23; seed-sheet-editor-fixture.mts).
    const isAxis = allBefore.find(row => row.id === seed.family)!.variationAxes.includes(key)
    const wire = new Wire(page)
    const quiet = new NetworkMetrics(page)
    let lastExpected: unknown = original
    let bodyFailed = true
    try {
      for (const [index, gesture] of ['keyboard', 'mouse', 'paste'].entries()) {
        const before = await readSheet(page, scope, seed.workspace)
        const current = rowIn(before, product)
        const expectedVersion = current.version
        const previous = current.values[key].value
        const text = `P3 ${mode.name} ${gesture} ${index}`
        const expected = editor === 'record'
          ? (previous as Array<Record<string, unknown>>).map((record, i) => i ? record : { ...record, material: text })
          : editor === 'protectors'
            ? (previous as Array<Record<string, string>>).map((record, i) => i ? record : { ...record, level: text })
            : `${text}\nThe second line stays in the value`
        const cell = await focusCell(page, product, key)
        const mark = wire.mark()
        if (editor === 'record' && gesture === 'paste') {
          // This branch has a real JSON valueParser. Pasting a full record array is a cell gesture: the operator selects
          // the cell, then pastes (drivers.ts `paste`). AG pastes ONE value into the active cell RANGE, not the focused
          // cell (ag-grid-enterprise ClipboardService.isPasteSingleValueIntoRange), so the range must be this cell alone —
          // an api focus leaves the range where the mouse arm clicked away to.
          await cell.click({ position: { x: 6, y: 6 } })
          await expect.poll(() => page.evaluate(() => {
            const api = (window as unknown as { __sweepApi: { getCellRanges(): Array<{ startRow?: { rowIndex: number }; endRow?: { rowIndex: number }; columns: Array<{ getColId(): string }> }> | null
              getDisplayedRowAtIndex(index: number): { data?: { id?: string } } | undefined } }).__sweepApi
            return (api.getCellRanges() ?? []).map(range => ({ start: api.getDisplayedRowAtIndex(range.startRow?.rowIndex ?? -1)?.data?.id,
              end: api.getDisplayedRowAtIndex(range.endRow?.rowIndex ?? -1)?.data?.id, columns: range.columns.map(column => column.getColId()) }))
          }), { message: 'the paste target is the one selected cell' }).toEqual([{ start: product, end: product, columns: [key] }])
          await page.evaluate(value => navigator.clipboard.writeText(value), JSON.stringify(expected))
          await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(JSON.stringify(expected))
          await page.keyboard.press('ControlOrMeta+V')
        } else {
          if (gesture === 'mouse') await cell.dblclick()
          else await page.keyboard.press('Enter')
          const popup = page.locator('.ag-popup-editor')
          await expect(popup).toBeVisible()
          const input = editor === 'record' ? popup.getByRole('textbox', { name: 'Material code' }).first()
            : editor === 'protectors' ? popup.getByRole('textbox', { name: 'Protector 1 level' })
              : popup.locator('.ag-large-text-input textarea')
          if (editor === 'native long text') {
            // The actual Variants host omits formula wiring. Verify its native editor, not a mocked feature flag.
            expect(await page.evaluate(key => {
              const api = (window as unknown as { __sweepApi: { getColumnDef(key: string): { cellEditor?: unknown; cellEditorSelector?: unknown } } }).__sweepApi
              const definition = api.getColumnDef(key)
              return { editor: definition.cellEditor, hasSelector: !!definition.cellEditorSelector }
            }, key)).toEqual({ editor: 'agLargeTextCellEditor', hasSelector: false })
          }
          await expect(input).toBeEditable()
          if (gesture === 'paste') {
            // Impact paste is explicitly INSIDE its text field. It is not unsupported whole-cell JSON paste.
            await input.focus()
            await page.keyboard.press('ControlOrMeta+A')
            await page.evaluate(value => navigator.clipboard.writeText(value), String(editor === 'native long text' ? expected : text))
            await page.keyboard.press('ControlOrMeta+V')
          } else await input.fill(String(editor === 'native long text' ? expected : text))
          if (gesture === 'mouse') await clickAway(page, cell)
          // Native AG large text commits on Enter; Ctrl/Meta+Enter is its selected-range bulk command.
          else await page.keyboard.press('Enter')
        }
        const saved = await wire.one(mark, `${editor} ${gesture}`)
        assertSaved(saved, `${editor} ${gesture}`)
        expect(saved.body.units).toHaveLength(1)
        expect(saved.body.units[0].expectedVersion).toBe(expectedVersion)
        expect(saved.body.units[0].changes).toHaveLength(1)
        const wireCell = current.values[key]
        expect(saved.body.units[0].changes[0]).toEqual(JSON.parse(JSON.stringify({ id: product, field: column!.writeField, value: expected,
          contentAddress: wireCell.contentAddress, contentVersion: 'contentVersion' in wireCell ? wireCell.contentVersion : undefined })))
        expect(saved.request.headers()['x-nexus-workspace-id']).toBe(seed.workspace)
        expect(saved.body.units[0].marketplaceContexts).toEqual([{ marketplace: 'IT', locale: 'it' }])
        expect((saved.answer as Save['answer'] & { operationId?: string }).operationId).toBe(saved.body.operationId)
        expect(saved.answer.units[0].key).toBe(saved.body.units[0].key)
        expect(rowIn(await readSheet(page, scope, seed.workspace), product).values[key].value).toEqual(expected)
        const allStored = await storedEditorProducts(seed)
        const stored = allStored.find(row => row.id === product)!
        // The exact stored row: only this value moved (and, for an axis, its copy in the variation store); one version step.
        const attributes = sqlBefore.categoryAttributes ?? {}
        expect(stored.categoryAttributes).toEqual(editor === 'protectors' ? sqlBefore.categoryAttributes : { ...attributes, [key]: expected,
          ...(isAxis ? { variations: { ...(attributes.variations as Record<string, unknown>), [key]: expected } } : {}) })
        expect(stored.impactProtectors).toEqual(editor === 'protectors' ? expected : sqlBefore.impactProtectors)
        expect(stored.localizedContent).toEqual(sqlBefore.localizedContent)
        expect(stored.version).toBe(expectedVersion + 1)
        expect(allStored.filter(row => row.id !== product)).toEqual(allBefore.filter(row => row.id !== product))
        expect(saved.answer.units[0].body).toMatchObject({ success: true, updated: 1, cascadeCount: 0, affectedChildren: 0, currentVersion: stored.version, versionOf: 'product' })
        const receipt = await storedReceipt(seed, saved.answer.units[0].body.operationId)
        expect(receipt).toMatchObject({ workspaceId: seed.workspace, status: 'SUCCESS', changeCount: 1, productCount: 1, expectedVersion, cascadeCount: 0, affectedChildren: [] })
        expect(receipt.changes).toHaveLength(1)
        expect(receipt.changes[0]).toMatchObject({ id: product, field: column!.writeField, value: expected })
        expect(rowIn(await readSheet(page, scope, seed.workspace), product).version).toBe(stored.version)
        lastExpected = expected
        await page.screenshot({ path: test.info().outputPath(`${editor.replace(/ /g, '-')}-${gesture}.png`), fullPage: false })
      }
      await reloadEditorFixture(page, seed)
      const readOnlyMark = wire.mark()
      await focusCell(page, product, key)
      await page.keyboard.press('Enter')
      const reopened = page.locator('.ag-popup-editor')
      if (editor === 'native long text') await expect(reopened.locator('.ag-large-text-input textarea')).toHaveValue(String(lastExpected))
      else if (editor === 'record') {
        const records = lastExpected as Array<Record<string, unknown>>
        await expect(reopened.locator('[data-record]')).toHaveCount(records.length)
        for (const [index, record] of records.entries()) {
          await expect(reopened.getByRole('textbox', { name: 'Material code' }).nth(index)).toHaveValue(String(record.material))
          await expect(reopened.getByRole('spinbutton', { name: 'Percentage' }).nth(index)).toHaveValue(String(record.percentage))
        }
      } else for (const [index, record] of (lastExpected as Array<Record<string, string>>).entries()) {
        for (const field of ['zone', 'standard', 'level']) await expect(reopened.getByRole('textbox', { name: `Protector ${index + 1} ${field}` })).toHaveValue(record[field])
      }
      await page.screenshot({ path: test.info().outputPath(`${editor.replace(/ /g, '-')}-reloaded.png`) })
      await page.keyboard.press('Escape')
      await quiet.settle()
      await wire.none(readOnlyMark, 'reopen and cancel must not write')
      expect(wire.mark()).toBe(3)
      wire.assertLoopback()
      bodyFailed = false
    } finally {
      await truthfulCleanup(bodyFailed, async () => {
        await page.keyboard.press('Escape').catch(() => {})
        await quiet.settle()
        await restoreEditorValue(page, seed, product, key, original)
        const allRestored = await storedEditorProducts(seed), restored = allRestored.find(row => row.id === product)!
        expect(allRestored.filter(row => row.id !== product)).toEqual(allBefore.filter(row => row.id !== product))
        expect(restored.categoryAttributes).toEqual(sqlBefore.categoryAttributes)
        expect(restored.impactProtectors).toEqual(sqlBefore.impactProtectors)
        expect(restored.localizedContent).toEqual(sqlBefore.localizedContent)
      })
    }
  })

  test('axes reorder binds the family revision and preserves child values', async ({ page }) => {
    const initial = await openEditorFixture(page, seed)
    const column = initial.columns.find(column => column.kind === 'variationTheme')
    expect(column).toBeTruthy()
    const endpoint = `/backend/api/products/${seed.family}/studio/variation-axes?market=IT`
    const headers = { 'x-nexus-workspace-id': seed.workspace }
    const readAxes = async () => {
      const response = await page.request.get(endpoint, { headers, maxRedirects: 0 })
      expect(response.status()).toBe(200)
      return await response.json() as { product: { version: number }; axes: string[]; childIds: string[] }
    }
    const before = await readAxes(), storedBefore = await storedEditorProducts(seed)
    const quiet = new NetworkMetrics(page)
    const writes: Request[] = []
    page.on('request', request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith('/studio/variation-axes')) writes.push(request) })
    expect(before.axes).toHaveLength(2)
    const expected = [...before.axes].reverse()
    let bodyFailed = true
    try {
      const cell = await focusCell(page, seed.family, column!.key)
      await page.keyboard.press('Enter')
      const panel = page.getByRole('group', { name: 'Variation theme — Shared product', exact: true })
      await expect(panel).toBeVisible()
      const responsePromise = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname.endsWith('/studio/variation-axes'))
      await panel.getByRole('button', { name: /^Move .+ down$/ }).first().click()
      await panel.focus()
      await page.keyboard.press('Enter')
      const response = await responsePromise
      expect(response.status()).toBe(200)
      expect(response.request().headers()['x-nexus-workspace-id']).toBe(seed.workspace)
      expect(response.request().postDataJSON()).toEqual({ version: before.product.version, axes: expected, childIds: before.childIds, market: 'IT' })
      expect((await readAxes()).axes).toEqual(expected)
      const after = await storedEditorProducts(seed)
      expect(after.find(row => row.id === seed.family)?.variationAxes).toEqual(expected)
      expect((await response.json()).version).toBe(after.find(row => row.id === seed.family)?.version)
      expect(after.filter(row => row.parentId)).toEqual(storedBefore.filter(row => row.parentId))
      await expect(cell).toBeVisible()
      await reloadEditorFixture(page, seed)
      await focusCell(page, seed.family, column!.key)
      await page.keyboard.press('Enter')
      const reopened = page.getByRole('group', { name: 'Variation theme — Shared product', exact: true })
      await expect(reopened).toBeVisible()
      expect(await reopened.getByRole('button', { name: /^Move .+ up$/ }).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
        .toEqual(['Move P3 size up', 'Move P3 note up'])
      await page.screenshot({ path: test.info().outputPath('axes-reloaded.png') })
      await page.keyboard.press('Escape')
      await quiet.settle()
      expect(writes, 'only one axis write, including after reload/reopen/cancel').toHaveLength(1)
      expect((await writes[0].response())?.status()).toBe(200)
      await expect(page.locator('.nds-grid-sheet-status-refused')).toHaveCount(0)
      bodyFailed = false
    } finally {
      await truthfulCleanup(bodyFailed, async () => {
        await page.keyboard.press('Escape').catch(() => {})
        await quiet.settle()
        const fresh = await readAxes()
        if (JSON.stringify(fresh.axes) !== JSON.stringify(before.axes)) {
          const response = await browserMutation(page, seed.workspace, endpoint, 'PATCH',
            { version: fresh.product.version, axes: before.axes, childIds: fresh.childIds, market: 'IT' })
          expect(response.status, 'restore original family axis order').toBe(200)
        }
        expect((await readAxes()).axes).toEqual(before.axes)
        expect((await storedEditorProducts(seed)).filter(row => row.parentId)).toEqual(storedBefore.filter(row => row.parentId))
      })
    }
  })

  test('media popup cancels without writing and saves an exact gallery reorder', async ({ page }) => {
    await openEditorFixture(page, seed)
    const endpoint = `/backend/api/products/${product}/product-media?scope=MASTER&market=GLOBAL&locale=it`
    const headers = { 'x-nexus-workspace-id': seed.workspace }
    const readMedia = async () => {
      const response = await page.request.get(endpoint, { headers, maxRedirects: 0 })
      expect(response.status()).toBe(200)
      return await response.json() as ProductMediaWorkspace
    }
    const before = await readMedia(), allBefore = await storedEditorProducts(seed), sqlBefore = allBefore.find(row => row.id === product)!
    const quiet = new NetworkMetrics(page)
    expect(before.collection.items).toHaveLength(2)
    const expected = { version: 1, items: [...before.collection.items].reverse() }
    const writes: string[] = []
    page.on('request', request => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith(`/products/${product}/product-media`)) writes.push(request.postData() ?? '')
    })
    const changeOrder = async () => {
      await focusCell(page, product, 'productMedia')
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: /^Product media:/ })
      await expect(dialog).toBeVisible()
      await expect(dialog.locator('.nds-media-board-thumb img')).toHaveCount(2)
      await expect.poll(() => dialog.locator('.nds-media-board-thumb img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
      await dialog.getByRole('button', { name: /^Actions for P3 jacket view 1 in / }).click()
      await page.getByRole('menuitem', { name: 'Move later', exact: true }).click()
      return dialog
    }
    let bodyFailed = true
    try {
      const canceled = await changeOrder()
      await canceled.press('Escape')
      await expect(canceled).toBeHidden()
      expect((await readMedia()).revision).toBe(before.revision)
      expect((await storedEditorProducts(seed)).find(row => row.id === product)).toEqual(sqlBefore)
      expect(writes).toEqual([])
      const dialog = await changeOrder()
      const responsePromise = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith(`/products/${product}/product-media`))
      await dialog.press('ControlOrMeta+Enter')
      const response = await responsePromise
      expect(response.status()).toBe(200)
      expect(response.request().headers()['x-nexus-workspace-id']).toBe(seed.workspace)
      expect(response.request().postDataJSON()).toEqual({ expectedRevision: before.revision, collection: expected })
      await expect(dialog).toBeHidden()
      const stored = await readMedia()
      expect(stored.collection).toEqual(expected)
      expect(stored.hasOverride).toBe(true)
      expect(writes).toHaveLength(1)
      const allStored = await storedEditorProducts(seed), sql = allStored.find(row => row.id === product)!
      expect(allStored.filter(row => row.id !== product)).toEqual(allBefore.filter(row => row.id !== product))
      expect((sql.localizedContent?.it as Record<string, unknown>)._productMedia).toEqual(expected)
      await reloadEditorFixture(page, seed)
      await focusCell(page, product, 'productMedia')
      await page.keyboard.press('Enter')
      const reopened = page.getByRole('dialog', { name: /^Product media:/ })
      await expect(reopened).toBeVisible()
      await expect(reopened.locator('.nds-media-board-thumb')).toHaveCount(2)
      const labels = await reopened.locator('.nds-media-board-thumb').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
      expect(labels[0]).toMatch(/^P3 jacket view 2,/)
      expect(labels[1]).toMatch(/^P3 jacket view 1,/)
      await page.screenshot({ path: test.info().outputPath('media-reloaded.png') })
      await reopened.press('Escape')
      await quiet.settle()
      expect(writes, 'no duplicate write or write from reload/reopen/cancel').toHaveLength(1)
      await expect(page.locator('.nds-grid-sheet-status-refused')).toHaveCount(0)
      bodyFailed = false
    } finally {
      await truthfulCleanup(bodyFailed, async () => {
        await page.keyboard.press('Escape').catch(() => {})
        await quiet.settle()
        const fresh = await readMedia()
        if (fresh.revision !== before.revision) {
          const response = await browserMutation(page, seed.workspace, endpoint, 'PUT',
            { expectedRevision: fresh.revision, collection: before.hasOverride ? before.collection : null })
          expect(response.status, 'restore original media value and inheritance').toBe(200)
        }
        const restored = await readMedia()
        expect(restored.collection).toEqual(before.collection)
        expect(restored.hasOverride).toBe(before.hasOverride)
        const allRestored = await storedEditorProducts(seed)
        expect(allRestored.find(row => row.id === product)?.localizedContent).toEqual(sqlBefore.localizedContent)
        expect(allRestored.filter(row => row.id !== product)).toEqual(allBefore.filter(row => row.id !== product))
      })
    }
  })
})
