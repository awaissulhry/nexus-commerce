import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RoleSheetsPrint } from '../../../../../../../areas/plant/risk/role-sheets/RoleSheetsPrint'

export const metadata: Metadata = { title: 'Role sheets · Nexus Factory' }

/** Plant › Risk assessment › Role sheet (print) (a new tab): `?id=<sheet>&id=…`. */
export default function RoleSheetsRoute() {
  return (
    <Suspense>
      <RoleSheetsPrint />
    </Suspense>
  )
}
