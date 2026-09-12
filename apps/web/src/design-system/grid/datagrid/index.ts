/**
 * AGD — the DS `DataGrid` on AG Grid Enterprise, behind the props contract every consumer already
 * speaks. `import { DataGrid } from '@/design-system/grid/datagrid'` is the ONE change a consumer
 * makes; the types are the legacy file's own, re-exported.
 */
export { DataGrid } from './DataGrid'
export type { Column, DataGridProps } from '../../components/DataGrid'
export { dataGridTheme } from './theme'
export { SIZE_GEOMETRY, DATAGRID_SIZES, geometryFor, type DataGridSize, type SizeGeometry } from './geometry'
