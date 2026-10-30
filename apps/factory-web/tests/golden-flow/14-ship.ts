import { expect } from '@playwright/test'
import { CUSTOMER } from './01-customer'
import { STYLE } from './02-style'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press } from './_harness/ui'

export default defineStage({
  proves: 'released goods only; 2 parcels; DDT; carrier label (fake Sendcloud); tracking delivered; DoC by link',
  async run(flow) {
    const warehouse = await flow.desk('warehouse')
    const { page } = warehouse
    const order = flow.state.order as { id: string; number: string }

    const shipment = await flow.step('the warehouse makes the shipment from what quality released: all 8 garments', async () => {
      await warehouse.go(`/warehouse/shipments?new=1&order=${order.id}`)
      const form = dialog(page)
      await expect(form.getByText(/Up to 2 · /).first()).toBeVisible()
      await press(form.getByRole('button', { name: 'All released' }))
      const made = await answerOf(page, 'POST', /^\/shipping\/shipments$/, () => press(form.getByRole('button', { name: 'Create shipment (8 garments)' })))
      await page.waitForURL(/\/warehouse\/shipments\/[0-9a-f-]{36}/)
      await expect(page.getByText('Draft').first()).toBeVisible()
      return { id: made.shipment.id as string, number: made.shipment.number as string }
    })
    flow.state.shipment = shipment

    await flow.step('two cartons, weighed and measured; sizes 50 and 52 in carton 1, 54 in carton 2; packed', async () => {
      await warehouse.go(`/warehouse/shipments/${shipment.id}?tab=lines`)
      for (const [weight, size] of [['7.5', '60'], ['3.5', '40']] as const) {
        await press(page.getByRole('button', { name: 'Add carton' }).first())
        const form = dialog(page)
        await form.getByRole('textbox', { name: 'Gross weight', exact: true }).fill(weight)
        for (const side of ['Length', 'Width', 'Height']) await form.getByRole('textbox', { name: side, exact: true }).fill(size)
        await answerOf(page, 'POST', /^\/shipping\/packing\/[0-9a-f-]+\/parcels$/, () => press(form.getByRole('button', { name: 'Add carton' })))
        await expect(page.getByText('Carton added.').first()).toBeVisible()
      }
      for (const [size, carton] of [['50', 1], ['52', 1], ['54', 2]] as const) {
        await answerOf(page, 'PUT', /\/parcel$/, () => page.getByRole('combobox', { name: `Carton for ${STYLE.code} size ${size}` }).selectOption({ label: `Carton ${carton} of 2` }))
      }
      await expect(page.getByText('Every garment is in a weighed carton: mark it packed.').first()).toBeVisible()
      await answerOf(page, 'POST', /\/pack$/, () => press(page.getByRole('button', { name: 'Mark packed' }).first()))
      await expect(page.getByText('Marked packed.').first()).toBeVisible()
      await flow.shot(page, 'packed')
    })

    const ddt = await flow.step('the DDT: checked (draft with the SAMPLE banner), then issued with its number', async () => {
      await warehouse.go(`/warehouse/shipments/${shipment.id}?tab=documents`)
      await expect(page.getByText(/^Every field is there: issuing takes number /).first()).toBeVisible({ timeout: 60_000 })
      await press(page.getByRole('button', { name: /^Issue DDT/ }).first())
      const form = dialog(page)
      const issued = await answerOf(page, 'POST', /^\/shipping\/shipments\/[0-9a-f-]+\/ddt$/, () => press(form.getByRole('button', { name: /^Issue DDT / })))
      await expect(page.getByText('DDT issued.').first()).toBeVisible()
      await flow.shot(page, 'ddt-issued')
      return { id: issued.ddt.id as string, number: issued.ddt.number as string }
    })
    flow.state.ddt = ddt

    const tracking = await flow.step('two carrier labels through the company’s Sendcloud account (FAKE): tracking numbers', async () => {
      await warehouse.go(`/warehouse/shipments/${shipment.id}`)
      await press(page.getByRole('button', { name: 'Buy 2 labels' }).first())
      const form = dialog(page)
      const bought = await answerOf(page, 'POST', /\/labels$/, () => press(form.getByRole('button', { name: 'Buy 2 labels' })))
      await expect(form.getByText('2 labels bought.').first()).toBeVisible()
      await press(form.getByRole('button', { name: 'Done' }))
      const numbers = (bought.parcels as Record<string, any>[]).map((parcel) => parcel.trackingNumber as string)
      expect(numbers.length).toBe(2)
      return numbers
    })

    const mails = await flow.step('handed over: the goods left; the worker attaches the DoC and leaflet and mails the customer the documents link', async () => {
      const before = await flow.mailsTo(CUSTOMER.orders.email)
      await warehouse.go(`/warehouse/shipments/${shipment.id}`)
      await press(page.getByRole('button', { name: 'Mark handed over' }).first())
      await answerOf(page, 'POST', /\/ship$/, () => press(dialog(page).getByRole('button', { name: 'Mark handed over' })))
      await expect(page.getByText('Handed over: the goods left.').first()).toBeVisible()
      await flow.settle()
      await warehouse.go(`/warehouse/shipments/${shipment.id}?tab=documents`)
      await expect(page.getByText('Everything on file is attached for the customer').first()).toBeVisible()
      await flow.shot(page, 'shipped-documents')
      return before
    })

    await flow.step('the customer opens the documents link on a phone: the DDT, the DoC and the user information; downloads the DoC', async () => {
      const link = await flow.linkSentTo(CUSTOMER.orders.email, mails)
      const customer = await flow.visitor('customer', link.url)
      const visitor = customer.page
      await expect(visitor.getByText(`Documents of shipment ${shipment.number}`).first()).toBeVisible({ timeout: 60_000 })
      await press(visitor.getByRole('button', { name: /^EU Declaration of Conformity · / }).first())
      await expect(visitor.getByRole('heading', { name: 'EU Declaration of Conformity' }).first()).toBeVisible()
      const [download] = await Promise.all([visitor.waitForEvent('download'), press(visitor.getByRole('button', { name: 'Download' }).first())])
      expect(download.suggestedFilename()).toMatch(/\.pdf$/i)
      await flow.shot(visitor, 'customer-documents')
    })

    await flow.step('the carrier’s events: the scheduler’s tracking poll finds them; both parcels delivered', async () => {
      await flow.control('POST', '/tick/tracking', { trackingNumbers: tracking })
      await expect(async () => {
        await warehouse.go(`/warehouse/shipments/${shipment.id}?tab=tracking`)
        await expect(page.getByText('Delivered').first()).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      expect((await flow.read(page, `/shipping/shipments/${shipment.id}/tracking`)).shipment.status).toBe('DELIVERED')
      await flow.shot(page, 'delivered')
    })
    await flow.settle()
    const sales = await flow.desk('sales')
    expect(['SHIPPED', 'DELIVERED']).toContain((await flow.read(sales.page, `/sales/orders/${order.id}`)).order.status)
  },
})
