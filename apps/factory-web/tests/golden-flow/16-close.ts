import { expect } from '@playwright/test'
import { ROLES, type PersonKey } from './_harness/flow'
import { defineStage } from './_harness/stages'

export default defineStage({
  proves: 'needs-attention list empty: nothing of this order waits on Home › Today for any of the nine people (and nothing in waiting-on-others); the end checks follow',
  async run(flow) {
    const s = flow.state
    const ids = [s.party?.id, s.style?.id, s.certificate?.id, s.quote?.id, s.order?.id, s.deposit?.depositId, s.td02?.id, s.po?.id, s.receipt?.id, s.receipt?.lots?.leather?.id, s.receipt?.lots?.protectors?.id, s.workOrder?.id, s.shipment?.id, s.ddt?.id, s.invoice?.id].filter(
      (id): id is string => typeof id === 'string',
    )
    expect(ids.length).toBeGreaterThanOrEqual(14)
    const numbers = [s.quote?.number, s.order?.number, s.po?.number, s.workOrder?.number, s.shipment?.number, s.invoice?.number, s.td02?.number].filter((value): value is string => Boolean(value))

    for (const key of Object.keys(ROLES) as PersonKey[]) {
      await flow.step(`Home › Today of ${key}: nothing of the order`, async () => {
        const desk = await flow.desk(key)
        const { page } = desk
        await desk.go('/home/today')
        const region = page.getByRole('region', { name: 'Needs me now' })
        await expect(region).toBeVisible()
        await expect(page.getByText('Reading what needs you…')).toHaveCount(0, { timeout: 30_000 })
        for (let more = 0; more < 10; more++) {
          const button = region.getByRole('button', { name: 'Show more' })
          if (!(await button.isVisible())) break
          await button.click()
        }
        const links = await region.getByRole('link').evaluateAll((anchors) => anchors.map((anchor) => `${anchor.getAttribute('href') ?? ''} ${anchor.textContent ?? ''}`))
        const ours = links.filter((link) => ids.some((id) => link.includes(id)) || numbers.some((number) => link.includes(number)))
        expect(ours, `Home › Today of ${key}`).toEqual([])
        const today = ((await flow.read(page, '/home/today?limit=200')).items ?? []) as Record<string, any>[]
        expect(today.filter((item) => ids.includes(item.record?.id)).map((item) => `${item.kind} ${item.record?.label}`), `Today of ${key} (API)`).toEqual([])
        const waiting = ((await flow.read(page, '/home/waiting-on-others')).items ?? []) as Record<string, any>[]
        expect(waiting.filter((item) => ids.includes(item.record?.id)).map((item) => item.kind), `waiting on others of ${key}`).toEqual([])
        if (key === 'finance') await flow.shot(page, 'today-finance')
      })
    }
  },
})
