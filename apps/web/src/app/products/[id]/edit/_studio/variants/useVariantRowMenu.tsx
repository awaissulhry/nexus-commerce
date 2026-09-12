'use client'

import { actionMenuItems, useActionPress } from '@/design-system/grid'
import { useAuth } from '@/lib/auth/AuthProvider'
import { familyActions } from '../sheet/master/familyActions'
import { familyOps } from '../sheet/master/familyOps'
import { useFamily } from '../sheet/master/useFamily'
import { useFamilyProductPicker } from '../sheet/master/FamilyProductPicker'
import type { StudioRow } from '../sheet/master/types'

/** Channel row verbs use the Information sheet's registry and preflight/confirmation flow. */
export function useVariantRowMenu(productId: string, onChanged: () => void) {
  const family = useFamily(productId)
  const picker = useFamilyProductPicker(productId)
  const { has, status } = useAuth()
  const press = useActionPress<StudioRow>(() => { family.reload(); onChanged() })
  const actions = familyActions({ family: family.family, ops: familyOps, can: has, authStatus: status, pickProduct: picker.pick })
  const menu = actionMenuItems<StudioRow>({ actions, onSelect: (action, rows) => void press.press(action, rows), isRecord: row => !!row?.id })
  return { menu, actions, elements: <>{picker.element}{press.confirmElement}{press.problem && <p role="alert">{press.problem}</p>}</> }
}
