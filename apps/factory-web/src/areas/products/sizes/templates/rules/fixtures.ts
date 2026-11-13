import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { PREFIX } from '../../../library/demo'
import { canOf, SUIT, SUIT_RULES } from '../demo/fixtures'
import { TemplateRecordView, type TemplateRecordModel } from '../record/view/TemplateRecordView'
import { draftOf, newRuleDraft, withKind, type RulesDraft } from './model'
import type { RulesEditModel } from './use-rules'

/**
 * SCR-049-template-rules — a measurement template's rule editor (B-W2b-371, XF2:05; B-W2b-248's plausibility and ratio rules, typed,
 * not only shown) with made-up data only (an invented race suit): the rules read with Edit rules (open while made-to-measure is
 * off: that is when the rules are made); the editor with its four rules (an order, a ratio, a range, one not checked), a new rule
 * being typed, the base size rule and the points' limits; Save held while a field needs a fix (each said where it is); refused by
 * the server at a field; a moved version (read again); saved; Edit held for a role without the right, and on an archived template.
 * In the browser every field works for real.
 */

const base: TemplateRecordModel = { prefix: PREFIX, can: canOf('owner'), tab: 'mtm', template: { status: 'ready', value: SUIT }, rules: { value: SUIT_RULES, problem: null }, edit: null, dialog: null, notice: null, changed: null, busy: false }
const open = (draft: RulesDraft, over: Partial<RulesEditModel> = {}): TemplateRecordModel => ({ ...base, rulesEdit: { draft, busy: false, fields: {}, notice: null, ...over } })
const draft = draftOf(SUIT_RULES)
const typed: RulesDraft = { ...draft, rules: [...draft.rules, { ...withKind(newRuleDraft(SUIT_RULES.points), 'RATIO'), key: 'new-design-1', code: 'SLEEVE_TO_HEIGHT', pointCode: 'sleeve', otherPointCode: 'height', minFactor: '0.30', maxFactor: '0.40', severity: 'WARN', it: 'Manica e altezza non tornano: ricontrolla.', en: 'Sleeve and height do not match: check them again.' }] }
const broken: RulesDraft = { ...draft, rules: [...draft.rules, { ...newRuleDraft(SUIT_RULES.points), key: 'new-design-2', code: 'INSEAM_LE_OUTSEAM', kind: 'ORDER', pointCode: 'wrist', otherPointCode: 'sleeve' }], limits: draft.limits.map((limit) => (limit.code === 'chest' ? { ...limit, alterationPlus: '-3' } : limit)) }

function RulesDesign({ model: design }: { model: TemplateRecordModel }) {
  const [model, setModel] = useState(design)
  useEffect(() => setModel(design), [design])
  const change = (next: (now: RulesDraft) => RulesDraft) => setModel((now) => (now.rulesEdit?.draft ? { ...now, rulesEdit: { ...now.rulesEdit, draft: next(now.rulesEdit.draft), fields: {} } } : now))
  return createElement(TemplateRecordView, {
    model,
    actions: {
      rulesEdit: {
        onOpen: () => setModel((now) => ({ ...now, rulesEdit: { draft: draftOf(SUIT_RULES), busy: false, fields: {}, notice: null } })),
        onCancel: () => setModel((now) => ({ ...now, rulesEdit: null })),
        onRule: (key, patch) => change((now) => ({ ...now, rules: now.rules.map((rule) => (rule.key !== key ? rule : patch.kind && patch.kind !== rule.kind ? withKind({ ...rule, ...patch }, patch.kind) : { ...rule, ...patch })) })),
        onAddRule: () => change((now) => ({ ...now, rules: [...now.rules, newRuleDraft(SUIT_RULES.points)] })),
        onRemoveRule: (key) => change((now) => ({ ...now, rules: now.rules.filter((rule) => rule.key !== key) })),
        onBasePoints: (points) => change((now) => ({ ...now, basePoints: [...points] })),
        onTie: (tie) => change((now) => ({ ...now, tie })),
        onLimit: (code, patch) => change((now) => ({ ...now, limits: now.limits.map((limit) => (limit.code === code ? { ...limit, ...patch } : limit)) })),
        onSave: () => setModel((now) => ({ ...now, rulesEdit: { draft: null, busy: false, fields: {}, notice: { key: 'rules.done', tone: 'success' } } })),
      },
    },
  })
}

export const designScreen = defineDesignScreen<TemplateRecordModel>({
  screen: 'SCR-049-template-rules',
  title: 'Measurement template › Made-to-measure › Edit rules',
  view: RulesDesign,
  cases: [
    { id: 'read', label: 'The rules read, Edit rules offered (made-to-measure off: the rules are made now)', model: base },
    { id: 'editor', label: 'The editor: an order, a ratio, a range and one not checked; the base size from chest then height; the limits', model: open(draft) },
    { id: 'typed', label: 'A new ratio rule typed (sleeve ÷ height, Warns, its words): 1 change to save', model: open(typed) },
    { id: 'held', label: 'Save held: a code twice, the wrist (mm) never above the sleeve (cm), no words, a limit below 0 (each said where it is)', model: open(broken) },
    { id: 'refused', label: 'Refused by the server at a field (said there)', model: open(typed, { fields: { 'new-design-1/minFactor': { key: 'rules.problem.factor' } }, notice: { key: 'rules.held.fix_other', params: { count: 1 }, tone: 'danger' } }) },
    { id: 'stale', label: 'Someone changed the template meanwhile: the rules read again', model: open(draft, { notice: { key: 'rules.problem.stale', tone: 'danger' } }) },
    { id: 'saving', label: 'Saving (held while the one write runs)', model: open(typed, { busy: true }) },
    { id: 'saved', label: 'Saved (the receipt beside Edit rules)', model: { ...base, rulesEdit: { draft: null, busy: false, fields: {}, notice: { key: 'rules.done', tone: 'success' } } } },
    { id: 'no-right', label: 'Sales (reads): Edit rules held with why', model: { ...base, can: canOf('sales') } },
    { id: 'archived', label: 'Archived template: Edit rules held (restore it first)', model: { ...base, template: { status: 'ready', value: { ...SUIT, status: 'ARCHIVED' } }, rules: { value: { ...SUIT_RULES, template: { ...SUIT_RULES.template, status: 'ARCHIVED' }, editable: false }, problem: null } } },
  ],
})
