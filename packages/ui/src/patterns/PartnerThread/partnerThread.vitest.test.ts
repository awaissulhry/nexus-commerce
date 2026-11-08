import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PartnerThread, type PartnerMessage, type PartnerThreadProps } from './PartnerThread'
import { PARTNER_THREAD_LABELS } from './PartnerThreadLabels'
import { partnerAuthorName, partnerSendHeld, partnerToggleFile } from './partnerThreadModel'

const noop = () => {}
const MESSAGES: PartnerMessage[] = [
  { id: 'm1', side: 'company', channel: 'email', author: { name: null, mine: false }, body: 'Your order is confirmed.\nDelivery in week 47.', at: '2026-11-03T09:42:00Z', atText: '3 Nov, 10:42' },
  {
    id: 'm2',
    side: 'partner',
    channel: 'portal',
    author: { name: 'Anna Rossi', mine: true },
    body: 'Can we have the black ones first?',
    attachments: [{ id: 'f1', name: 'colour-card.pdf', size: '220 KB', href: '/files/f1' }],
    at: '2026-11-04T08:00:00Z',
    atText: '4 Nov, 09:00',
  },
  { id: 'm3', side: 'partner', channel: 'email', author: { name: null, mine: false }, body: '<b>not html</b>', at: '2026-11-05T08:00:00Z', atText: '5 Nov, 09:00' },
]
const base: PartnerThreadProps = { messages: MESSAGES, companyName: 'Studio Alpha' }
const render = (props: Partial<PartnerThreadProps>) => renderToStaticMarkup(createElement(PartnerThread, { ...base, ...props }))

describe('the model', () => {
  it('names the writer: You, the person, our company, or Your team', () => {
    const words = { you: 'You', yourTeam: 'Your team' }
    expect(partnerAuthorName(MESSAGES[1], 'Studio Alpha', words)).toBe('You')
    expect(partnerAuthorName({ side: 'partner', author: { name: ' Luca ', mine: false } }, 'Studio Alpha', words)).toBe('Luca')
    expect(partnerAuthorName(MESSAGES[0], 'Studio Alpha', words)).toBe('Studio Alpha')
    expect(partnerAuthorName(MESSAGES[2], 'Studio Alpha', words)).toBe('Your team')
  })

  it('holds Send while sending, or with nothing to send', () => {
    const words = { sending: 'Sending…', emptyHeld: 'Write first.' }
    expect(partnerSendHeld({ value: 'hi', busy: true }, words)).toBe('Sending…')
    expect(partnerSendHeld({ value: '  ' }, words)).toBe('Write first.')
    expect(partnerSendHeld({ value: '', attached: 1 }, words)).toBeNull()
    expect(partnerSendHeld({ value: 'hi' }, words)).toBeNull()
  })

  it('ticks and unticks a file, in the order of the record’s files', () => {
    const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(partnerToggleFile(['c'], 'a', all)).toEqual(['a', 'c'])
    expect(partnerToggleFile(['a', 'c'], 'a', all)).toEqual(['c'])
  })
})

describe('PartnerThread markup', () => {
  const html = render({
    record: createElement('span', null, 'Your PO 4500-1234 · SO-2026-0042'),
    composer: { value: '', onChange: noop, onSend: noop, hint: 'You can also answer our e-mails.', files: [{ id: 'f1', name: 'colour-card.pdf' }, { id: 'f2', name: 'tech-pack.pdf' }], attached: ['f2'], onAttach: noop },
    loadMore: { onClick: noop },
  })

  it('a heading, the record slot, earlier messages above, the conversation as an ordered list of articles in the order given', () => {
    expect(html).toMatch(/<h3 id="[^"]+" class="nds-pthread-title">Messages<\/h3><div class="nds-pthread-record"><span>Your PO 4500-1234 · SO-2026-0042<\/span>/)
    expect(html.indexOf('Earlier messages')).toBeLessThan(html.indexOf('<ol'))
    expect(html).toMatch(/<ol class="nds-pthread-list" aria-label="Conversation">/)
    expect([...html.matchAll(/<article class="nds-pthread-msg" aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'Message from Studio Alpha, 3 Nov, 10:42',
      'Message from You, 4 Nov, 09:00',
      'Message from Your team, 5 Nov, 09:00',
    ])
  })

  it('says who, how and when; the text is plain (a mail’s markup is shown as text, never as HTML); files are links', () => {
    expect(html).toContain('<span class="nds-pthread-channel">By e-mail</span>')
    expect(html).toContain('<span class="nds-pthread-channel">In the portal</span>')
    expect(html).toContain('<time class="nds-pthread-time" dateTime="2026-11-03T09:42:00Z">3 Nov, 10:42</time>')
    expect(html).toContain('<p class="nds-pthread-body">Your order is confirmed.\nDelivery in week 47.</p>')
    expect(html).toContain('&lt;b&gt;not html&lt;/b&gt;')
    expect(html).toMatch(/<ul class="nds-pthread-files" aria-label="Attached files">.*<a href="\/files\/f1">colour-card\.pdf<\/a><span class="nds-pthread-size">220 KB<\/span>/)
    expect(html).toContain('data-side="partner" data-mine="true"')
  })

  it('the composer: a labelled box, the files to tick, Send, the e-mail hint; nothing written = Send held with why', () => {
    expect(html).toMatch(/<label class="nds-pthread-label" for="([^"]+)">Your message<\/label><textarea class="nds-textarea" id="\1" rows="3"/)
    expect(html).toContain('<legend class="nds-pthread-label">Attach files of this record</legend>')
    expect([...html.matchAll(/type="checkbox"/g)]).toHaveLength(2)
    expect(html).toContain('1 file attached')
    // One file is ticked: Send can go with it.
    expect(html).toMatch(/<button type="submit" class="nds-btn primary">Send<\/button>/)
    const empty = render({ composer: { value: '', onChange: noop, onSend: noop } })
    expect(empty).toMatch(/aria-disabled="true" aria-description="Write a message first."[^>]*>Send<\/button>/)
    expect(html).toContain('You can also answer our e-mails.')
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it('a person who may not write sees why instead of the box; there is no internal-note kind at all', () => {
    const held = render({ composer: { value: '', onChange: noop, onSend: noop, heldReason: 'Your access lets you read this conversation, not write in it.', hint: 'You can also answer our e-mails.' } })
    expect(held).toContain('role="note"')
    expect(held).toContain('Your access lets you read this conversation, not write in it.')
    expect(held).not.toContain('<textarea')
    expect(held).toContain('You can also answer our e-mails.')
    expect(Object.keys(PARTNER_THREAD_LABELS.channels)).toEqual(['email', 'portal', 'app'])
  })

  it('loading, error with Try again, empty — and the host’s words', () => {
    expect(render({ state: 'loading' })).toContain('Reading the messages…')
    expect(render({ state: 'error', onRetry: noop })).toMatch(/role="alert">.*The messages could not be read\..*>Try again<\/button>/)
    expect(render({ messages: [] })).toContain('No messages yet. Ask your question below.')
    const it2 = render({ labels: { title: 'Messaggi', you: 'Tu', messageFrom: (w: string, t: string) => `Messaggio di ${w}, ${t}` } })
    expect(it2).toContain('>Messaggi</h3>')
    expect(it2).toContain('Messaggio di Tu, 4 Nov, 09:00')
  })
})
