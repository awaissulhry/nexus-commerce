import { expect } from '@playwright/test'
import { drained, quiet, scanUntil, signIn, tablet, tile, waiting, worker, type TABLETS, type WORKERS } from './_harness/floor'
import { defineStage } from './_harness/stages'
import { press } from './_harness/ui'

export default defineStage({
  proves: 'worker notice acknowledged; bundles (made with the network off, recorded when it is back); scans per operation at each station, with the network off, then on',
  async run(flow) {
    const workOrder = flow.state.workOrder as { id: string; number: string }

    const bundles = await flow.step('bundles at the cutting table, made with the network OFF: saved on the tablet, recorded once it is back ON', async () => {
      const device = await tablet(flow, 'CUT')
      const { page, context } = device
      await signIn(flow, device, await worker(flow, 'cutter'))
      await tile(page, 'Bundles')
      await press(page.getByRole('button', { name: new RegExp(workOrder.number) }).first())
      const make = page.getByRole('button', { name: /^Make 3 bundles · print 3 tickets/ })
      await expect(make).toBeVisible()
      await quiet(page)
      await page
        .waitForFunction(() => (window as unknown as { __nexusFloorQueue?: { getSnapshot(): { numbers: { blocks: { kind: string; status: string }[] } } } }).__nexusFloorQueue?.getSnapshot().numbers.blocks.some((block) => block.kind === 'BUNDLE' && block.status === 'ACTIVE'), undefined, { timeout: 20_000 })
        .catch(() => {})
      await context.setOffline(true)
      await press(make)
      await expect(page.getByText('3 tickets made here').first()).toBeVisible()
      await expect(page.getByText(/No network: the bundles are saved on this tablet/).first()).toBeVisible()
      expect(await waiting(page)).toBe(3)
      await flow.shot(page, 'bundles-offline')
      await context.setOffline(false)
      await drained(page)
      await expect(page.getByText('Recorded by the office').first()).toBeVisible()
      await flow.shot(page, 'bundles-recorded')
      const codes = (await page.locator('.fw-bundles-ticket-code').allInnerTexts()).map((code) => code.trim()).filter((code) => /^BN-/.test(code))
      expect(codes.length).toBe(3)
      return codes
    })
    flow.state.bundles = bundles

    const stations: [keyof typeof TABLETS, keyof typeof WORKERS, string, boolean][] = [
      ['CUT', 'cutter', 'Op 10', false],
      ['SEW', 'sewer', 'Op 20', true],
      ['QC', 'qc', 'Op 30', false],
      ['PACK', 'packer', 'Op 40', false],
    ]
    for (const [key, who, op, offline] of stations) {
      await flow.step(`${op} at ${key}: every bundle reported${offline ? ' with the network OFF (two ticks: saved here, then recorded once it is back ON)' : ''}`, async () => {
        const device = await tablet(flow, key)
        const { page, context } = device
        await signIn(flow, device, await worker(flow, who))
        await tile(page, 'Operation')
        const finish = page.getByRole('button', { name: /^Finish · \d+ good/ })
        if (offline) {
          // Each bundle read online first (its card stays on this tablet for the visit), then reported offline.
          const card = (code: string) => page.getByText(code, { exact: true })
          for (const code of bundles) await scanUntil(page, code, card(code), { field: 'Scan the bundle ticket', orWedge: true })
          await context.setOffline(true)
          for (const code of [...bundles].reverse()) {
            if (!(await card(code).isVisible())) await scanUntil(page, code, card(code), { field: 'Scan the bundle ticket', orWedge: true })
            await expect(page.getByText(new RegExp(`^${op} · `)).first()).toBeVisible()
            await press(finish)
            await expect(page.getByText('Saved on this tablet').first()).toBeVisible()
          }
          expect(await waiting(page)).toBe(bundles.length)
          await expect(page.getByText('Offline: work waits on this tablet').first()).toBeVisible()
          await flow.shot(page, `scans-offline-${key}`)
          await context.setOffline(false)
        } else {
          for (const code of bundles) {
            await scanUntil(page, code, finish, { field: 'Scan the bundle ticket' })
            await press(finish)
            await drained(page)
          }
        }
        await drained(page)
        await expect(page.getByText('Recorded by the office').first()).toBeVisible()
        await flow.shot(page, `scans-${key}`)
      })
    }

    await flow.settle()
    const planner = await flow.desk('planner')
    const wip = await flow.read(planner.page, `/production/scans/work-orders/${workOrder.id}/wip`)
    expect(wip).toMatchObject({ allFinished: true, readyToComplete: true })
  },
})
