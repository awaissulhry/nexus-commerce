import { expect, type Page } from '@playwright/test'
import { CUSTOMER } from './01-customer'
import { STYLE } from './02-style'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, pdf, pickDate, press } from './_harness/ui'

export const CERTIFICATE = { number: 'GF-CERT-0001', validFrom: '2026-01-15', validTo: '2030-12-31' }

const box = (scope: Pick<Page, 'getByRole'>, name: string) => scope.getByRole('textbox', { name, exact: true })
const select = (scope: Pick<Page, 'getByRole'>, name: string) => scope.getByRole('combobox', { name, exact: true })

export default defineStage({
  proves: 'a certificate covers the style; label template (named on the draft revision, which the production manager then releases); the signed DoC and the user information on file',
  async run(flow) {
    const inspector = await flow.desk('inspector')
    const { page } = inspector
    const styleId = flow.state.style.id as string

    const certificate = await flow.step('the inspector registers GF-CERT-0001 (EN 17092-3 AA, the brand as holder) with its PDF', async () => {
      await inspector.go('/compliance/certificates')
      await press(page.getByRole('button', { name: 'Add certificate' }).first())
      const form = dialog(page)
      await select(form, 'Standard').selectOption('EN 17092-3:2020')
      await box(form, 'Certificate number').fill(CERTIFICATE.number)
      await select(form, 'Holder').selectOption({ label: `Brand · ${CUSTOMER.legalName}` })
      await box(form, 'Notified body').fill('Golden Notified Body (made up)')
      await box(form, 'Its number').fill('0000')
      await box(form, 'Model reference').fill(STYLE.code)
      await pickDate(form, 'Valid from', CERTIFICATE.validFrom)
      await pickDate(form, 'Valid to', CERTIFICATE.validTo)
      await form.locator('input[type="file"]').setInputFiles(pdf('EU type-examination certificate GF-CERT-0001'))
      const made = await answerOf(page, 'POST', /^\/compliance\/certificates$/, () => press(form.getByRole('button', { name: 'Create draft certificate' })))
      await page.waitForURL(/\/compliance\/certificates\/[0-9a-f-]{36}\?tab=coverage/)
      return made.certificate as Record<string, any>
    })
    flow.state.certificate = { id: certificate.id, number: CERTIFICATE.number }

    await flow.step('coverage: the style, every colourway, the whole range; then registered (valid)', async () => {
      await press(page.getByRole('button', { name: 'Add coverage' }).first())
      const form = dialog(page)
      await form.getByRole('searchbox').fill(STYLE.code)
      await form.getByRole('button', { name: new RegExp(STYLE.code) }).or(form.getByRole('radio', { name: new RegExp(STYLE.code) })).first().click()
      await answerOf(page, 'POST', /\/coverage$/, () => press(form.getByRole('button', { name: 'Add coverage' })))
      await expect(page.getByText(`${STYLE.code} is covered.`).first()).toBeVisible()
      await press(page.getByRole('button', { name: 'Register…' }).first())
      await answerOf(page, 'POST', /\/issue$/, () => press(dialog(page).getByRole('button', { name: 'Register certificate' })))
      await expect(page.getByText(/is registered: it covers what it lists/).first()).toBeVisible()
      await flow.shot(page, 'certificate-registered')
    })

    await flow.step('the garment label: composition, animal origin, care; saved and activated', async () => {
      await inspector.go(`/compliance/labels?new=1&style=${styleId}`)
      const form = dialog(page)
      await expect(form.getByText(STYLE.code).first()).toBeVisible()
      await answerOf(page, 'POST', /^\/compliance\/labels$/, () => press(form.getByRole('button', { name: 'Create draft label' })))
      await page.waitForURL(/\/compliance\/labels\/[0-9a-f-]{36}/)
      await press(page.getByRole('button', { name: 'Add a part' }))
      await press(page.getByRole('button', { name: 'Add a part' }))
      const parts = [
        ['shell', 'leather (not a textile)'],
        ['lining', 'polyester'],
      ] as const
      for (const [index, [part, fibre]] of parts.entries()) {
        await page.getByRole('textbox', { name: 'Part', exact: true }).nth(index).fill(part)
        await page.getByRole('textbox', { name: 'Fibre', exact: true }).nth(index).fill(fibre)
        await page.getByRole('textbox', { name: 'Share %', exact: true }).nth(index).fill('100')
      }
      await page.getByRole('switch', { name: 'Contains non-textile parts of animal origin' }).click()
      await select(page, 'Washing').selectOption({ label: 'Do not wash' })
      await select(page, 'Bleaching').selectOption({ label: 'Do not bleach' })
      await select(page, 'Ironing').selectOption({ label: 'Do not iron' })
      await select(page, 'Professional dry cleaning').selectOption({ label: 'Professional dry cleaning in tetrachloroethene (P)' })
      await answerOf(page, 'PATCH', /^\/compliance\/labels\/[0-9a-f-]+$/, () => press(page.getByRole('region', { name: 'Save the draft' }).getByRole('button', { name: 'Save' })))
      await press(page.getByRole('button', { name: 'Activate revision 1' }).first())
      await answerOf(page, 'POST', /\/activate$/, () => press(dialog(page).getByRole('button', { name: 'Activate revision 1' })))
      await expect(page.getByText(/r1 is active: garment labels print from it/).first()).toBeVisible()
      await flow.shot(page, 'label-active')
    })

    await flow.step('the label is named on the draft revision (it freezes with the release)', async () => {
      await inspector.go(`/products/styles/${styleId}?tab=compliance`)
      await select(page, 'Label of the draft revision').selectOption({ label: `LBL-${STYLE.code} · Rev 1 · ${STYLE.name} garment label` })
      await answerOf(page, 'PUT', /\/revisions\/[0-9a-f-]+\/label$/, () => press(page.getByRole('button', { name: 'Name this label' })))
      await expect(page.getByText('The revision names its garment label.').first()).toBeVisible()
    })

    await flow.step('the production manager releases revision 1: the style is active', async () => {
      const manager = await flow.desk('manager')
      await manager.go(`/products/styles/${styleId}?tab=overview`)
      await press(manager.page.getByRole('button', { name: 'Release revision 1' }).first())
      await answerOf(manager.page, 'POST', /\/release$/, () => press(dialog(manager.page).getByRole('button', { name: 'Release revision 1' })))
      await expect(manager.page.getByText('Revision 1 is released: new work orders use it.').first()).toBeVisible()
      await flow.shot(manager.page, 'style-released')
    })

    await flow.step('the inspector files the signed DoC and the user information, it and en, for the released revision', async () => {
      await inspector.go(`/products/styles/${styleId}?tab=compliance`)
      for (const table of ['EU declaration of conformity (signed)', 'User information leaflet']) {
        for (const language of ['IT', 'EN']) {
          await press(page.getByRole('table', { name: table }).getByRole('button', { name: `Upload the ${language} file` }))
          const form = dialog(page)
          await form.locator('input[type="file"]').setInputFiles(pdf(`${table} ${language} ${STYLE.code} rev 1`))
          await answerOf(page, 'POST', /\/compliance\/documents\/[0-9a-f-]+\/files\/[0-9a-f-]+\/complete$/, () => press(form.getByRole('button', { name: 'Upload', exact: true })))
          await expect(page.getByText('The signed file is uploaded and in force for the revision.').first()).toBeVisible()
        }
      }
      await flow.shot(page, 'compliance-documents')
    })

    const style = (await flow.read(page, `/product/styles/${styleId}`)).style
    expect(style.status).toBe('ACTIVE')
    const { revisions } = await flow.read(page, `/product/styles/${styleId}/revisions`)
    const released = (revisions as Record<string, any>[]).find((entry) => entry.status === 'RELEASED')!
    flow.state.style.revisionId = released.id
    const compliance = (await flow.read(page, `/product/styles/${styleId}/compliance?revisionId=${released.id}`)).compliance
    expect(compliance.blockers ?? []).toEqual([])
    const gate = await flow.write(page, 'POST', '/compliance/certificates/gate', { styleId, colourwayId: style.colourways[0].id, size: '52' })
    expect(gate).toMatchObject({ allowed: true, outcome: 'covered' })
    flow.state.style.colourwayId = style.colourways[0].id
    await flow.settle()
  },
})
