import { expect } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, byApi, dialog, press } from './_harness/ui'

/** The style of the first order (made up): a leather touring jacket, PPE category II, one colourway, three sizes. */
export const STYLE = { code: 'GF-JKT-01', name: 'Golden touring jacket', sizes: ['50', '52', '54'] as const }

const box = (scope: { getByRole: import('@playwright/test').Page['getByRole'] }, name: string) => scope.getByRole('textbox', { name, exact: true })
const select = (scope: { getByRole: import('@playwright/test').Page['getByRole'] }, name: string) => scope.getByRole('combobox', { name, exact: true })

export default defineStage({
  proves: 'leather in ft² with a standard price, lining, protector; style 2 colours x 3 sizes (here 1 colourway x 3 sizes, the order’s); BOM; routing with minutes',
  async run(flow) {
    const manager = await flow.desk('manager')
    const { page } = manager

    const style = await flow.step('the production manager makes the draft style: jacket, EU sizes 50/52/54, PPE category II EN 17092-3 AA', async () => {
      await manager.go('/products/styles')
      await press(page.getByRole('button', { name: 'New style' }).first())
      const form = dialog(page)
      await box(form, 'Code').fill(STYLE.code)
      await box(form, 'Name').fill(STYLE.name)
      await box(form, 'Season').fill('FW27')
      await select(form, 'Size scale').selectOption({ label: 'SEED-EU-JKT · Seed EU jacket 48-56' })
      for (const size of STYLE.sizes) await form.getByRole('button', { name: new RegExp(`^${size}( · base)?$`) }).click()
      await select(form, 'Base size').selectOption('52')
      await select(form, 'Standard and edition').selectOption({ label: 'EN 17092-3:2020 — class AA' })
      const made = await answerOf(page, 'POST', /^\/product\/styles$/, () => press(form.getByRole('button', { name: 'Create draft style' })))
      await page.waitForURL(/\/products\/styles\/[0-9a-f-]{36}/)
      await expect(select(page, 'Revision in view')).toContainText('Rev 1')
      return made.style as Record<string, any>
    })
    flow.state.style = { id: style.id, code: style.code }

    await flow.step('the brand is the customer (by the API: the production manager may not read customers, so the screen offers no brand)', async () => {
      byApi('02-style: the style’s brand = the customer (PATCH /product/styles/:id): the production_manager template has no parties.view, so the New style dialog and the Overview show no brand picker')
      const current = (await flow.read(page, `/product/styles/${style.id}`)).style
      await flow.write(page, 'PATCH', `/product/styles/${style.id}`, { version: current.version, brandPartyId: flow.state.party.id })
    })

    await flow.step('colourway RED and its three SKUs', async () => {
      await manager.go(`/products/styles/${style.id}?tab=variants`)
      await press(page.getByRole('button', { name: 'Add colourway' }).first())
      let form = dialog(page)
      await box(form, 'Code').fill('RED')
      await box(form, 'Name').fill('Rosso')
      await select(form, 'Main colour').selectOption({ label: 'SEED-RED · Seed red' })
      await answerOf(page, 'POST', /\/colourways$/, () => press(form.getByRole('button', { name: 'Add colourway' })))
      await expect(page.getByText('Colourway added.').first()).toBeVisible()
      await press(page.getByRole('button', { name: 'Generate 3 SKUs' }).first())
      form = dialog(page)
      await answerOf(page, 'POST', /\/skus\/generate$/, () => press(form.getByRole('button', { name: 'Generate 3 SKUs' })))
      for (const size of STYLE.sizes) await expect(page.getByRole('button', { name: new RegExp(`^RED, size ${size}: SKU GF-JKT-01-RED-${size} on`) })).toBeVisible()
      await flow.shot(page, 'variants')
    })

    await flow.step('the BOM: leather by size and colour, lining, protectors; the planned hide yield', async () => {
      await manager.go(`/products/styles/${style.id}?tab=bom`)
      const add = async (code: string, fill: (form: ReturnType<typeof dialog>) => Promise<void>) => {
        await press(page.getByRole('button', { name: 'Add material' }).first())
        const form = dialog(page)
        await form.getByPlaceholder('Leather, lining, protector, zip…').fill(code)
        await form.getByRole('radio', { name: new RegExp(code) }).first().click()
        await box(form, 'Placement').waitFor()
        await fill(form)
        await answerOf(page, 'POST', /\/bom\/lines$/, () => press(form.getByRole('button', { name: 'Add to the BOM' })))
        await expect(page.getByText('Material added to the BOM.').first()).toBeVisible()
      }
      await add('SEED-LEA-100', async (form) => {
        await box(form, 'Placement').fill('Outer shell')
        await form.getByRole('switch', { name: 'Varies by size' }).click()
        await box(form, 'Wastage').fill('5')
        await form.getByRole('switch', { name: 'Varies by colourway' }).click()
      })
      await add('SEED-LIN-200', async (form) => {
        await box(form, 'Placement').fill('Body lining')
        await box(form, 'Quantity per garment').fill('1.8')
        await box(form, 'Wastage').fill('5')
        await select(form, 'Colour').selectOption({ label: 'GRY · Grey' })
      })
      await add('SEED-PRO-300', async (form) => {
        await box(form, 'Placement').fill('Shoulder pockets')
        await box(form, 'Quantity per garment').fill('2')
      })

      await page.getByRole('radio', { name: 'By size' }).click()
      for (const [size, quantity] of [['50', '20'], ['52', '21'], ['54', '22']] as const) {
        const cell = page.getByRole('textbox', { name: new RegExp(`SEED-LEA-100, size ${size}$`) })
        await cell.fill(quantity)
        await answerOf(page, 'PUT', /\/bom\/lines\/[0-9a-f-]+\/sizes$/, () => cell.press('Enter'))
      }
      await page.getByRole('radio', { name: 'By colourway' }).click()
      await answerOf(page, 'PUT', /\/bom\/lines\/[0-9a-f-]+\/colours$/, () => page.getByRole('combobox', { name: /SEED-LEA-100, colourway RED$/ }).selectOption({ label: 'RED · Red (S-002)' }))

      await box(page, 'Planned hide yield').fill('75')
      await answerOf(page, 'PATCH', /\/revisions\/[0-9a-f-]+$/, () => press(page.getByRole('button', { name: 'Save yield' })))
      await flow.shot(page, 'bom')
    })

    await flow.step('the routing: cut, sew, final inspection, pack from the operations library (minutes from the library)', async () => {
      await manager.go(`/products/styles/${style.id}?tab=routing`)
      await press(page.getByRole('button', { name: 'Add operations' }).first())
      const form = dialog(page)
      for (const code of ['SEED-CUT-LEA', 'SEED-SEW-ASM', 'SEED-FIN-QC', 'SEED-PACK']) await form.locator('li', { hasText: code }).getByRole('checkbox').first().check()
      await answerOf(page, 'POST', /\/routing\/steps$/, () => press(form.getByRole('button', { name: 'Add 4 operations' })))
      await expect(page.getByText('4 operations added.').first()).toBeVisible()
      await flow.shot(page, 'routing')
    })

    const { revisions } = await flow.read(page, `/product/styles/${style.id}/revisions`)
    flow.state.style.revisionId = (revisions as Record<string, any>[]).find((entry) => entry.status === 'DRAFT')!.id
    const path = `/product/styles/${style.id}/revisions/${flow.state.style.revisionId}`
    const bom = (await flow.read(page, `${path}/bom`)).bom
    expect(bom.lines.length).toBe(3)
    const minutes = JSON.stringify(await flow.read(page, `${path}/routing`)).match(/"standardMinutes":"?[0-9.]+/g) ?? []
    expect(minutes.length, 'four routing steps with their standard minutes').toBeGreaterThanOrEqual(4)
    expect(minutes.every((entry) => Number(entry.split(':')[1]!.replace('"', '')) > 0)).toBe(true)
    await flow.settle()
  },
})
