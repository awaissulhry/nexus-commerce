'use client';
import { useSheetPreferences } from '../useSheetPreferences';
import { useDeleteRows } from '../deleteRows/useDeleteRows';
import { useUnpinOnNarrowSheet } from '../useNarrowSheet';
import { useSheetPublicationGuard } from '../useSheetPublicationGuard';
import { buildCompareTargets } from '../compareTargets';
import { channelLabel, languageLabel } from '../../scopes';
import { productSheetRowKey, filterProductSheetRows } from '../productSheetRows';
import { useSheetChips } from '../useSheetChips';
import { useSheetSaveStatus } from '../useSheetSaveStatus';
import { useSheetUndo } from '../useSheetUndo';
import { useSheetGridBindings } from '../useSheetGridBindings';
import { useProductSheetInteraction } from '../useProductSheetInteraction';
import { useSheetGeometry } from '../useSheetGeometry';
import type { ProductSheetModel } from '../productSheetModel';
import { formulaCandidates, formulaColumnId } from '../formulaColumns';
import { sheetEmptyState } from '../sheetGridStates';
import { useHeaderPaste } from '../headerPaste';
import { chooseCategoryLink, FAMILY_UNSET, setupSentence } from '../channel/rulesStatus';
import Link from '@/lib/workspaces/Link';
import { formulaTransfer, type CellEditorContext } from '@/design-system/grid';
import { aiDraftContextOf, historyLoaderFor, inheritedContextOf } from '../cellEditorContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { Banner } from '@/design-system/components';
import { Button, InfoTip, Pill } from '@/design-system/primitives';
import { SheetTransfer } from '../../transfer/SheetTransfer';
import { FormulaBulkDialog } from '../FormulaBulkDialog';
import { FormulaHistoryDialog } from '../FormulaHistoryDialog';
import { ExpandButton, ExpandSlot, IdentityBand, BAND_WIDTH_FLOOR, useExpanded, ProvenanceMark, actionContextMenu, actionMenuItems, useActionConfirm, useActionPress, GridExportRefused, writeGate, exprOf, isFormulaDraft, landOnCell, type FormulaCandidate, type ColDef, type ICellRendererParams, type PrefsBridgeOptions } from '@/design-system/grid';
import { getBackendUrl } from '@/lib/backend-url';
import { ClassificationDialog } from './ClassificationDialog';
import { SCOPE_PROGRESS_COLUMN, SHARED_PROGRESS_TIP, coordinateProgressValue, coordinateReadinessColumns, listingsHref, progressColumn, progressSheetColumn, refreshProgressItem, rowProgressValue, sheetFieldAction, studioFieldHref, withoutProgressColumns, type ColumnPresence } from '../progressColumns';
import { useStudioScope, useSaveReporter, useStudioRecord, useScopeReadiness, useReadinessRefresh, useViewChips, viewChipHasCell } from '../../contracts';
import { type RecordWriteRequest, type RecordWriteResult, type SheetRow as DrawerSheetRow } from '../../drawer';
import { AiDraftReview, useAiDraftLayer } from '../../ai';
import { buildSheetColumns } from '../buildSheetColumns';
import { ProductRoleChip } from '../ProductRoleChip';
import { identitySecondary, secondaryPlan, type SecondaryPlan } from './identitySecondary';
import type { MenuItemDef } from '@/design-system/components';
import { reloadImpact } from './reloadGuard';
import { familySummaryOf, useFamilyVerbs } from './FamilyBar';
import type { NewVariationDraft } from './addVariation';
import { useFamilyProductPicker } from './FamilyProductPicker';
import { familyActions } from './familyActions';
import { familyOps } from './familyOps';
import { FamilySelectionVerbs } from './FamilySelectionBar';
import { useFamily } from './useFamily';
import { useCellFormulas } from '../../useCellFormulas';
import { HELD_EDIT_DROPPED, HELD_FOR_FORMULAS } from '../../formulaReadiness';
import { cellOf, editRefusalReason } from './columnRules';
import type { SheetColumn, StudioRow } from './types';
import { useMasterSheet } from './useMasterSheet';
import { sharedCellDetailsSource, type SharedCellDetailsContext } from './sharedCellDetails';
import { mediaGridTransfer } from '../../media/mediaGridTransfer';
import { productMediaColumn, useProductMediaEditor, withProductMediaColumn, PRODUCT_MEDIA_COLUMN } from '../../media/productMediaColumn';
import { withSheetGroups } from '../sheetGroups';
import { useReferenceNames } from '../useReferenceNames';
import { referenceSearchText } from '../referenceLabels';
import { flaggedColumnKeys, IDENTITY_COLUMN, orderColumnKeys, rankOfColumn, RESERVED_COLUMN_IDS } from '../views';
import { useLanguageChips } from '../useLanguageChips';
import { useSheetColumns } from '../useSheetColumns';
import { exportGridCsv } from '@/design-system/grid/export/exportGrid';
import { useSheetControl } from '../useSheetControl';
import { controlColumnFacts, isClearKey, masterResetOffer, selectedCells } from '../sheetReset';
import type { PublishActionCell, PublishActionChange } from '@nexus/shared/publish-actions';
import { CellSaveTracker, SELLING_ROW_MARK_CLASS, UNSAVED_ROW_CLASS, isUnsavedRowData, rowCarriesInactiveMark, waitingWhen } from '@/design-system/grid';
import { PublishActionFence, SKIP_CELL, groupStaged, isInactiveCell, isWaitingCell, usePublishActions, waitingStatusMark, withoutSameNewChoice, type PublishActionWriteOutcome, type PublishCellInput, type PublishWriteGroup, type StagedPublishCell } from '../usePublishActions';
import { STATUS_COLUMN, type PublishCellReadState } from '../channel/statusColumn';
import { ACTION_COLUMN, PublishActionMenu } from '../channel/actionColumn';
import { ACTION_ROLE_CANNOT_PUBLISH } from '../channel/channelActions';
import { cellsByProduct, type RecordSelling } from '../../SellingSummary';
import { sharedStatusColumn, sharedStatusSheetColumn } from './sharedStatusColumn';
import { listingLabel, sharedActionColumn, sharedActionMenuEntries, sharedActionSheetColumn, sharedDeleteImpact, sharedDeletedRefusal, sharedOperationToast } from './sharedActionColumn';
import { useToast } from '@/design-system/components';
import type { SheetExportMode } from '../sheetExport';
import { useIdentitySkuColumn } from '../identitySkuColumn';
import { skuRenameMessage, type IdentitySkuScope, type SkuRename } from '../identitySkuEdit';
import { useStudioSkuRenamed } from '../../contracts';
import { NewRowCell } from '../newRows/NewRowCell';
import { NewRowsControl } from '../newRows/NewRowsControl';
import { newRowsContextMenu, newRowsGridKey, newRowsPaste, useNewRows, variationTarget, type NewRowsStore } from '../newRows/useNewRows';
import { lockedOnNewRows, newRowRefusal, sharedNewRow, unsavedOf, withNewRows } from '../newRows/newRowsGrid';
import type { NewRowKind } from '../newRows/newRows';
/** Progress columns — a coordinate column's key, from its readiness column id (`ready:AMAZON:IT:acc:it` → `progress:…`). */
/* A coordinate's progress column keeps ONE id whatever language is pressed (the trailing `:<language>` is dropped), so a
   layout that hides or pins it keeps doing so in every language. */
const progressKeyOf = (readyColId: string) => `progress:${readyColId.slice('ready:'.length).replace(/:[^:]+$/, '')}`;
const marketProgressTip = (label: string, language: string, computedAt: string | null) =>
    `Progress on ${label} in ${language}: filled ÷ every field ${label} applies, required and optional, from the readiness index${computedAt ? ` (computed ${new Date(computedAt).toLocaleString()})` : ''}. Red — a required field is empty. Yellow — only optional fields are empty. Green — nothing is empty. Grey — not computed yet, which is not a score. Completeness, not publish readiness.`;

export interface MasterSheetProps {
    productId: string;
    market: string;
    locale: string;
    variationAxes?: string[];
}
function ProductCell(p: ICellRendererParams<StudioRow> & {
    secondaryRef?: {
        current: SecondaryPlan;
    };
    rowMenuRef?: {
        current: (row: StudioRow) => MenuItemDef[];
    };
    /** S11 — the SKU as the editable first column draws it (save marks). */
    identityRef?: {
        current: (row: StudioRow) => React.ReactNode;
    };
    /** Add rows — an empty row draws its own cell (SKU so far, state, remove). */
    newRows?: NewRowsStore;
}) {
    const expanded = useExpanded(p.node);
    const fresh = unsavedOf(p.data);
    if (fresh)
        return <NewRowCell row={fresh} expand={<ExpandSlot />} onRemove={(id) => p.newRows?.remove(id)}/>;
    const d = p.data;
    if (!d)
        return null;
    const parent = d.isParent;
    const expander = parent && d.childCount > 0 ? (<ExpandButton expanded={expanded} onToggle={() => p.node.setExpanded(!expanded)} labels={['Expand children', 'Collapse children']}/>) : (<ExpandSlot />);
    const role = <ProductRoleChip product={d}/>;
    const line = p.secondaryRef ? identitySecondary(d, p.secondaryRef.current) : d.name;
    return (<IdentityBand expand={expander} role={role} image={d.imageUrl} photoCount={d.imageInherited ? undefined : d.photoCount} noImage={!d.imageUrl} imageMark={d.imageInherited ? (<ProvenanceMark provenance="inherited" tooltip="Inherited from the family's picture — this variation has none of its own"/>) : null} sku={p.identityRef ? p.identityRef.current(d) : d.sku} secondary={line} secondaryTitle={line ?? undefined} menuItems={p.rowMenuRef?.current(d)} menuLabel={`Actions for ${d.sku}`}/>);
}
interface SheetPageState {
    search: string;
}
const NO_VARIATION_AXES: readonly string[] = [];
const NO_KEYS: readonly string[] = [];
/** What the Shared scope is called on screen (the scope chip, the progress column). */
const SHARED_SCOPE_LABEL = 'Shared product';
/** Build shape v2, P9 — the shared scope reads the waiting Status and Action values of every market of the family. */
const SHARED_DESTINATION = {};
const NO_CELLS: readonly PublishActionCell[] = [];
/** S11 — the Shared scope's first column renames the product SKU. */
const SHARED_SKU_SCOPE: IdentitySkuScope = { kind: 'shared' };
/** Add rows — the Shared scope adds variations. */
const SHARED_ROW_KINDS: readonly NewRowKind[] = ['variation'];
export function useMasterSheetAdapter({ productId, market, locale, variationAxes = NO_VARIATION_AXES as string[] }: MasterSheetProps): ProductSheetModel<StudioRow, SheetPageState, DrawerSheetRow> {
    const { apiRef, gridReady, getGridApi, bindGridApi, releaseGrid, search, setSearch, showRefusedOnly, setShowRefusedOnly, lastDataCell, refusalReason, onCellFocused, onCellDoubleClicked, onCellKeyDown, onSelectionChanged, clearSelection, rowSelection, selectedRows, setSelectedRows, announceRefusals } = useProductSheetInteraction<StudioRow>('master');
    const savedAtRef = useRef<(at: string) => void>(() => undefined);
    const languageScope = useStudioScope();
    /* LX.FIN (R-LX-22) — the same readiness read the scope chips use; no second request. */
    const readinessQuery = useScopeReadiness();
    const readinessMatrix = readinessQuery.status === 'ready' ? readinessQuery.matrix : undefined;
    /* TOOLBAR REBUILD (2026-09-27) — the channel · market bars are read again after every confirmed save (the server
       rebuilds the index inside the write), on Reload and on "Refresh progress". A burst of saves asks once. */
    const refreshReadiness = useReadinessRefresh();
    const readinessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (readinessTimer.current) clearTimeout(readinessTimer.current); }, []);
    const refreshReadinessSoon = useCallback(() => {
        if (readinessTimer.current) clearTimeout(readinessTimer.current);
        readinessTimer.current = setTimeout(() => { readinessTimer.current = null; refreshReadiness(); }, 800);
    }, [refreshReadiness]);
    const readinessRef = useRef(readinessQuery);
    readinessRef.current = readinessQuery;
    const reporter = useSaveReporter();
    const record = useStudioRecord();
    const columnByKeyRef = useRef<Map<string, SheetColumn>>(new Map());
    const onWriteStart = useCallback((id: string, rowId: string) => reporter.pending(id, rowId), [reporter]);
    const onWriteEnd = useCallback((id: string, ok: boolean, msg?: string, rowId?: string) => reporter.resolved(id, ok, msg, rowId), [reporter]);
    const onSettled = useCallback(({ ok, savedAt }: {
        rowId: string;
        ok: boolean;
        savedAt: string;
    }) => {
        if (ok) {
            savedAtRef.current(savedAt);
            refreshReadinessSoon();
        }
    }, [refreshReadinessSoon]);
    /* The family read (`useFamily`, below) is refreshed after an accepted theme save — the family bar and "Add child" read
       the axes from it. A ref, because that read is created after this hook. */
    const reloadFamilyRef = useRef<() => void>(() => undefined);
    /* S11 — a Shared rename the server made: its sentence about the channels, and the studio's header shows the new SKU. */
    const skuRenamedRef = useRef<(renames: SkuRename[]) => void>(() => undefined);
    const studioSkuRenamed = useStudioSkuRenamed();
    const { sheet: loadedSheet, loading, switching, error, contractProblems, reload, refresh, writer, tracker, conflicts, bindGrid } = useMasterSheet({
        productId, market, locale, locales: languageScope.locales, onWriteStart, onWriteEnd, onSettled,
        onVariationThemeSaved: () => reloadFamilyRef.current(),
        /* R-VT-15 — the server's refusal sentence, said the moment it arrives, through the ONE DS
           toast provider this route mounts (`_studio/StudioClient.tsx`; the root layout's is the old
           library's — `reference_ds_toast_two_providers`). `announceRefusals` is the shared
           implementation in `useProductSheetInteraction`, so both scopes and both moments (fresh
           refusal, and returning to a marked cell) say it one way. */
        onRefused: announceRefusals,
        onSkuRenames: (renames) => skuRenamedRef.current(renames),
    });
    const sheet = useReferenceNames(loadedSheet, 'MASTER', market);
    useSheetPublicationGuard(writer, tracker, getGridApi);
    const formulaRowIds = useMemo(() => (sheet?.rows ?? []).map((r) => r.id), [sheet]);
    /* P0 — the studio read's rows already say which cells hold a formula. Not a legacy read (it carries none) and not the
       previous language's sheet, which stays on screen while the next one loads. */
    const formulaSeedRows = useMemo(() => sheet?.meta.source === 'studio' && sheet.scope.locale === locale ? sheet.rows.map(row => ({ rowId: row.id, values: row.values })) : undefined, [sheet, locale]);
    const formulas = useCellFormulas({ writeFacts: (rowId, fieldKey) => sheet?.rows.find(row => row.id === rowId)?.values[fieldKey], productId, market, locale, columnKeys: sheet?.columns.map(column => column.key), rowIds: formulaRowIds, seedRows: formulaSeedRows, onSettled: refresh, onValueSaved: (rowId, fieldKey, value) => {
            const node = getGridApi()?.getRowNode(rowId);
            if (!node?.data)
                return;
            const cell = node.data.values?.[fieldKey];
            if (cell)
                node.data.values = { ...node.data.values, [fieldKey]: { ...cell, value } };
            getGridApi()?.refreshCells({ rowNodes: [node], columns: [fieldKey], force: true });
        } });
    const candidatesFor = useCallback((row: StudioRow, fieldKey?: string): FormulaCandidate[] => {
        const cols = formulaCandidates(sheet?.columns ?? [], row.values, fieldKey, locale ?? '');
        const fns = formulas.functions.map((f) => ({
            name: f.name,
            kind: 'function' as const,
            label: f.signature,
            group: 'Functions',
        }));
        return [...cols, ...fns];
    }, [sheet, formulas.functions, locale]);
    const colIdOfRef = useCallback((name: string, fieldKey?: string): string | null => formulaColumnId(sheet?.columns ?? [], name, fieldKey, locale), [sheet, locale]);
    const formulaLive = useRef({ candidatesFor, formulas, colIdOfRef });
    formulaLive.current = { candidatesFor, formulas, colIdOfRef };
    /* Option A (2026-09-26) — the cell editor's AI draft, history and "follows" context. Assigned below, once the AI layer
       and the drawer scope exist; read through this ref so the wiring stays one stable object. */
    const editorContextLive = useRef<(row: StudioRow, key: string) => CellEditorContext | null>(() => null);
    const formulaWiring = useMemo(() => ({
        candidatesFor: (row: StudioRow, fieldKey?: string) => formulaLive.current.candidatesFor(row, fieldKey),
        preview: (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal) => formulaLive.current.formulas.preview(rowId, fieldKey, expr, signal),
        functions: () => formulaLive.current.formulas.functions,
        replaceFormula: (rowId: string, fieldKey: string, value: unknown) => formulaLive.current.formulas.replace(rowId, fieldKey, value),
        unavailableReason: (rowId: string | undefined, fieldKey: string) => formulaLive.current.formulas.unavailableFor(rowId, fieldKey),
        retry: () => formulaLive.current.formulas.reload(),
        sourceLabel: (fieldKey?: string) => formulaLive.current.formulas.sourceLabelFor(fieldKey),
        exprFor: (rowId: string, fieldKey: string) => formulaLive.current.formulas.exprFor(rowId, fieldKey),
        errorFor: (rowId: string, fieldKey: string) => formulaLive.current.formulas.errorFor(rowId, fieldKey),
        colIdOfRef: (name: string, fieldKey?: string) => formulaLive.current.colIdOfRef(name, fieldKey),
        contextFor: (row: StudioRow, key: string) => editorContextLive.current(row, key),
    }), []);
    const formulaClipboard = useMemo(() => formulaTransfer<StudioRow>({
        exprFor: (row, key) => formulaWiring.exprFor(row.id, key),
    }), [formulaWiring]);
    const familyQuery = useFamily(productId);
    reloadFamilyRef.current = familyQuery.reload;
    const familySummary = familySummaryOf(familyQuery.family, familyQuery.loading);
    const { has, status: authStatus } = useAuth();
    const [newVariation, setNewVariation] = useState<NewVariationDraft | null>(null);
    const familyProductPicker = useFamilyProductPicker(productId);
    const canPim = has('pim.manage');
    const canSync = has('channels.sync');
    const canEdit = has('products.edit');
    const famActions = useMemo(() => familyActions({
        family: familyQuery.family,
        ops: familyOps,
        can: (p) => (p === 'pim.manage' ? canPim : p === 'channels.sync' ? canSync : p === 'products.edit' ? canEdit : has(p)),
        authStatus,
        pickProduct: familyProductPicker.pick,
        pending: newVariation ? { newVariation } : undefined,
        openRecord: (rowId) => record.open(rowId, lastDataCell.current ?? undefined),
        openRecordId: record.rowId,
    }), [familyQuery.family, canPim, canSync, canEdit, authStatus, newVariation, record, familyProductPicker.pick]);
    const onFamilyChangedRef = useRef<() => void>(() => { });
    /* Delete rows (Owner 2026-10-06) — the sheet's one delete, the same in every view: it replaces "Delete child…" (one
       child, permanently) on the selection bar and in the row menus. A Shared row is a product. */
    const deleteRows = useDeleteRows<StudioRow>({ productId, target: (row) => ({ productId: row.id, aliasId: null }), onChanged: () => onFamilyChangedRef.current(), hostReloads: true });
    const sheetActions = useMemo(() => [...famActions.filter((action) => action.id !== 'delete-variant'), deleteRows], [famActions, deleteRows]);
    const rowPress = useActionPress<StudioRow>(() => onFamilyChangedRef.current());
    const rowMenuRef = useRef<(row: StudioRow) => MenuItemDef[]>(() => []);
    rowMenuRef.current = useMemo(() => actionMenuItems<StudioRow>({
        actions: sheetActions,
        onSelect: (action, rows) => void rowPress.press(action, rows),
        isRecord: (r) => !!r?.id,
    }), [sheetActions, rowPress.press]);
    const getContextMenuItems = useMemo(() => actionContextMenu<StudioRow>({
        actions: sheetActions,
        onSelect: (action, rows) => void rowPress.press(action, rows),
        isRecord: (r) => !!r?.id,
    }), [sheetActions, rowPress.press]);
    const contextMenuRef = useRef(getContextMenuItems);
    contextMenuRef.current = getContextMenuItems;
    const cellMenuRef = useRef<(p: Parameters<typeof getContextMenuItems>[0]) => ReturnType<typeof getContextMenuItems>>(() => []);
    /* The cell's own verbs first (P1: Reset to inherited — the master menu had none), then the family verbs and the clipboard. */
    const stableContextMenu = useCallback<typeof getContextMenuItems>((p) => {
        const own = cellMenuRef.current(p);
        const rest = contextMenuRef.current(p);
        return own.length ? [...own, 'separator', ...rest] : rest;
    }, []);
    const onFamilyChanged = useCallback(() => { familyQuery.reload(); reload(); refreshReadinessSoon(); }, [familyQuery, reload, refreshReadinessSoon]);
    onFamilyChangedRef.current = onFamilyChanged;
    const [classificationOpen, setClassificationOpen] = useState(false);
    const [formulaHistoryOpen, setFormulaHistoryOpen] = useState(false);
    const [bulkFormulaRows, setBulkFormulaRows] = useState<Array<{
        id: string;
        label: string;
    }> | null>(null);
    const selected = selectedRows.length;
    useEffect(() => {
        if (!gridReady)
            return;
        getGridApi()?.refreshCells({ force: true });
    }, [formulas.exprFor, formulas.errorFor, gridReady]);
    const rows = useMemo(() => sheet?.rows ?? [], [sheet]);
    const { saveStatus, refused, refusedRowIds } = useSheetSaveStatus(writer, tracker, rows, sheet?.columns);
    savedAtRef.current = saveStatus.saved;
    /* ⌘Z undoes a whole operation (a fill, a paste) in one step and one save, and still works after the sheet re-reads. */
    const undo = useSheetUndo(writer, getGridApi);
    const { toast } = useToast();
    /* Add rows (R2) — empty rows in page memory; the SKU typed into one creates a draft variation (`../newRows/`). */
    const familyRoot = rows.find((row) => !row.parentId);
    const newRows = useNewRows({ kinds: SHARED_ROW_KINDS, registerScopeChangeGuard: languageScope.registerScopeChangeGuard, say: toast, getGridApi,
        target: () => variationTarget(familyRoot, canEdit), skuContext: () => ({ family: familyQuery.family, takenSkus: rows.map((row) => row.sku) }),
        onCreated: () => { refresh(); familyQuery.reload(); refreshReadinessSoon(); } });
    useEffect(() => newRows.store.landed(new Set(rows.map((row) => row.id))), [rows, newRows.store]);
    /* S11 — the first column renames the product SKU (`../identitySkuColumn.tsx`, rules in `../identitySkuEdit.ts`). */
    const identitySku = useIdentitySkuColumn<StudioRow>({ scope: SHARED_SKU_SCOPE, tracker, writer, getGridApi, rowIdOf: (row) => row.id, recordUndo: undo.record, announce: announceRefusals,
        onCreate: (row, sku) => { newRows.store.type(row.id, sku); } });
    const identityRef = useRef(identitySku.node);
    skuRenamedRef.current = (renames) => {
        const message = skuRenameMessage(renames);
        if (message)
            toast(message, 'success', { duration: 10000 });
        // What shows the SKU outside the grid: the studio header and Publish window, and the family bar's own read.
        studioSkuRenamed(renames);
        reloadFamilyRef.current();
    };
    /* Cell details (2026-10-04) — how the Shared scope describes a cell; the window, its cell-menu item (right-click,
       Shift+F10) and its ⋯ item are the shared control's. Read through refs when it opens: the columns, the rows, the AI
       drafts and the formulas all arrive after this point. */
    const detailsLive = useRef<SharedCellDetailsContext>({ rows: [], reset: () => undefined });
    const details = useMemo(() => sharedCellDetailsSource(colId => columnByKeyRef.current.get(colId), () => detailsLive.current), []);
    /* P1 — full control, the channel sheet's same hook: Reset to inherited (a variation's own value, a row's own
       translation), on a selection and on a whole column; Set every row…; Delete asks Clear or Reset; Shift+F10. */
    const control = useSheetControl<StudioRow>({
        getGridApi, writer, operation: undo.operation,
        rowIdOf: row => row.id, skuOf: row => row.sku,
        offerOf: (row, colId) => { const column = columnByKeyRef.current.get(colId); return column ? masterResetOffer(row, column, !!formulas.exprFor(row.id, colId)) : null; },
        columnFacts: colId => controlColumnFacts(columnByKeyRef.current.get(colId)),
        hidesInherited: row => !!row.parentId,
        removeFormula: (rowId, colId) => formulas.pinOver(rowId, colId),
        details,
        say: (message, tone = 'danger') => toast(message, tone),
    });
    cellMenuRef.current = control.cellMenuItems;
    refusalReason.current = (key, row) => {
        const fresh = newRowRefusal(key, row);
        if (fresh !== undefined)
            return fresh;
        if (key === PRODUCT_MEDIA_COLUMN || key === STATUS_COLUMN || key === ACTION_COLUMN)
            return null;
        const column = columnByKeyRef.current.get(key);
        return column ? editRefusalReason(column, row) : null;
    };
    const { bandWidth, bandWidthRef, bandDerivedRef, revealCell, replayReveal, remeasureSoon } = useSheetGeometry({ scope: 'master', rows, getGridApi, gridReady, recordId: record.rowId });
    const rowsRef = useRef<StudioRow[]>(rows);
    rowsRef.current = rows;
    /* ── Build shape v2, P9 — the shared scope's Status and Action columns, Action ▾ and the waiting mark ───────────
       One read of the family's waiting values on EVERY market (`usePublishActions(productId, {}, { familyId })`). One
       sheet row = one product, so a cell summarises the product's markets, and a change is written to every market of
       the product: the server refuses the markets that do not allow it, and ONE toast names them (the Owner's option
       B). An edit, a fill, a paste, a reset or Action ▾ stages its cells in one fence, like the channel sheet's (P8).
       Nothing here sends anything to a channel: Publish does. */
    const publishActions = usePublishActions(productId, SHARED_DESTINATION, { familyId: sheet?.family.id ?? null });
    const publishActionsRef = useRef(publishActions);
    publishActionsRef.current = publishActions;
    const cellsByRow = useMemo(() => cellsByProduct(publishActions.rows), [publishActions.rows]);
    const cellsByRowRef = useRef(cellsByRow);
    cellsByRowRef.current = cellsByRow;
    const publishCellsOf = useCallback((row: StudioRow): readonly PublishActionCell[] => cellsByRowRef.current.get(row.id) ?? NO_CELLS, []);
    const publishLock = authStatus !== 'loading' && !has('products.publish') ? ACTION_ROLE_CANNOT_PUBLISH : null;
    const publishRead = useMemo<PublishCellReadState>(() => ({
        loaded: publishActions.status === 'ready' || publishActions.status === 'error',
        failed: publishActions.status === 'error',
        lockedReason: publishLock,
    }), [publishActions.status, publishLock]);
    const publishReadRef = useRef(publishRead);
    publishReadRef.current = publishRead;
    const canDeleteRef = useRef(false);
    canDeleteRef.current = has('products.delete');
    const [publishTracker] = useState(() => new CellSaveTracker());
    const toastRef = useRef(toast);
    toastRef.current = toast;
    /** A shared Delete is SET only after a typed confirmation that lists every listing it would remove. */
    const deleteConfirm = useActionConfirm();
    const askDeleteRef = useRef(deleteConfirm.ask);
    askDeleteRef.current = deleteConfirm.ask;
    const repaintPublishCells = useCallback((rowIds?: Iterable<string>) => {
        const api = getGridApi();
        if (!api || api.isDestroyed())
            return;
        const nodes = rowIds ? [...new Set(rowIds)].flatMap((id) => { const node = api.getRowNode(id); return node ? [node] : []; }) : undefined;
        api.refreshCells({ ...(nodes ? { rowNodes: nodes } : {}), columns: [STATUS_COLUMN, ACTION_COLUMN], force: true });
    }, [getGridApi]);
    const publishColumnOf = (column: PublishActionChange['column']) => (column === 'send' ? ACTION_COLUMN : STATUS_COLUMN);
    /** "GALE-S · eBay · IT" — a listing of the family, named by its product's SKU on the sheet. */
    const publishLabelOf = useCallback((listingId: string): string | null => {
        const cell = publishActionsRef.current.byListingId.get(listingId);
        if (!cell) return null;
        return listingLabel(rowsRef.current.find((row) => row.id === cell.productId)?.sku ?? cell.sku, cell);
    }, []);
    /** One operation's cells, sent: a mark on each product row while it is on its way, then ONE toast for every market. */
    const flushPublishCells = useRef<(items: StagedPublishCell[]) => Promise<void>>(async () => { });
    flushPublishCells.current = async (items) => {
        const { writes, refused } = groupStaged(items);
        const byListing = publishActionsRef.current.byListingId;
        const rowOf = (listingId: string) => byListing.get(listingId)?.productId ?? null;
        const sending: PublishWriteGroup[] = [];
        for (const write of writes) {
            if (write.change.column === 'send' && write.change.mode === 'delete') {
                const targets = write.listingIds.flatMap((id) => { const cell = byListing.get(id); return cell ? [{ sku: rowsRef.current.find((row) => row.id === cell.productId)?.sku ?? cell.sku, cell }] : []; });
                const impact = sharedDeleteImpact(targets, canDeleteRef.current);
                if (impact && !(await askDeleteRef.current(impact)))
                    continue;
            }
            sending.push(write);
        }
        const touched = new Set<string>();
        for (const write of sending)
            for (const id of write.listingIds) {
                const rowId = rowOf(id);
                if (rowId) { publishTracker.set(rowId, publishColumnOf(write.change.column), 'saving'); touched.add(rowId); }
            }
        repaintPublishCells(touched);
        const outcomes: PublishActionWriteOutcome[] = await Promise.all(sending.map((write) => publishActionsRef.current.write(write.change, write.listingIds)));
        // A product row is marked refused only when NONE of its markets took the value: a market that does not allow it
        // is expected (the cell then says "on 5 of 7"), and the toast names it.
        for (const outcome of outcomes) {
            const colId = publishColumnOf(outcome.change.column);
            const perRow = new Map<string, { applied: number; reason: string | null }>();
            const note = (listingId: string, applied: boolean, reason: string | null) => {
                const rowId = rowOf(listingId);
                if (!rowId) return;
                const entry = perRow.get(rowId) ?? { applied: 0, reason: null };
                if (applied) entry.applied += 1;
                else entry.reason ??= reason;
                perRow.set(rowId, entry);
            };
            if (!outcome.ok) for (const id of outcome.requested) note(id, false, outcome.error ?? 'The change could not be saved.');
            else {
                for (const id of outcome.applied) note(id, true, null);
                for (const r of outcome.refused) note(r.listingId, false, `${publishLabelOf(r.listingId) ?? r.sku}: ${r.reason}`);
                for (const c of outcome.conflicts) note(c.listingId, false, `${publishLabelOf(c.listingId) ?? c.sku}: ${c.setByName ?? 'Someone else'} changed this first${c.setAt ? ` ${waitingWhen(c.setAt)}` : ''}. Nexus kept their value.`);
            }
            for (const [rowId, entry] of perRow) {
                if (!entry.applied && entry.reason) publishTracker.set(rowId, colId, 'refused', entry.reason);
                else publishTracker.clear(rowId, colId);
            }
        }
        for (const write of writes)
            if (!sending.includes(write))
                for (const id of write.listingIds) { const rowId = rowOf(id); if (rowId) { publishTracker.clear(rowId, publishColumnOf(write.change.column)); touched.add(rowId); } }
        repaintPublishCells(touched);
        const summary = sharedOperationToast(outcomes, refused, publishLabelOf);
        if (summary && !summary.quiet)
            toastRef.current(summary.message, summary.tone, { duration: summary.tone === 'success' ? 5000 : 10000 });
    };
    const [publishFence] = useState(() => new PublishActionFence((items) => { void flushPublishCells.current(items); }));
    useEffect(() => () => publishFence.dispose(), [publishFence]);
    /** A product cell received a value: staged once per market of the product (a refusal is marked at once). */
    const stagePublishCell = useCallback((column: PublishActionChange['column'], row: StudioRow, input: PublishCellInput) => {
        const colId = publishColumnOf(column);
        if ('refused' in input) publishTracker.set(row.id, colId, 'refused', input.refused);
        else publishTracker.clear(row.id, colId);
        repaintPublishCells([row.id]);
        const cells = publishCellsOf(row);
        if ('refused' in input || !cells.length) {
            publishFence.stage({ column, listingId: null, sku: row.sku, input });
            return;
        }
        // A market Nexus deleted takes no Status or Action from the shared scope: its own sheet lists it again (the toast
        // says so). A market not on the channel reads Full update: Partial update (the default) and Full update leave it as
        // it is; Delete is refused there by the server, with its reason. A new market that already holds the chosen
        // Status is left as it is (a paste or a fill of the same word).
        const sendLeavesIt = (cell: PublishActionCell) => column === 'send' && !!cell.create && 'change' in input && input.change.column === 'send' && input.change.mode !== 'delete';
        for (const cell of cells) publishFence.stage({ column, listingId: cell.listingId, sku: listingLabel(row.sku, cell),
            input: cell.deleted && 'change' in input ? { refused: sharedDeletedRefusal(cell) }
                : sendLeavesIt(cell) ? SKIP_CELL
                    : withoutSameNewChoice(cell, input) });
    }, [publishCellsOf, publishFence, publishTracker, repaintPublishCells]);
    /** Action ▾: fill one column of the ticked products, every market — one operation, so one write per value and one toast. */
    const fillPublishCells = useCallback((change: PublishActionChange, targets: readonly StudioRow[]) => {
        publishFence.begin();
        try {
            for (const row of targets) stagePublishCell(change.column, row, { change });
        }
        finally {
            publishFence.end();
        }
    }, [publishFence, stagePublishCell]);
    /** Delete / Backspace on a Status or Action cell: what waits on every market of those products goes back to the default. */
    const onPublishCellKey = useCallback((event: { event?: Event | null; column?: { getColId(): string } | null }): boolean => {
        const key = event.event as KeyboardEvent | null | undefined;
        const colId = event.column?.getColId();
        if ((colId !== STATUS_COLUMN && colId !== ACTION_COLUMN) || !isClearKey(key, false))
            return false;
        const api = getGridApi();
        if (!api || api.isDestroyed() || api.getEditingCells().length > 0)
            return false;
        key!.preventDefault();
        if (!publishReadRef.current.loaded || publishReadRef.current.lockedReason)
            return true;
        publishFence.begin();
        try {
            for (const target of selectedCells(api, (row: StudioRow) => row.id)) {
                for (const cell of publishCellsOf(target.row)) {
                    const sku = listingLabel(target.row.sku, cell);
                    // A deleted market's own Status choice is cleared in its own sheet (the shared scope refuses it, and says so).
                    if (target.colId === STATUS_COLUMN && cell.status.target)
                        publishFence.stage({ column: 'status', listingId: cell.listingId, sku, input: cell.deleted ? { refused: sharedDeletedRefusal(cell) } : { change: { column: 'status', target: null } } });
                    // A market not on the channel reads Full update: nothing to reset.
                    if (target.colId === ACTION_COLUMN && !cell.create && cell.send.mode !== 'partial')
                        publishFence.stage({ column: 'send', listingId: cell.listingId, sku, input: { change: { column: 'send', mode: 'partial' } } });
                }
            }
        }
        finally {
            publishFence.end();
        }
        return true;
    }, [getGridApi, publishCellsOf, publishFence]);
    /* A new read (or a permission answer) repaints only the cells whose value changed (`equals`). */
    useEffect(() => { getGridApi()?.refreshCells({ columns: [STATUS_COLUMN, ACTION_COLUMN] }); }, [publishActions.version, publishRead, getGridApi]);
    /* The inactive row-start mark — when ANY market of the product is inactive; a row whose mark changed is redrawn. */
    const rowClassRules = useMemo(() => ({ [SELLING_ROW_MARK_CLASS]: (p: { data?: StudioRow }) => !!p.data && rowCarriesInactiveMark(publishCellsOf(p.data).map((cell) => cell.state)),
        [UNSAVED_ROW_CLASS]: (p: { data?: StudioRow }) => isUnsavedRowData(p.data) }), [publishCellsOf]);
    const inactiveRowIds = useRef(new Set<string>());
    useEffect(() => {
        const next = new Set(rows.filter((row) => publishCellsOf(row).some(isInactiveCell)).map((row) => row.id));
        const changed = [...next].filter((id) => !inactiveRowIds.current.has(id)).concat([...inactiveRowIds.current].filter((id) => !next.has(id)));
        inactiveRowIds.current = next;
        const api = getGridApi();
        if (!api || api.isDestroyed() || !changed.length)
            return;
        const nodes = changed.flatMap((id) => { const node = api.getRowNode(id); return node ? [node] : []; });
        if (nodes.length) api.redrawRows({ rowNodes: nodes });
    }, [rows, publishActions.version, publishCellsOf, getGridApi, gridReady]);
    /* The toolbar's "4 waiting for Publish" (every market of the family) — pressing it shows only those products. */
    const [waitingOnly, setWaitingOnly] = useState(false);
    const waitingRowCount = useMemo(() => rows.filter((row) => publishCellsOf(row).some(isWaitingCell)).length, [rows, publishActions.version, publishCellsOf]);
    useEffect(() => { if (waitingOnly && !waitingRowCount) setWaitingOnly(false); }, [waitingOnly, waitingRowCount]);
    const waitingMarkStatus = useMemo(() => waitingStatusMark(publishActions.waiting, waitingOnly, () => setWaitingOnly((on) => !on)), [publishActions.waiting, waitingOnly]);
    /** The shared Status and Action columns; their values are read through refs, so a new read never rebuilds them. */
    const hasSheet = !!sheet;
    const statusActionColumns = useMemo<ColDef<StudioRow>[]>(() => {
        if (!hasSheet) return [];
        const input = { cells: publishCellsOf, read: () => publishReadRef.current, canDelete: () => canDeleteRef.current, tracker: publishTracker, rowIdOf: (row: StudioRow) => row.id };
        return [
            sharedStatusColumn<StudioRow>({ ...input, onInput: (row, value) => stagePublishCell('status', row, value) }),
            sharedActionColumn<StudioRow>({ ...input, onInput: (row, value) => stagePublishCell('send', row, value) }),
        ];
    }, [hasSheet, publishCellsOf, publishTracker, stagePublishCell]);
    /** The record drawer's selling state: the open product's listings on every market. */
    const drawerSelling = useMemo<RecordSelling>(() => ({
        status: publishActions.status, error: publishActions.error,
        cellsOf: (rowId) => cellsByRow.get(rowId) ?? NO_CELLS,
    }), [publishActions.status, publishActions.error, cellsByRow]);
    const reloadConfirm = useActionConfirm();
    const onReload = useCallback(async () => {
        const impact = reloadImpact({ pending: writer.pending, refused, unknown: writer.unknownCount });
        if (!impact) {
            newRows.store.clear();
            reload();
            refreshReadiness();
            return;
        }
        if (!(await reloadConfirm.ask(impact)))
            return;
        reporter.cleared(sheet?.rows.map(row => row.id) ?? [...refusedRowIds]);
        writer.discard();
        newRows.store.clear();
        reload();
        refreshReadiness();
    }, [writer, refused, refusedRowIds, sheet, reporter, reload, reloadConfirm, refreshReadiness, newRows.store]);
    /** "Refresh progress": the rows' own bars (a quiet re-read — edits in flight stay) and the channel · market bars. */
    const refreshProgress = useCallback(() => { refresh(); refreshReadiness(); }, [refresh, refreshReadiness]);
    const progressMenu = useCallback(() => {
        const q = readinessRef.current;
        return [refreshProgressItem(refreshProgress, q.status === 'ready' ? q.at : null, q.status === 'ready' ? q.refreshError : q.status === 'error' ? q.message : null)];
    }, [refreshProgress]);
    const mediaEditor = useProductMediaEditor(refresh, locale);
    const mediaClipboard = useMemo(() => mediaGridTransfer(formulaClipboard, mediaEditor.actions), [formulaClipboard, mediaEditor.actions]);
    /* Progress columns (2026-09-26) — members of the column model (Customise, views, locks), built by `progressColumns`
       below. The per-market ones follow the readiness index for the pressed language. */
    const coordinateColumns = useMemo(() => coordinateReadinessColumns(readinessMatrix, locale), [readinessMatrix, locale]);
    const progressSpecs = useMemo<SheetColumn[]>(() => (sheet ? [
        progressSheetColumn<SheetColumn>(SCOPE_PROGRESS_COLUMN, 'Shared product', SHARED_PROGRESS_TIP),
        ...coordinateColumns.map((c) => progressSheetColumn<SheetColumn>(progressKeyOf(c.colId), c.label, marketProgressTip(c.label, languageLabel(c.language), c.computedAt))),
    ] : []), [sheet, coordinateColumns]);
    /* Build shape v2, P9 — Status and Action, right after the progress columns: members of the column model (Customise,
       views), never write fields (`managedBy: 'progress'` keeps them out of the attribute builder). */
    const publishSpecs = useMemo<SheetColumn[]>(() => (sheet ? [sharedStatusSheetColumn<SheetColumn>(), sharedActionSheetColumn<SheetColumn>()] : []), [sheet]);
    const schemaColumns = useMemo(() => withSheetGroups([...progressSpecs, ...publishSpecs, ...withProductMediaColumn(sheet?.columns ?? []).filter((c) => !RESERVED_COLUMN_IDS.includes(c.key as never))]), [sheet, progressSpecs, publishSpecs]);
    const viewCtx = useMemo(() => ({
        variationAxes: sheet?.family.variationAxes?.length ? sheet.family.variationAxes : variationAxes,
        locale,
        scopeLabel: SHARED_SCOPE_LABEL,
        flaggedKeys: flaggedColumnKeys(sheet?.rows),
    }), [sheet, locale, variationAxes]);
    columnByKeyRef.current = useMemo(() => new Map(schemaColumns.map((c) => [c.key, c])), [schemaColumns]);
    const allColumnKeys = useMemo(() => schemaColumns.map((c) => c.key), [schemaColumns]);
    const customisableColumns = schemaColumns;
    const prefsBridge = useMemo<PrefsBridgeOptions>(() => ({
        columns: [
            { key: 'product', locked: true },
            ...allColumnKeys.map((k) => ({ key: k })),
        ],
        treeColumnKey: 'product',
    }), [allColumnKeys]);
    const chipBar = useViewChips();
    const sheetColumns = useSheetColumns<StudioRow, SheetPageState>({
        apiRef,
        gridReady,
        columns: schemaColumns,
        viewCtx,
        serverViews: sheet?.views,
        identityColumn: IDENTITY_COLUMN,
        prefsBridge,
        activeChip: chipBar.active,
        /* TOOLBAR REBUILD (2026-09-27) — one layout and one remembered view for the shared product, on every market. */
        layoutSurface: 'product-edit:layout:master',
        legacyLayoutSurface: `product-edit:layout:master:${market.toUpperCase()}`,
        productType: sheet ? sheet.family.productType ?? null : undefined,
        grid: {
            surface: 'product-edit:master',
            viewsSurface: 'product-edit:views:master',
            baseUrl: getBackendUrl(),
            omitScroll: record.colKey != null,
            getPageState: () => ({ search }),
            applyPageState: (pg) => setSearch(pg.search ?? ''),
        },
    });
    const { onGridReady, onGridPreDestroyed } = useSheetGridBindings({ apiRef, sheetColumns, bindGridApi, releaseGrid, bindWriter: bindGrid, clearRows: () => setSelectedRows([]) });
    const scopeRows = useMemo(() => {
        const afterRefused = showRefusedOnly && refusedRowIds.size ? filterProductSheetRows(rows, row => refusedRowIds.has(productSheetRowKey(row))) : rows;
        const afterWaiting = waitingOnly ? filterProductSheetRows(afterRefused, row => publishCellsOf(row).some(isWaitingCell)) : afterRefused;
        const query = search.trim().toLowerCase();
        return query ? filterProductSheetRows(afterWaiting, row => (row.sku + ' ' + (row.name ?? '')).toLowerCase().includes(query) || Object.entries(row.values).some(([key, cell]) => referenceSearchText(cell?.value, columnByKeyRef.current.get(key)?.optionLabels).includes(query))) : afterWaiting;
    }, [rows, search, showRefusedOnly, refusedRowIds, schemaColumns, waitingOnly, publishCellsOf, publishActions.version]);
    useSheetChips(sheet ? scopeRows : null, schemaColumns, { scope: 'master' });
    const productIds = useMemo(() => rows.map((r) => r.id), [rows]);
    const contentAiChip = useLanguageChips(sheet ? scopeRows : null, schemaColumns, false);
    const aiLayer = useAiDraftLayer({ productIds, channel: null, marketplace: market, locale, locales: languageScope.locales, columnKeys: allColumnKeys }, contentAiChip);
    const skuById = useMemo(() => Object.fromEntries(rows.map((r) => [r.id, r.sku])), [rows]);
    detailsLive.current = {
        rows, saveOf: (rowId, colId) => tracker.get(rowId, colId), draftFor: aiLayer.draftFor,
        exprFor: formulas.exprFor, errorFor: formulas.errorFor,
        // The cell menu's own reset writer — the window's one action is that menu item (Owner decision 1).
        reset: targets => { void control.reset(targets); },
    };
    const activeChip = chipBar.active;
    const chipCellsRef = useRef(activeChip?.cells ?? null);
    chipCellsRef.current = activeChip?.cells ?? null;
    const isChipCell = useCallback((rowId: string, colId: string) => (chipCellsRef.current ? viewChipHasCell(chipCellsRef.current, rowId, colId) : false), []);
    useEffect(() => {
        const api = getGridApi();
        if (api && !api.isDestroyed())
            api.refreshCells({ force: true });
    }, [activeChip]);
    const visibleRows = useMemo(() => activeChip ? filterProductSheetRows(scopeRows, row => (activeChip.cells.byRow[productSheetRowKey(row)]?.length ?? 0) > 0) : scopeRows, [scopeRows, activeChip]);
    /* Add rows — the empty rows after the rows on screen (no search or filter hides them; the row count leaves them out). */
    const gridRows = useMemo(() => withNewRows<StudioRow>(visibleRows, newRows.rows, (row) => sharedNewRow(row, familyRoot?.id ?? productId)), [visibleRows, newRows.rows, familyRoot?.id, productId]);
    const attributeColumns = useMemo(() => (sheet ? control.decorate(buildSheetColumns('master', { columns: withoutProgressColumns(schemaColumns).filter(column => column.key !== PRODUCT_MEDIA_COLUMN), tracker, locale, market, reservedColumnIds: RESERVED_COLUMN_IDS, isChipCell, draftFor: aiLayer.draftFor, formula: formulaWiring }, rowsRef)) : []), [sheet, schemaColumns, tracker, locale, market, isChipCell, aiLayer.draftFor, formulaWiring, control.decorate]);
    const identityColumns = useMemo<ColDef<StudioRow>[]>(() => [], []);
    /* Progress columns (2026-09-26) — what the card's actions call. Read through refs: the column set is built before
       the grid exists, and a card is opened long after either is current. */
    const presenceRef = useRef<(field: string) => ColumnPresence>(() => 'absent');
    const goToFieldRef = useRef<(productId: string, field: string) => void>(() => undefined);
    presenceRef.current = (field) => {
        const col = getGridApi()?.getColumn(field);
        return !col ? 'absent' : col.isVisible() ? 'visible' : 'hidden';
    };
    goToFieldRef.current = (productId, field) => {
        const api = getGridApi();
        if (!api) return;
        // The engine's landing: open the family, scroll the row to the middle, put the cursor in the cell, mark it.
        // The sheet's own reveal keeps the column clear of an open record panel.
        landOnCell(api, { rowId: productId, colId: field, reveal: (colId) => revealCell(colId, 'reveal'), root: document.querySelector('.nds-grid-sheet') ?? undefined });
    };
    /**
     * The PROGRESS COLUMNS (2026-09-26) — they replace the "Readiness · <label>" columns and the grey bar in the Product
     * cell. One for the shared product (this sheet's own rows, measured live), then one per channel · market the
     * readiness index has rows for in the pressed language (the same read the scope chips use — one request, one
     * authority). Built by the ONE builder both scopes use (`../progressColumns`).
     */
    const progressColumns = useMemo<ColDef<StudioRow>[]>(() => {
        if (!sheet) return [];
        const subjectOf = (p: ICellRendererParams) => (p.data as StudioRow | undefined)?.sku ?? null;
        const own = progressColumn<StudioRow>({
            colId: SCOPE_PROGRESS_COLUMN,
            headerName: 'Shared product',
            headerTooltip: SHARED_PROGRESS_TIP,
            value: (row) => rowProgressValue(row),
            menu: progressMenu,
            cell: {
                scopeLabel: 'Shared product',
                subjectOf,
                actionFor: (field, label) => sheetFieldAction(presenceRef.current(field), label, 'Not a column on this sheet'),
                onGoTo: (field, p) => { const row = p.data as StudioRow | undefined; if (row) goToFieldRef.current(row.id, field); },
                footerLink: () => ({ label: 'All products for the shared product', href: listingsHref({ channel: null, language: locale }) }),
            },
        });
        const perMarket = coordinateColumns.map((c) => progressColumn<StudioRow>({
            colId: progressKeyOf(c.colId),
            headerName: c.label,
            headerTooltip: marketProgressTip(c.label, languageLabel(c.language), c.computedAt),
            value: (row) => coordinateProgressValue(c.byProduct[row.id], c.missingByProduct[row.id] ?? [], c.optionalByProduct[row.id] ?? []),
            menu: progressMenu,
            cell: {
                scopeLabel: c.label,
                subjectOf,
                // A channel field is edited in its own scope: the link opens that scope at this row and field.
                actionFor: (field, _label, p) => {
                    const row = p.data as StudioRow | undefined;
                    if (!row || !c.channel) return { kind: 'none', text: 'Edit it on the shared product.' };
                    return { kind: 'link', label: `Open in ${c.label}`, href: studioFieldHref(window.location, {
                        scope: c.channel, market: c.market, locale: c.language, accountId: c.accountId, aliasId: c.aliasId,
                        rowId: `${c.aliasId ?? 'primary'}:${row.id}`, field }) };
                },
                onGoTo: () => undefined,
                footerLink: () => ({ label: `All products for ${c.label}`, href: listingsHref({ channel: c.channel, market: c.market, language: c.language }) }),
            },
        }));
        return [own, ...perMarket];
    }, [sheet, coordinateColumns, locale, progressMenu]);
    const columnDefs = useMemo(() => {
        const rank = new Map(orderColumnKeys(schemaColumns, viewCtx).map((k, i) => [k, i]));
        const ordered = attributeColumns
            .map((c, i) => ({ c, r: rankOfColumn(c, rank), i }))
            .sort((a, b) => a.r - b.r || a.i - b.i)
            .map((x) => x.c);
        // Add rows — on an empty row every cell but the SKU is locked and blank (`lockedOnNewRows`).
        return lockedOnNewRows([...identityColumns, ...progressColumns, ...statusActionColumns, productMediaColumn<StudioRow>(mediaEditor.open, mediaEditor.actions), ...ordered]);
    }, [identityColumns, attributeColumns, progressColumns, statusActionColumns, schemaColumns, viewCtx, mediaEditor.open, mediaEditor.actions]);
    const getRowId = useCallback((p: {
        data: StudioRow;
    }) => p.data.id, []);
    const getDataPath = useCallback((d: StudioRow) => (d.parentId ? [d.parentId, d.id] : [d.id]), []);
    const secondaryRef = useRef<SecondaryPlan>({ mode: 'none', axisKeys: [] });
    secondaryRef.current = useMemo(() => secondaryPlan(rows, schemaColumns), [rows, schemaColumns]);
    useUnpinOnNarrowSheet(getGridApi, gridReady);
    const autoGroupColumnDef = useMemo<ColDef<StudioRow>>(() => ({
        headerName: 'Product', colId: 'product', width: bandWidth, minWidth: BAND_WIDTH_FLOOR,
        pinned: 'left',
        lockPinned: true,
        lockPosition: 'left',
        cellRenderer: ProductCell, cellClass: (p: { data?: StudioRow }) => (unsavedOf(p.data) ? 'nds-ag-cell nds-cell-full-strength' : 'nds-ag-cell'), suppressHeaderMenuButton: true,
        cellRendererParams: { secondaryRef, rowMenuRef, identityRef, newRows: newRows.store },
        headerTooltip: 'Family — a parent and its children',
        // S11 — editable: the product SKU (its editor, keys, save marks and refusals; Enter still opens the record).
        ...identitySku.columnDef,
    }), [bandWidth, identitySku.columnDef, newRows.store]);
    // Wave 2 E14 — paste with a header row: the same module as the channel scopes (`../headerPaste`).
    const headerPaste = useHeaderPaste<StudioRow>(customisableColumns.map((c) => ({ colId: c.key, headerName: c.label, formerNames: c.formerNames })), (message, tone) => toast(message, tone));
    // Add rows — a paste on an empty row's SKU fills the empty rows; any other paste is the header-aware one.
    const pasteIntoNewRows = useMemo(() => newRowsPaste(newRows.store, headerPaste.processDataFromClipboard), [newRows.store, headerPaste.processDataFromClipboard]);
    // Add rows — an empty row's cell menu holds only "Remove this row".
    const menuWithNewRows = useMemo(() => newRowsContextMenu(newRows.store, stableContextMenu), [newRows.store, stableContextMenu]);
    const defaultColDef = useMemo<ColDef<StudioRow>>(() => ({ sortable: true, resizable: true, ...headerPaste.defaultColDef }), [headerPaste.defaultColDef]);
    const onCellValueChanged = useCallback((e: {
        data: StudioRow;
        colDef: {
            colId?: string;
        };
        oldValue?: unknown;
        newValue: unknown;
        source?: string;
    }) => {
        const colId = e.colDef.colId;
        if (identitySku.onValueChanged(e))
            return;
        if (!writeGate({ colId, source: e.source, selfInflicted: false, oldValue: e.oldValue, newValue: e.newValue }).write)
            return;
        /* P0 — a cell whose formula state is not known yet keeps the edit and applies it once it is (the formula path if
           the cell turns out to hold one). Never refused: the refusal lost every paste made while formulas loaded. */
        if (!formulas.knownFor(e.data.id, colId!)) {
            const rowId = e.data.id;
            tracker.set(rowId, colId!, 'saving', HELD_FOR_FORMULAS);
            formulas.whenKnown(rowId, colId!, () => {
                if (tracker.get(rowId, colId!)?.reason === HELD_FOR_FORMULAS)
                    latestValueChanged.current(e);
            }, (reason) => tracker.set(rowId, colId!, 'refused', reason ?? HELD_EDIT_DROPPED));
            return;
        }
        const typed = typeof e.newValue === 'string' ? e.newValue : null;
        if ((typed !== null && isFormulaDraft(typed)) || formulas.exprFor(e.data.id, colId!)) {
            const prev = cellOf(e.data, colId!);
            if (prev) {
                e.data.values = { ...e.data.values, [colId!]: { ...prev, value: e.oldValue } };
                const node = getGridApi()?.getRowNode(e.data.id);
                if (node)
                    getGridApi()?.refreshCells({ force: true, rowNodes: [node], columns: [colId!] });
            }
            const writeId = `${e.data.id}:${colId}:${Date.now()}`;
            onWriteStart(writeId, e.data.id);
            tracker.set(e.data.id, colId!, 'saving');
            void (typed !== null && isFormulaDraft(typed) ? formulas.save(e.data.id, colId!, exprOf(typed)) : formulas.replace(e.data.id, colId!, e.newValue))
                .then((r) => {
                onWriteEnd(writeId, r.ok, r.error, e.data.id);
                tracker.set(e.data.id, colId!, r.ok ? 'saved' : 'refused', r.error);
                if (!r.ok) {
                    const cell = cellOf(e.data, colId!);
                    if (cell) {
                        e.data.values = { ...e.data.values, [colId!]: { ...cell, value: e.newValue } };
                        const n = getGridApi()?.getRowNode(e.data.id);
                        if (n)
                            getGridApi()?.refreshCells({ force: true, rowNodes: [n], columns: [colId!] });
                    }
                }
            })
                .catch((err: unknown) => {
                const reason = err instanceof Error ? err.message : String(err);
                onWriteEnd(writeId, false, reason, e.data.id);
                tracker.set(e.data.id, colId!, 'unknown', `Could not reach the server — ${reason}. Refresh to see whether this saved.`);
            });
            return;
        }
        undo.record({ rowId: e.data.id, colId: colId!, before: e.oldValue, after: e.newValue }, e.source);
        writer.set(e.data.id, colId!, e.newValue, { row: e.data });
    }, [writer, formulas, onWriteStart, onWriteEnd, reload, undo.record, identitySku.onValueChanged]);
    /* A held edit re-enters through the LATEST handler, which sees the formula state that released it. */
    const latestValueChanged = useRef(onCellValueChanged);
    latestValueChanged.current = onCellValueChanged;
    /* Action ▾ counts what each item would do to the ticked products, on every market. */
    const actionEntries = useMemo(() => sharedActionMenuEntries(selectedRows.map((row) => ({ sku: row.sku, cells: publishCellsOf(row) })),
        { publish: !publishLock && authStatus !== 'loading', delete: has('products.delete') }), [selectedRows, publishCellsOf, publishActions.version, publishLock, authStatus, has]);
    /* The grid's operation events open and close the Status and Action fence too (after the sheet's own fence). */
    const publishFenceProps = useMemo(() => {
        const g = undo.gridProps;
        const begin = () => publishFence.begin();
        const end = () => publishFence.end();
        return {
            ...g,
            onFillStart: () => { g.onFillStart(); begin(); }, onFillEnd: () => { g.onFillEnd(); end(); },
            onPasteStart: () => { g.onPasteStart(); begin(); }, onPasteEnd: () => { g.onPasteEnd(); end(); },
            onCellSelectionDeleteStart: () => { g.onCellSelectionDeleteStart(); begin(); }, onCellSelectionDeleteEnd: () => { g.onCellSelectionDeleteEnd(); end(); },
        };
    }, [undo.gridProps, publishFence]);
    const [importOpen, setImportOpen] = useState(false);
    const [transferIntent, setTransferIntent] = useState<'import' | 'export'>('import');
    const familyVerbs = useFamilyVerbs({
        family: familyQuery.family,
        actions: famActions,
        error: familyQuery.error,
        onRetry: familyQuery.reload,
        onDone: onFamilyChanged,
        onCollectVariation: setNewVariation,
    });
    const { preferences, columnDialog, openCustomise, openNewView } = useSheetPreferences({ scope: 'master', sheetColumns, getGridApi, bandWidthRef, bandDerivedRef, revealCell });
    const [exportNote, setExportNote] = useState<string | null>(null);
    const onExport = useCallback((mode: SheetExportMode) => {
        const api = getGridApi();
        if (!api || api.isDestroyed() || !sheet)
            return;
        try {
            const r = exportGridCsv<StudioRow>(api, `${sheet.family.sku}-${market}-table`, {
                columns: mode === 'all' ? sheetColumns.orderedKeys : 'displayed',
                leading: [{ colId: '__sku', header: 'SKU', value: row => row.sku }],
                narrowed: search.trim().length > 0,
            });
            setExportNote(`${r.rows} rows · ${r.columns} columns → ${r.fileName} · reference table`);
        }
        catch (e) {
            setExportNote(e instanceof GridExportRefused ? e.message : 'Could not build the file.');
        }
    }, [sheet, market, search, sheetColumns]);
    const resolveRow = useCallback((rowId: string) => {
        const row = rowsRef.current.find((r) => r.id === rowId);
        return row ? ({ ...row, listings: {} } as unknown as DrawerSheetRow) : null;
    }, []);
    const drawerScope = useMemo(() => ({ kind: 'master' as const, marketplace: market, locale, label: sheet?.scope.label ?? `Shared product · ${market}` }), [market, locale, sheet]);
    const setupMissing = sheet?.meta.schemaMissing ?? NO_KEYS;
    const familyUnset = setupMissing.includes(FAMILY_UNSET);
    const categoryLink = chooseCategoryLink('EBAY', market, setupMissing);
    const setupNotice = setupMissing.length > 0 && <Banner tone="warning"
        title={familyUnset ? 'No product family is chosen' : setupSentence(market, setupMissing[0])}
        action={familyUnset && canEdit ? <Button size="sm" variant="secondary" disabled={loading} onClick={() => setClassificationOpen(true)}>Choose a product family</Button>
            : !familyUnset && categoryLink ? <Button asChild size="sm" variant="link"><Link href={categoryLink.href}>{categoryLink.label}</Link></Button> : undefined}>
        {[...(familyUnset ? ['The shared fields come from it.'] : []), ...setupMissing.filter(key => key !== FAMILY_UNSET).slice(familyUnset ? 0 : 1).map(key => setupSentence(market, key))].join(' ') || undefined}
      </Banner>;
    editorContextLive.current = (row, key) => ({
        aiDraft: aiDraftContextOf(aiLayer.drafts.drafts.find(d => d.productId === row.id && d.columnKey === key && d.status === 'pending'),
            { approve: ids => aiLayer.drafts.approve(ids), reject: ids => aiLayer.drafts.reject(ids), onApplied: reload }),
        history: historyLoaderFor(row, key, drawerScope),
        // A content cell can name its OWN row as the source (it falls back to the shared record): say "the parent".
        inherited: inheritedContextOf(row.values[key], from => from === row.id ? null : skuById[from]),
    });
    const onDrawerWrite = useCallback(async (req: RecordWriteRequest): Promise<RecordWriteResult> => {
        const row = rowsRef.current.find((r) => r.id === req.rowId);
        if (!row)
            return { state: 'refused', message: 'That row is no longer on the sheet — reload it.' };
        const column = (sheet?.columns ?? []).find((c) => c.writeField === req.writeField || c.key === req.writeField);
        if (!column)
            return { state: 'refused', message: `No column on this sheet writes “${req.writeField}”.` };
        writer.set(req.rowId, column.key, req.value, { row, intent: req.intent });
        return { state: 'pending' };
    }, [sheet, writer]);
    /**
     * LX.13 — every language of the field (source first) + every coordinate carrying it, from the ONE
     * builder both hosts use (`sheet/compareTargets.ts`). Master used to offer a single target —
     * itself — so the pane could only answer "no other scopes are wired to compare against".
     *
     * Languages come from the scope authority (`Marketplace.languages`, LX.2) through
     * `languageScope.options.locales`; the source is its `primaryLanguage`. Coordinates are the ones
     * this family is LISTED on, which the master sheet read does not carry — that inventory arrives
     * with the per-coordinate readiness columns (LX.15, deferred to VT.2's file), so master offers
     * the language rows today and the coordinate rows land with it.
     */
    const compareTargets = useMemo(() => sheet ? buildCompareTargets({
        scope: drawerScope,
        languages: languageScope.options.locales.map(language => language.code),
        primaryLanguage: languageScope.primaryLanguage,
        coordinates: [],
        labels: { channel: channelLabel, language: languageLabel },
        masterLabel: sheet.scope.label ?? 'Shared',
        masterMarket: market,
    }) : [], [sheet, drawerScope, languageScope.options.locales, languageScope.primaryLanguage, market]);
    const staleTypes = sheet?.meta.schemaAge.filter((a) => Date.now() - new Date(a.fetchedAt).getTime() > 7 * 864e5) ?? [];
    const emptyState = sheetEmptyState(rows.length, () => {
        setSearch('');
        chipBar.setActive(null);
        setShowRefusedOnly(false);
        getGridApi()?.setFilterModel(null);
    }, onReload);
    return {
        scope: 'master',
        loading, switching, unavailable: !!error,
        errorLabel: 'shared product information',
        errorMessage: error,
        backendMissing: false, retry: reload,
        columns: sheetColumns,
        saveStatus,
        toolbar: {
            visible: visibleRows.length,
            total: rows.length,
            selected: selected,
            /* SHEET-VIEWS (2026-09-26): the selection verbs live in the toolbar while rows are selected. */
            selectionActions: <FamilySelectionVerbs rows={selectedRows} actions={sheetActions} onDone={onFamilyChanged}>
                {/* Build shape v2, P9 — Action ▾ after "Delete…": fills Status or Action on every market of the ticked products. */}
                <PublishActionMenu entries={actionEntries} selected={selected} onChoose={(change) => fillPublishCells(change, selectedRows)} disabled={publishActions.status !== 'ready'}/>
            </FamilySelectionVerbs>,
            onClearSelection: clearSelection,
            descriptor: familySummary.role !== '—' ? (<span className="nds-cell-muted"> · {familySummary.role} · {familySummary.detail}</span>) : null,
            search: search,
            onSearch: setSearch,
            onCustomise: openCustomise,
            onNewView: openNewView,
            onExport: () => { setTransferIntent('export'); setImportOpen(true); },
            exportCounts: { view: sheetColumns.visibleAttributeKeys().length, all: sheetColumns.orderedKeys.length },
            exportDisabled: !sheet || loading || !has('products.export'),
            exportPurpose: "workbook",
            onImport: () => { setTransferIntent('import'); setImportOpen(true); },
            importDisabled: !sheet || loading || !has('products.import'),
            onReload: onReload,
            loading: loading,
            unavailable: !!error,
            overflow: [...(waitingRowCount ? [{ id: 'show-waiting', label: waitingOnly ? 'Show all rows' : `Show the ${waitingRowCount === 1 ? 'product' : `${waitingRowCount} products`} waiting for Publish`, description: 'Products with a Status or Action that Publish will send, on any market', onSelect: () => setWaitingOnly((on) => !on) }] : []), { id: 'classification', label: 'Classification…', disabled: loading || !!error || !canEdit, description: !canEdit ? 'You do not have permission to change product classification.' : 'Choose the product family and categories.', onSelect: () => setClassificationOpen(true) }, ...familyVerbs.items, control.cellDetails.overflowItem, { id: 'formula-history', label: 'Formula history…', onSelect: () => setFormulaHistoryOpen(true) }, { id: 'refresh-progress', label: progressMenu()[0].name, description: 'Read the progress bars again — the shared product and every channel · market', onSelect: refreshProgress }, { id: 'bulk-formula', label: 'Apply formula to selected products…', disabled: !selected || !formulas.ready || !canEdit, onSelect: () => setBulkFormulaRows(selectedRows.map(row => ({ id: row.id, label: row.sku ?? row.id })).sort((a, b) => Number(a.id === productId) - Number(b.id === productId))) }],
            status: [
                ...(switching ? [{ tone: 'info' as const, label: 'Loading languages…', detail: 'The sheet keeps the languages it shows until the new ones arrive; editing resumes then.' }] : []),
                /* Step 4 (D3, 2026-10-01) — a missing setup is the notice above the grid, in plain words and with the button
                   that fixes it; the chip keeps only the cached-requirements note. */
                ...(staleTypes.length > 0 && !(sheet?.meta.schemaMissing.length) ? [{
                    tone: 'warning' as const,
                    label: 'Cached requirements',
                    detail: `Length caps and lists come from a schema last fetched ${staleTypes.map((t) => `${t.productType} ${t.fetchedAt.slice(0, 10)}`).join(', ')}.`,
                }] : []),
                ...familyVerbs.status,
                ...(waitingMarkStatus ? [waitingMarkStatus] : []),
                ...(readinessQuery.status === 'error' ? [{ tone: 'warning' as const, label: 'Progress unavailable', detail: `The channel · market progress bars could not be read: ${readinessQuery.message} Choose ⋯ → Refresh progress to try again.` }]
                    : readinessQuery.status === 'ready' && readinessQuery.refreshError ? [{ tone: 'warning' as const, label: 'Progress not refreshed', detail: `The bars show the last good reading. The refresh failed: ${readinessQuery.refreshError} Choose ⋯ → Refresh progress to try again.` }] : []),
            ],
        },
        toolbarExtra: <></>,
        footerStart: <NewRowsControl {...newRows.control}/>,
        status: {
            rows: visibleRows.length,
            /* The selection is counted ONCE, on the toolbar ("Selected N rows"), not again here. */
        }, footerNote: {
            layoutRecovery: sheetColumns.loadError ? { retry: sheetColumns.reloadSavedPreferences } : null,
            showRefusedOnly: showRefusedOnly,
            onToggleRefused: () => setShowRefusedOnly((v) => !v),
            onRetry: () => { writer.retryFailed(); },
        }, footerBefore: <>
        {rowPress.problem && <div className="nds-grid-footstrip" role="alert"><span className="nds-cell-stock-out">{rowPress.problem}</span></div>}
        {rowPress.confirmElement}
        {familyVerbs.dialogs}
        {reloadConfirm.element}
        {deleteConfirm.element}</>, footerExtra: <>{exportNote && <span className="nds-cell-muted">{exportNote}</span>}
    {sheet?.meta.source === 'legacy' && (<InfoTip tip="The studio sheet route is not deployed yet, so this is the catalogue read adapted to the same shape. Cell values and versions are real; the layer each value came from is INFERRED here rather than stated by the server.">
                <Pill tone="neutral" size="sm">adapted read</Pill>
              </InfoTip>)}
    {conflicts.length > 0 && (<Button size="sm" variant="link" onClick={reload}>
                {conflicts.length} {conflicts.length === 1 ? 'row' : 'rows'} changed elsewhere — refresh
              </Button>)}</>,
        notice: <>{contractProblems.length > 0 && <Banner tone="warning" title="The sheet read did not match its contract">{contractProblems.join(" · ")}</Banner>}
          {setupNotice}</>,
        grid: {
            noRowsOverlayComponentParams: emptyState,
            ...mediaClipboard,
            getContextMenuItems: menuWithNewRows,
            flatTree: true,
            groupDefaultExpanded: -1,
            tooltipShowDelay: 300,
            rowData: loading ? [] : gridRows,
            onFirstDataRendered: remeasureSoon,
            onRowDataUpdated: remeasureSoon,
            onDisplayedColumnsChanged: replayReveal,
            onColumnResized: replayReveal,
            columnDefs: columnDefs,
            defaultColDef: defaultColDef,
            autoGroupColumnDef: autoGroupColumnDef,
            getRowId: getRowId,
            getDataPath: getDataPath,
            rowSelection: rowSelection,
            onSelectionChanged: onSelectionChanged,
            onGridReady: onGridReady,
            onGridPreDestroyed: onGridPreDestroyed,
            onCellValueChanged: onCellValueChanged,
            // One operation (fill, paste, range delete) = one undo step and one save; ⌘Z is the sheet's own (`useSheetUndo`).
            // The same events open and close the Status and Action fence (P9).
            ...publishFenceProps,
            rowClassRules: rowClassRules,
            processDataFromClipboard: pasteIntoNewRows,
            loading: loading,
            columnDialog: columnDialog,
            initialState: sheetColumns.initialState,
            onCellDoubleClicked: onCellDoubleClicked,
            onCellKeyDown: (event: Parameters<typeof onCellKeyDown>[0]) => { if (newRowsGridKey(newRows.store, event as never)) return; if (onPublishCellKey(event as never)) return; if (control.onKeyDown(event as never)) return; if (!undo.onKeyDown(event.event)) onCellKeyDown(event); },
            onCellFocused: onCellFocused,
        },
        gridOverlay: null,
        drawer: {
            resolveRow: resolveRow,
            columns: sheet?.columns ?? [],
            scope: drawerScope,
            compareTargets: compareTargets,
            loading: loading,
            error: error,
            onWrite: onDrawerWrite,
            onRevealCell: revealCell,
            formulas: formulas,
            selling: drawerSelling,
        },
        preferences: preferences,
        before: <>{mediaEditor.element}
    {formulaHistoryOpen && <FormulaHistoryDialog familyProductId={productId} coordinate={{ scope: 'master', market, locale }} onClose={() => setFormulaHistoryOpen(false)} onApplied={() => { formulas.reload(); refresh(); }}/>}
    {bulkFormulaRows && <FormulaBulkDialog rows={bulkFormulaRows} columns={sheet?.columns ?? []} coordinate={{ scope: 'master', market, locale }} functions={formulas.functions} preview={formulas.preview} candidatesFor={(id, fieldKey) => { const row = rowsRef.current.find(row => row.id === id); return row ? candidatesFor(row, fieldKey) : []; }} onClose={() => setBulkFormulaRows(null)} onApplied={() => { formulas.reload(); refresh(); }}/>}</>, afterGrid: <>{chipBar.activeId === 'ai-drafts' && <AiDraftReview drafts={aiLayer.drafts} skuById={skuById} onApplied={reload}/>}</>, beforePreferences: <>
        <ClassificationDialog productId={productId} open={classificationOpen} onClose={() => setClassificationOpen(false)} onChanged={onFamilyChanged}/>
    {sheet && (<SheetTransfer open={importOpen} intent={transferIntent} onClose={() => setImportOpen(false)} productId={productId} market={market} locale={locale} selectedIds={selectedRows.map(row => row.id)} visibleFields={sheetColumns.visibleAttributeKeys().flatMap(key => { const c = sheet.columns.find(c => c.key === key); return c ? [c.slot?.of ?? c.key] : []; })} onReference={() => onExport('view')} onApplied={() => { formulas.reload(); reload(); familyQuery.reload(); }}/>)}
        {familyProductPicker.element}
        {/* The control's dialogs (Cell details, Clear or reset, Set every row) sit where the channel scope puts them: the
            footer unmounts while the sheet reloads (`ProductSheetSurface`), and an open window must not vanish and
            come back. */}
        {control.element}</>,
    };
}
