import { randomUUID } from 'node:crypto'
import { expect, test } from './fixture'
import { focusCell, openSheet, readSheet, scopeOf } from './grid'
import { sheetSeed } from './seed'
import { NETWORK_STUBS } from './drivers'
import { NetworkMetrics, OFFLINE_LATENCY, renderHook } from './metrics'
import { armSavedTiming, firstEditableScalarMs, readSavedTiming, stopSavedTiming } from './savedTiming'
import { assertSaved, Wire, type Save } from './wire'
import { browserMutation } from './browserRequest'

/** Predeclared native-local arm. Wall times stay report-only in CI; a missed target remains a reported miss. */
test('@sheet latency · 20 first-editable observations and 100 distinct confirmed saves', async ({ page }) => {
  test.setTimeout(600_000)
  const seed = sheetSeed(), scope = scopeOf(seed, 'EBAY', seed.families.speed)
  const baseline = await readSheet(page, scope, seed.workspace)
  const row = baseline.rows.filter(row => !row.isParent).at(-1)
  expect(row, 'the independent speed family must have a writable scalar row').toBeTruthy()
  const id = row!.id, original = row!.values.subtitle.value
  const firstEdits: Array<{ sample: number; ms?: number; error?: string }> = []
  const saves: Array<{ sample: number; value: string; pendingMs?: number; savedMs?: number; error?: string }> = []
  const failures: string[] = []
  page.on('pageerror', error => failures.push(`Page: ${error.message}`))
  // A lookup that cannot answer on an offline stack (OFFLINE_LATENCY: eBay category breadcrumbs, 503) is the speed spec's
  // known exception too; every other console error fails the series.
  page.on('console', message => {
    if (message.type() !== 'error') return
    if (/status of 503/.test(message.text()) && OFFLINE_LATENCY.some(path => (message.location().url ?? '').includes(path))) return
    failures.push(`Console: ${message.text()}`)
  })
  const run = randomUUID()
  let restored = false
  await page.addInitScript(renderHook)
  for (const stub of NETWORK_STUBS) await page.route(stub.url, route => route.fulfill({ json: stub.body }))
  // The existing 1500ms request-settle window is only a quiescence precondition. It is never Saved latency.
  const quiet = new NetworkMetrics(page, OFFLINE_LATENCY, true)
  const wire = new Wire(page)
  try {
    await openSheet(page, scope)
    await quiet.settle()
    const instrument = await page.evaluate('window.__sheetRenders.snapshot()') as { total: number; production: boolean }
    expect(instrument.total).toBeGreaterThan(0)
    expect(instrument.production, 'use the actual production web build').toBe(true)
    for (let sample = 1; sample <= 20; sample++) {
      const record: typeof firstEdits[number] = { sample }
      firstEdits.push(record)
      try {
        await openSheet(page, scope)
        const cell = await focusCell(page, id, 'subtitle')
        record.ms = await firstEditableScalarMs(page, cell)
        await quiet.settle()
      } catch (error) { record.error = String(error); throw error }
    }
    expect(wire.mark(), 'first-editable probes must discard without any write').toBe(0)
    for (let sample = 1; sample <= 100; sample++) {
      const record: typeof saves[number] = { sample, value: `P3-${run}-${sample}` }
      saves.push(record)
      try {
        const before = await readSheet(page, scope, seed.workspace)
        const current = before.rows.find(row => row.id === id)!
        const field = current.values.subtitle.writeField
        expect(typeof field).toBe('string')
        expect(current.values.subtitle.value).not.toBe(record.value)
        await focusCell(page, id, 'subtitle')
        await page.keyboard.press('Enter')
        const input = page.locator('.ag-popup-editor input').first()
        await expect(input).toBeFocused()
        await input.fill(record.value)
        await quiet.settle()
        await expect(page.locator('.nds-grid-sheet-status-pending, .nds-grid-sheet-status-refused, .nds-grid-sheet-note.refusal, .nds-grid-sheet-note.offline')).toHaveCount(0)
        const mark = wire.mark()
        await armSavedTiming(page)
        await page.keyboard.press('Enter')
        const timing = await readSavedTiming(page)
        Object.assign(record, timing)
        const saved = await wire.one(mark, `Saved sample ${sample}`)
        assertSaved(saved, `Saved sample ${sample}`)
        expect(saved.body.units).toHaveLength(1)
        expect(saved.body.units[0].expectedVersion).toBe(current.listing?.version ?? current.version)
        expect(saved.body.units[0].changes).toHaveLength(1)
        expect(saved.body.units[0].changes[0]).toMatchObject({ id, field, value: record.value, target: 'channel' })
        expect(saved.answer.units[0].key).toBe(saved.body.units[0].key)
        expect((await readSheet(page, scope, seed.workspace)).rows.find(row => row.id === id)?.values.subtitle.value).toBe(record.value)
      } catch (error) { record.error = String(error); throw error }
      finally { await stopSavedTiming(page) }
    }
    expect(wire.mark(), 'exactly one real write for each distinct sample').toBe(100)
    wire.assertLoopback()
  } catch (error) { failures.push(String(error)) }
  finally {
    try {
      await page.keyboard.press('Escape').catch(() => {})
      // A failed footer witness may still have an in-flight write. Never certify restoration from a stale read.
      await quiet.settle()
      const fresh = await readSheet(page, scope, seed.workspace)
      const current = fresh.rows.find(row => row.id === id)!
      if (JSON.stringify(current.values.subtitle.value) !== JSON.stringify(original)) {
        const response = await browserMutation<Save['answer']>(page, seed.workspace, '/backend/api/products/bulk-save', 'POST', { operationId: randomUUID(), units: [{
            key: `restore-${run}`, expectedVersion: current.listing?.version ?? current.version,
            marketplaceContexts: [{ channel: 'EBAY', marketplace: scope.market, accountId: scope.connection, locale: scope.locale }],
            changes: [{ id, field: current.values.subtitle.writeField, value: original, target: 'channel' }],
          }] })
        assertSaved({ status: response.status, answer: response.body }, 'restore speed baseline')
      }
      expect((await readSheet(page, scope, seed.workspace)).rows.find(row => row.id === id)?.values.subtitle.value).toEqual(original)
      restored = true
    } catch (error) { failures.push(`Restore: ${String(error)}`) }
    const complete = failures.length === 0 && firstEdits.length === 20 && saves.length === 100 && saves.every(sample => sample.savedMs !== undefined && !sample.error)
    // Empirical nearest-rank p95. No failures or partial series are discarded to form a passing number.
    const p95 = complete ? saves.map(sample => sample.savedMs!).sort((a, b) => a - b)[Math.ceil(100 * 0.95) - 1] : null
    const firstEditableMax = complete ? Math.max(...firstEdits.map(sample => sample.ms!)) : null
    const evidence = { arm: 'native-local', method: '20 first-editable observations; 100 distinct real saves; nearest-rank p95',
      quietLease: process.env.SHEET_QUIET_LEASE ?? null, contention: process.env.SHEET_CONTENTION ?? null,
      timingPolicy: 'report-only in CI; actual target misses stay open', complete, restored, failures, firstEdits, saves,
      p95SavedMs: p95, firstEditableMaxMs: firstEditableMax,
      targets: { p95SavedMs: 800, firstEditableMs: 2500 },
      meetsSavedTarget: p95 === null ? null : p95 <= 800,
      meetsFirstEditableTarget: firstEditableMax === null ? null : firstEditableMax <= 2500 }
    await test.info().attach('sheet-latency-all-samples', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
    console.log(`SHEET_LATENCY ${JSON.stringify(evidence)}`)
  }
  expect(failures, 'every failed sample or restore stays a failure; no shortened p95 series').toEqual([])
})
