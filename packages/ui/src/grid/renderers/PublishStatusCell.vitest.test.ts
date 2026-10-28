import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it } from 'vitest'
import { PublishStatusCard, PublishStatusPill, PublishStatusView } from './PublishStatusCell'
import { publicationStatusMeta } from './publishStatus'
import { publishCardModel, type PublishStatusValue } from './publishStatus'

const now = new Date(2026, 9, 1, 15, 0).getTime()
const value: PublishStatusValue = {
  destinationLabel: 'Amazon · IT',
  last: {
    publicationId: 'pub_1', status: 'FAILED', at: new Date(2026, 9, 1, 12, 4).toISOString(), userName: 'Dev Owner', message: null,
    reference: 'FEED-1', sentFields: ['Title'],
    issues: [{ severity: 'error', message: 'Value not allowed.', fieldLabel: 'Colour', columnKey: 'amazon:color' }],
  },
}

it('is a real button trigger with the whole sentence as its name, a dotted pill and the short time', () => {
  const html = render(createElement(PublishStatusView, { value, now }))
  expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"/)
  expect(html).toContain('aria-label="Last publish: Failed, Amazon · IT, ')
  expect(html).toContain('Press Enter for details.')
  expect(html).toContain('nds-pill danger has-dot')
  expect(html).toContain('>12:04<')
})

it('never paints the cell: no tone class on the cell itself', () => {
  const html = render(createElement(PublishStatusView, { value, now }))
  expect(html).toMatch(/class="nds-publish-cell"/)
  expect(html).not.toMatch(/nds-publish-cell[^"]*danger/)
})

it('shows a skeleton while loading, and a dash that says why when there is nothing to open', () => {
  const loading = render(createElement(PublishStatusView, { value: undefined, now }))
  expect(loading).toContain('nds-skeleton')
  expect(loading).toContain('Last publish: loading.')
  expect(loading).not.toContain('<button')
  const never = render(createElement(PublishStatusView, { value: { ...value, last: null }, now }))
  expect(never).toContain('—')
  expect(never).toContain('not published from Nexus yet')
  expect(never).not.toContain('<button')
  const failed = render(createElement(PublishStatusView, { value: { ...value, readError: 'HTTP 500' }, now }))
  expect(failed).toContain('title="Publish results could not be read."')
})

it('marks an edit after the publish in words, not colour alone', () => {
  expect(render(createElement(PublishStatusView, { value: { ...value, editedSince: true }, now }))).toContain('>Edited<')
})

it('renders the card: severity in words, Go to field only for a known column, history only with a handler', () => {
  const model = publishCardModel({ ...value, last: { ...value.last!, issues: [...value.last!.issues, { severity: 'warning', message: 'Recommended.' }] } })
  const withActions = render(createElement(PublishStatusCard, { model, onGoToField: () => {}, onOpenHistory: () => {} }))
  expect(withActions).toContain('>Error<')
  expect(withActions).toContain('>Warning<')
  expect(withActions.match(/Go to field/g)).toHaveLength(1)
  expect(withActions).toContain('See publish history')
  const readOnly = render(createElement(PublishStatusCard, { model }))
  expect(readOnly).not.toContain('Go to field')
  expect(readOnly).not.toContain('See publish history')
})

it('draws Verified with a check glyph and no dot, every other status with the dot', () => {
  const verified = render(createElement(PublishStatusPill, { meta: publicationStatusMeta('VERIFIED') }))
  expect(verified).toContain('nds-pill success')
  expect(verified).not.toContain('has-dot')
  expect(verified).toMatch(/<svg[^>]*aria-hidden="true"/)
  const accepted = render(createElement(PublishStatusPill, { meta: publicationStatusMeta('ACCEPTED') }))
  expect(accepted).toContain('nds-pill info has-dot nds-publish-pill')
  expect(accepted).not.toContain('<svg')
})

it('the card says the detail sentence, not "open the details"', () => {
  const html = render(createElement(PublishStatusCard, { model: publishCardModel(value, now) }))
  expect(html).toContain('The channel refused this publish.')
  expect(html).not.toContain('Open the details')
})

it('a family main row shows the family count as its word, and the card keeps the publication word with the count as its sentence', () => {
  const family: PublishStatusValue = { ...value, last: { ...value.last!, status: 'PARTIAL', outcome: 'ACCEPTED' }, family: { total: 11, failed: 2 } }
  const cell = render(createElement(PublishStatusView, { value: family, now }))
  expect(cell).toContain('nds-pill warning has-dot')
  expect(cell).toContain('>2 of 11 failed<')
  expect(cell).toContain('aria-label="Last publish: 2 of 11 products in this family failed, Amazon · IT, ')
  const card = render(createElement(PublishStatusCard, { model: publishCardModel(family, now) }))
  expect(card).toContain('Partly failed')
  expect(card).toContain('>2 of 11 products in this family failed in this publish.<')
  expect(card).not.toContain('Some products in this publish failed.')
  expect(card).toContain('This row:')
})
