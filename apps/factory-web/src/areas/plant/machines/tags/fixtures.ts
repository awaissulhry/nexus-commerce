import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, MACHINE_LIST, NOW } from '../../_shared/fixtures'
import { TagsView, type TagsModel } from './view/TagsView'

/** SCR-150-tags — the machines' QR tags on paper (a new tab from Machines & tools), made-up data only. */

const model = (over: Partial<TagsModel> = {}): TagsModel => ({ person: 'Alex Demo', at: NOW, machines: { value: MACHINE_LIST, problem: null }, ...over })

function TagsDesign({ model }: { model: TagsModel }) {
  return inShell('/plant/machines/tags', createElement(TagsView, { model }))
}

export const designScreen = defineDesignScreen<TagsModel>({
  screen: 'SCR-150-tags',
  title: 'Tag sheet (the machines’ QR tags)',
  view: TagsDesign,
  cases: [
    { id: 'many', label: 'Eight machines: one tag each (the QR holds the asset number)', model: model(), note: 'A station scans the tag to report a problem; the browser prints the sheet.' },
    { id: 'one', label: 'One machine (just made: "Print its tag")', model: model({ machines: { value: [MACHINE_LIST[0]!], problem: null } }) },
    { id: 'none', label: 'No machine to tag', model: model({ machines: { value: [], problem: null } }) },
    { id: 'loading', label: 'Still reading', model: model({ machines: { value: null, problem: null } }) },
    { id: 'error', label: "The machines couldn't be read", model: model({ machines: { value: null, problem: 'problem.notFound' } }) },
  ],
})
