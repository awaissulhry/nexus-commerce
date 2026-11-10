import { z } from 'zod'
import { groupListView, groupView, styleOptionsView, withdrawnView, type CreateEffectBody, type CreateGroupBody, type CreateValueBody, type GroupListView, type GroupView, type StyleOptionsView, type UpdateEffectBody, type UpdateGroupBody, type UpdateValueBody } from '@nexus/factory-domain/product/options/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Products › Options & rules (B-W2b-242, SCR-114): every call of the page and the option group's record, each answer
 * checked against factory-domain's own contracts (apps/factory-api modules/product/options, B-W2b-229). Every write of
 * the library answers the whole group (its values, rules, effects and the styles that offer it), so the record takes the
 * answer as it is; a style's offer answers the style's options and the record reads the group again.
 *
 * Versions: the group's own fields, archive and rules send the GROUP's version; a value's fields, archive, effects and
 * price send the VALUE's; an offer sends the offer's (null: a new offer).
 */

export type { GroupListView, GroupView, StyleOptionsView }

const enc = encodeURIComponent
const groupPath = (groupId: string) => `/product/option-groups/${enc(groupId)}`
const valuePath = (groupId: string, valueId: string) => `${groupPath(groupId)}/values/${enc(valueId)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })
const groupAnswer = z.object({ group: groupView })
const optionsAnswer = z.object({ options: styleOptionsView })

export const listGroups = (api: ApiClient, query: Record<string, string | undefined>, signal?: AbortSignal): Promise<GroupListView> => api.get('/product/option-groups', { query, schema: groupListView, signal })

export const getGroup = (api: ApiClient, groupId: string, signal?: AbortSignal): Promise<GroupView> => api.get(groupPath(groupId), { schema: groupAnswer, signal }).then((answer) => answer.group)

export const createGroup = (api: ApiClient, body: CreateGroupBody): Promise<GroupView> => api.post('/product/option-groups', { body, schema: groupAnswer, ...key() }).then((answer) => answer.group)

export const updateGroup = (api: ApiClient, groupId: string, body: UpdateGroupBody): Promise<GroupView> => api.request('PATCH', groupPath(groupId), { body, schema: groupAnswer, ...key() }).then((answer) => answer.group)

export const moveGroup = (api: ApiClient, group: { id: string; version: number }, to: 'archive' | 'restore', reason?: string): Promise<GroupView> =>
  api.post(`${groupPath(group.id)}/${to}`, { body: { version: group.version, ...(reason ? { reason } : {}) }, schema: groupAnswer, ...key() }).then((answer) => answer.group)

export const addValue = (api: ApiClient, groupId: string, body: CreateValueBody): Promise<GroupView> => api.post(`${groupPath(groupId)}/values`, { body, schema: groupAnswer, ...key() }).then((answer) => answer.group)

export const updateValue = (api: ApiClient, groupId: string, valueId: string, body: UpdateValueBody): Promise<GroupView> =>
  api.request('PATCH', valuePath(groupId, valueId), { body, schema: groupAnswer, ...key() }).then((answer) => answer.group)

export const moveValue = (api: ApiClient, groupId: string, value: { id: string; version: number }, to: 'archive' | 'restore', reason?: string): Promise<GroupView> =>
  api.post(`${valuePath(groupId, value.id)}/${to}`, { body: { version: value.version, ...(reason ? { reason } : {}) }, schema: groupAnswer, ...key() }).then((answer) => answer.group)

/** The rules' body as the screen sends it (factory-domain rulesBody's input). */
export interface RulesInput {
  version: number
  rules: Array<{
    id?: string
    when: { combinator: 'and' | 'or'; rows: Array<{ id: string; field: string | null; operator: string | null; value: string | string[] | null }> }
    kind: 'REQUIRES' | 'EXCLUDES'
    otherValueId: string
    severity: 'BLOCK' | 'WARN'
    message?: { it?: string; en?: string } | null
    status: 'ACTIVE' | 'ARCHIVED'
  }>
}

export const setRules = (api: ApiClient, groupId: string, body: RulesInput): Promise<GroupView> => api.request('PUT', `${groupPath(groupId)}/rules`, { body, schema: groupAnswer, ...key() }).then((answer) => answer.group)

export const addEffect = (api: ApiClient, groupId: string, valueId: string, body: CreateEffectBody): Promise<GroupView> =>
  api.post(`${valuePath(groupId, valueId)}/effects`, { body, schema: groupAnswer, ...key() }).then((answer) => answer.group)

export const updateEffect = (api: ApiClient, groupId: string, valueId: string, effectId: string, body: UpdateEffectBody): Promise<GroupView> =>
  api.request('PATCH', `${valuePath(groupId, valueId)}/effects/${enc(effectId)}`, { body, schema: groupAnswer, ...key() }).then((answer) => answer.group)

export const removeEffect = (api: ApiClient, groupId: string, value: { id: string; version: number }, effectId: string): Promise<GroupView> =>
  api.request('DELETE', `${valuePath(groupId, value.id)}/effects/${enc(effectId)}`, { query: { version: String(value.version) }, schema: groupAnswer, ...key() }).then((answer) => answer.group)

/** A value's price surcharge (money.price): an amount in a currency, a percent of the price, or neither (none). */
export interface PriceInput {
  version: number
  priceDelta?: string
  currency?: string
  pricePct?: string
}

export const setPrice = (api: ApiClient, groupId: string, valueId: string, body: PriceInput): Promise<GroupView> =>
  api.request('PUT', `${valuePath(groupId, valueId)}/price`, { body, schema: groupAnswer, ...key() }).then((answer) => answer.group)

/** A style's options: its offers in the configurator's order, its option BOM lines and routing steps (product.styles.view). */
export const styleOptions = (api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleOptionsView> => api.get(`/product/styles/${enc(styleId)}/options`, { schema: optionsAnswer, signal }).then((answer) => answer.options)

/** Offer a group on a style (version null) or change the offer's picks (the offer's version); product.styles.manage, the style's edit rule. */
export const offerGroup = (api: ApiClient, styleId: string, groupId: string, body: { version: number | null; minPicks?: number | null; maxPicks?: number | null }): Promise<StyleOptionsView> =>
  api.request('PUT', `/product/styles/${enc(styleId)}/options/${enc(groupId)}`, { body, schema: optionsAnswer, ...key() }).then((answer) => answer.options)

export type Withdrawn = z.infer<typeof withdrawnView>

/** Withdraw a style's offer: removed when nothing of the style names its values, else archived (the words say how many). */
export const withdrawOffer = (api: ApiClient, styleId: string, groupId: string, version: number): Promise<Withdrawn> =>
  api.post(`/product/styles/${enc(styleId)}/options/${enc(groupId)}/withdraw`, { body: { version }, schema: withdrawnView, ...key() })
