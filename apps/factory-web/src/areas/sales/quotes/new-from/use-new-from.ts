'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { getStyle } from '../api'
import { readProblem, writeProblem } from '../problems'
import { getTemplate, listTemplates, openInquiries, quoteFromInquiry, startFromTemplate } from './api'
import { EMPTY_INQUIRY_PICK, EMPTY_TEMPLATE_PICK, inquiryHeld, openLines, startLines, templateHeld, type NewFromKind, type NewFromModel, type StartDone } from './model'
import type { NewFromActions } from './view/NewFrom'

/**
 * New quote › Start from: Template or Inquiry (B-W2b-316), the dialog's container part: the company's templates (and every
 * company's), the chosen template with what its open lines need, the customer's open inquiries; Create makes the quote in
 * ONE call and, when something was left out, says it before the quote opens (else it opens at once).
 */
export function useNewFrom(api: ApiClient, permissions: readonly string[]) {
  const can = { view: permissions.includes('sales.inquiries.view'), manage: permissions.includes('sales.inquiries.manage') }
  const [state, setState] = useState<Omit<NewFromModel, 'inquiries'>>({ active: null, template: null, inquiry: null, done: null })
  const key = useRef(newIdempotencyKey())
  const seq = useRef(0)

  const reset = useCallback(() => {
    key.current = newIdempotencyKey()
    setState({ active: null, template: null, inquiry: null, done: null })
  }, [])

  const readTemplates = (companyId: string, query: string) => {
    const mine = ++seq.current
    setState((current) => ({ ...current, template: { ...(current.template ?? EMPTY_TEMPLATE_PICK), query, results: null, problem: null } }))
    listTemplates(api, { companyId, status: 'ACTIVE', q: query })
      .then((answer) => mine === seq.current && setState((current) => (current.template ? { ...current, template: { ...current.template, results: answer.templates } } : current)))
      .catch((error: unknown) => mine === seq.current && setState((current) => (current.template ? { ...current, template: { ...current.template, problem: readProblem(error) } } : current)))
  }

  const chooseTemplate = (templateId: string) => {
    setState((current) => (current.template ? { ...current, template: { ...current.template, chosenId: templateId, template: { status: 'loading' }, picks: {} } } : current))
    getTemplate(api, templateId)
      .then((template) => {
        setState((current) => (current.template?.chosenId === templateId ? { ...current, template: { ...current.template, template: { status: 'ready', value: template } } } : current))
        for (const styleId of [...new Set(openLines(template).map((line) => line.styleId))]) {
          getStyle(api, styleId)
            .then((style) => setState((current) => (current.template ? { ...current, template: { ...current.template, styles: { ...current.template.styles, [styleId]: { colourways: style.colourways, sizes: style.sizes } } } } : current)))
            .catch(() => setState((current) => (current.template ? { ...current, template: { ...current.template, styles: { ...current.template.styles, [styleId]: null } } } : current)))
        }
      })
      .catch((error: unknown) => setState((current) => (current.template?.chosenId === templateId ? { ...current, template: { ...current.template, template: { status: 'error', problem: readProblem(error) } } } : current)))
  }

  const readInquiries = (partyId: string) => {
    if (!can.view) return
    setState((current) => ({ ...current, inquiry: { ...(current.inquiry ?? EMPTY_INQUIRY_PICK), results: null, problem: null } }))
    openInquiries(api, partyId)
      .then((results) => setState((current) => (current.inquiry ? { ...current, inquiry: { ...current.inquiry, results, chosenId: results.length === 1 ? results[0]!.id : current.inquiry.chosenId } } : current)))
      .catch((error: unknown) => setState((current) => (current.inquiry ? { ...current, inquiry: { ...current.inquiry, problem: readProblem(error) } } : current)))
  }

  /** Start from Template / Inquiry (null: the dialog's own Blank / Past quote). */
  const choose = (kind: NewFromKind | null, ctx: { companyId: string; partyId: string | null }) => {
    key.current = newIdempotencyKey()
    setState((current) => ({ ...current, active: kind, done: null }))
    if (kind === 'template' && !state.template) readTemplates(ctx.companyId, '')
    if (kind === 'inquiry' && ctx.partyId) readInquiries(ctx.partyId)
  }

  /** Why Create waits on this start, or null (the dialog adds its own: the customer, a blocked customer). */
  const held = state.active === 'template' ? templateHeld(state.template) : state.active === 'inquiry' ? inquiryHeld(state.inquiry, can) : null

  /** Create: the quote in one call; opens it, or says what was left out first. */
  const create = async (draft: { companyId: string; partyId: string; contactId: string; customerRef: string }, open: (quoteId: string) => void): Promise<string | null> => {
    try {
      let done: StartDone | null = null
      if (state.active === 'template' && state.template?.template?.status === 'ready') {
        const template = state.template.template.value
        const answer = await startFromTemplate(api, template.id, { companyId: draft.companyId, partyId: draft.partyId, contactId: draft.contactId || null, customerRef: draft.customerRef.trim() || null, lines: startLines(template, state.template.picks) }, key.current)
        done = { quoteId: answer.quote.id, number: answer.quote.number, from: template.name, lines: answer.quote.lines.length, leftOut: answer.leftOut, warnings: answer.warnings.length }
      } else if (state.active === 'inquiry' && state.inquiry) {
        const inquiry = state.inquiry.results?.find((row) => row.id === state.inquiry?.chosenId)
        if (!inquiry) return null
        const answer = await quoteFromInquiry(api, inquiry, draft.customerRef.trim() || null, key.current)
        done = { quoteId: answer.quote.id, number: answer.quote.number, from: inquiry.number, lines: null, leftOut: answer.leftOut, warnings: answer.warnings.length }
      }
      if (!done) return null
      if (done.leftOut.length === 0) open(done.quoteId)
      else setState((current) => ({ ...current, done }))
      return null
    } catch (error) {
      key.current = newIdempotencyKey()
      return writeProblem(error).key
    }
  }

  const model: NewFromModel = { ...state, inquiries: can }
  const actions: NewFromActions = {
    onTemplateSearch: (companyId, query) => readTemplates(companyId, query),
    onTemplatePick: chooseTemplate,
    onLinePick: (lineId, pick) => setState((current) => (current.template ? { ...current, template: { ...current.template, picks: { ...current.template.picks, [lineId]: { ...(current.template.picks[lineId] ?? { colourwayId: '', sizes: {}, skip: false }), ...pick } } } } : current)),
    onInquiryPick: (inquiryId) => setState((current) => (current.inquiry ? { ...current, inquiry: { ...current.inquiry, chosenId: inquiryId } } : current)),
  }
  return { model, actions, choose, held, create, reset, active: state.active }
}
