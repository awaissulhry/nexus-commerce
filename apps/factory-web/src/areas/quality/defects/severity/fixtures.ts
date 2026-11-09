import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, type RoleCase } from '../../_shared/fixtures'
import { QualityMessages } from '../../_shared/parts'
import { SEVERITY, SEVERITY_OWN } from '../demo/vocabulary'
import { DEFECT_NAMESPACES } from '../view/parts'
import type { Severity } from './api'
import { bodyOf, draftOf, draftProblems, withCell, type SeverityEdit } from './model'
import { SeverityWordsView, type SeverityWordsModel } from './view/SeverityWordsView'

/**
 * B-W2b-213 (SCR-273): Quality › Defects & dispositions › Severity with the tenant's words (design quality.defects
 * df-severity, EditModeBar for the texts; QHS-002). Made-up words only ("(demo)"). In the browser Edit, typing, Discard
 * and Save work on the case's own copy (Save keeps the words as if the API took them).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: SeverityWordsModel
}

const read = (value: Severity | null, problem: string | null = null) => ({ value, problem })
const editing = (severity: Severity, change: (edit: SeverityEdit) => SeverityEdit = (edit) => edit): SeverityEdit => change({ draft: draftOf(severity), busy: false, problem: null })
const TOO_LONG = 'Un difetto che fa probabilmente fallire il capo nel suo uso quotidiano oppure lo fa rendere dal cliente (demo, troppo lungo)'

function SeverityDesign({ model: design }: { model: DesignModel }) {
  const [current, setCurrent] = useState<SeverityWordsModel>(design.model)
  useEffect(() => setCurrent(design.model), [design])
  const severity = current.read.value
  const setEdit = (edit: SeverityEdit | null) => setCurrent((model) => ({ ...model, edit }))
  return inShell(
    '/quality/defects',
    createElement(
      QualityMessages,
      { namespaces: DEFECT_NAMESPACES },
      createElement(SeverityWordsView, {
        model: current,
        actions: {
          onEdit: () => severity && severity.canManage && setEdit(editing(severity)),
          onDraft: (draft) => current.edit && setEdit({ ...current.edit, draft, problem: null }),
          onDiscard: () => setEdit(null),
          onSave: () => {
            if (!severity || !current.edit) return
            if (draftProblems(current.edit.draft).length > 0) return
            const texts = bodyOf(severity, current.edit.draft).texts ?? {}
            const classes = severity.classes.map((row) => {
              const own = { words: { ...(texts[row.class]?.words ?? {}) }, meaning: { ...(texts[row.class]?.meaning ?? {}) } }
              const standard = row.standard ?? { words: row.words, meaning: row.meaning }
              return { ...row, own, words: { it: own.words.it ?? standard.words.it, en: own.words.en ?? standard.words.en }, meaning: { it: own.meaning.it ?? standard.meaning.it, en: own.meaning.en ?? standard.meaning.en } }
            })
            setCurrent({ read: read({ ...severity, classes, version: severity.version + 1 }), edit: null })
          },
        },
      }),
    ),
    design.role,
  )
}

const page = (model: SeverityWordsModel, role: RoleCase = 'owner'): DesignModel => ({ role, model })

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-273',
  title: 'Quality › Defects & dispositions › Severity words (B-W2b-213)',
  view: SeverityDesign,
  holdsPage: true,
  cases: [
    { id: 'standard', label: 'Read: the standard words of the three classes; critical locked with its law; Edit words', model: page({ read: read(SEVERITY), edit: null }) },
    { id: 'own', label: "Read: the factory's own words (major renamed in three languages, critical called otherwise in English)", model: page({ read: read(SEVERITY_OWN), edit: null }) },
    { id: 'editing', label: 'Editing: per class and language the words and the meaning; empty = the standard words (the placeholder); critical meaning locked', model: page({ read: read(SEVERITY_OWN), edit: editing(SEVERITY_OWN) }) },
    {
      id: 'edited',
      label: 'Editing: two changes waiting (EditModeBar: 2 unsaved changes, Save with ⌘S)',
      model: page({ read: read(SEVERITY_OWN), edit: editing(SEVERITY_OWN, (edit) => ({ ...edit, draft: withCell(withCell(edit.draft, 'MINOR', 'words', 'ro', 'Minor (demo)'), 'MINOR', 'meaning', 'en', 'Does not touch use or safety (demo words).') })) }),
    },
    {
      id: 'problems',
      label: 'Editing: a meaning too long, shown at its box; Save held with why',
      model: page({ read: read(SEVERITY_OWN), edit: editing(SEVERITY_OWN, (edit) => ({ ...edit, draft: withCell(edit.draft, 'MAJOR', 'meaning', 'it', TOO_LONG.repeat(5))})) }),
    },
    { id: 'saving', label: 'Saving (the bar busy)', model: page({ read: read(SEVERITY_OWN), edit: editing(SEVERITY_OWN, (edit) => ({ ...edit, draft: withCell(edit.draft, 'MINOR', 'words', 'ro', 'Minor (demo)'), busy: true})) }) },
    { id: 'refused', label: 'Refused: someone changed the words meanwhile (stale), in words', model: page({ read: read(SEVERITY_OWN), edit: editing(SEVERITY_OWN, (edit) => ({ ...edit, draft: withCell(edit.draft, 'MINOR', 'words', 'ro', 'Minor (demo)'), problem: { key: 'problem.stale' }})) }) },
    { id: 'no-permission', label: 'Production manager: reads the words; Edit held with the permission it needs', model: page({ read: read({ ...SEVERITY_OWN, canManage: false }), edit: null }, 'production') },
    { id: 'loading', label: 'Loading', model: page({ read: read(null), edit: null }) },
    { id: 'error', label: "The API didn't answer", model: page({ read: read(null, 'problem.offline'), edit: null }) },
  ],
})
