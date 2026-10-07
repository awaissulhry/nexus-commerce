'use client';
import { channelCellDetails } from './channelCellDetails';
import type { CellDetailsContent } from '../cellDetails';
import { useUnpinOnNarrowSheet } from '../useNarrowSheet';
import { reviewCopy } from './reviewCopy';
import { useSheetPreferences } from '../useSheetPreferences';
import { useSheetPublicationGuard } from '../useSheetPublicationGuard';
import { productSheetRowKey, filterProductSheetRows } from '../productSheetRows';
import { useSheetChips } from '../useSheetChips';
import { useSheetSaveStatus } from '../useSheetSaveStatus';
import { useSheetGridBindings } from '../useSheetGridBindings';
import { useProductSheetInteraction } from '../useProductSheetInteraction';
import { useSheetGeometry } from '../useSheetGeometry';
import type { ProductSheetModel } from '../productSheetModel';
import { formulaCandidates, formulaColumnId } from '../formulaColumns';
import { columnLanguages } from '../languages';
import { ShopifySheetReview } from '../../shopify/ShopifySheetReview';
import { recoverSheetRow } from '../sheetRecovery';
import { newOperationId, runBulkOperation, type BulkSend } from '../bulkOperation';
import { createShopifyBulkPost, orderShopifyColumnRequests } from '../../shopify/channelSheetWriter';
import { preserveContentVersions } from '../contentVersions';
import { useSheetUndo } from '../useSheetUndo';
import { useShopifyDraftCell, type ShopifyHistoryRefused } from '../../shopify/ShopifyDraftCell';
import { shopifyHistoryChange, shopifyHistoryRefusal, takeShopifyReplayIntent } from '../../shopify/draftHistory';
import { shopifyGridTransfer } from '../../shopify/shopifyGridTransfer';
import { withShopifyColumns } from '../../shopify/unlinkedInformationColumns';
import { channelScopeUrl } from './useChannelSheet';
import { reloadImpact } from '../master/reloadGuard';
import { ProductRoleChip } from '../ProductRoleChip';
import { formulaTransfer, type CellEditorContext } from '@/design-system/grid';
import { historyLoaderFor, inheritedContextOf } from '../cellEditorContext';
import { SchemaStatus } from './SchemaStatus';
import { LOAD_FIELDS_PERMISSION, useMissingFieldsBanner } from './MissingFieldsBanner';
import { rulesStatus } from './rulesStatus';
import { channelLabel, languageLabel } from '../../scopes';
import { buildCompareTargets } from '../compareTargets';
import { sheetEmptyState } from '../sheetGridStates';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { mediaGridTransfer } from '../../media/mediaGridTransfer';
import { mediaListingName, useProductMediaEditor, withProductMediaColumn } from '../../media/productMediaColumn';
import { withSheetGroups } from '../sheetGroups';
import { useHeaderPaste } from '../headerPaste';
import { isSlotListKey } from '@/design-system/grid/editors/slotList';
import { acknowledgePendingEdits, expandSlotListKeys, queuePendingEdit, revertPendingEdit, slotFanOut, slotListKeyOfSlot, slotListRefusal, withSlotListColumns } from '../slotListColumns';
import { CellSaveTracker, IdentityBand, ProvenanceMark, SheetWriter, bandColSpan, landOnCell, type ColDef, type ICellRendererParams, type SheetWriteRequest, exprOf, isFormulaDraft, type FormulaCandidate, type FormulaWiring } from '@/design-system/grid';
import { Button } from '@/design-system/primitives';
import { Banner, Modal, useToast, type MenuItemDef } from '@/design-system/components';
import { refusalWords } from '@/design-system/grid/editors/refusalWords';
import { AliasBandCell, BandExpander } from './AliasBandCell';
import { SCOPE_PROGRESS_COLUMN, isProgressColumn, listingsHref, progressColumn, progressSheetColumn, refreshProgressItem, rowProgressValue, sheetFieldAction, type ColumnPresence } from '../progressColumns';
import { AliasPublishControl } from './AliasPublishControl';
import { usePublicationStatus } from '@/app/products/_publication/dialog/usePublicationStatus';
import { destinationLabel as publishDestinationLabel, rejectedFilterMenuLabel, withRejectedFilter } from '@/app/products/_publication/dialog/outcome';
import { PUBLISH_COLUMN, isRejectedRow, publishColumn, publishColumnLookup, publishHistorySearch, publishReadFor, publishSheetColumn, rejectedRowCount, rowPublishValue, sellingChangeInFlight, useSellingChangeReRead, type PublishCellValue } from './publishColumn';
import { StudioPublishDialog } from '../../StudioPublishDialog';
import { aliasName, listingPublishScope, pageListingSelection } from '../../listingScope';
import type { StudioPublishScope } from '@nexus/shared/studio-publication';
import { takeSheetLanding } from '@/app/products/_publication/history/runActions';
import { discardOfferDrafts, offerDraftControls } from './offerDrafts';
import { useLiveStockCells } from './useLiveStockCells';
import { useCellFormulas } from '../../useCellFormulas';
import { HELD_EDIT_DROPPED, HELD_FOR_FORMULAS } from '../../formulaReadiness';
import { useActionConfirm } from '@/design-system/grid/actions/ActionConfirm';
import { wholeListWriteField } from './provenance';
import { rowProgressUnscorable, channelWriteIdentity, channelWriteGate, dataPathFor, distinctVariantCount, isCellEditable, offersCascade, orderRows, rowIdOf, summariseAlias, withRowIdentity, crossChannelColumnCount, reviewRowsOf } from './rows';
import { aliasMark, type CascadeIntent } from './provenance';
import { studioAccountAccess } from '../../accountScope';
import { FollowUpRead, rowSettle } from './saveSettle';
import type { AliasGroup as PreflightAlias } from './types';
import { mappingHref } from '@/app/channels/mapping/_shared/navigation';
import type { GetContextMenuItemsParams } from '@/design-system/grid';
import { commitChannelRow, useChannelSheet, type CreatedListing } from './useChannelSheet';
import { ASIN_PENDING_CHIP_LABEL, asinPendingChipDetail, asinPendingCount, connectAccountSentence, coordinateListingState, DRAFT_CHIP_LABEL, draftChipDetail, draftStartedMessage, draftStartSentence, noAccountTitle, notListedTitle } from '../../draftListing';
import { useReadinessRefresh, useSaveReporter, useStudioProduct, useStudioRecord, useStudioScope, useViewChips } from '../../contracts';
import type { CompareTarget } from '../../drawer/types';
import { useAuth } from '@/lib/auth/AuthProvider';
import { SheetTransfer } from '../../transfer/SheetTransfer';
import { readinessMeta } from '@/design-system/grid/renderers/readiness';
import { getBackendUrl } from '@/lib/backend-url';
import { useLiveRead } from '../../live-read/useLiveRead';
import { channelSurfaceKey } from './persistence';
import { exportGridCsv, GridExportRefused } from '@/design-system/grid/export/exportGrid';
import { useLanguageChips } from '../useLanguageChips';
import { useSheetColumns } from '../useSheetColumns';
import type { SheetExportMode } from '../sheetExport';
import type { SheetColumn as StudioSheetColumn } from '../master/types';
import type { PrefsBridgeOptions } from '@/design-system/grid/columns/columnPrefs';
import { FormulaBulkDialog } from '../FormulaBulkDialog';
import { FormulaHistoryDialog } from '../FormulaHistoryDialog';
import { actionContextMenu, actionMenuItems } from '@/design-system/grid/actions/menuAdapters';
import { useActionPress } from '@/design-system/grid/actions/useActionPress';
import { useReferenceNames } from '../useReferenceNames';
import { referenceSearchText } from '../referenceLabels';
import { RESERVED_COLUMN_IDS } from '../views';
import { flaggedColumnKeys } from '../flaggedColumns';
import { ACTION_ROLE_CANNOT_PUBLISH, CHANNEL_VERB_PERMISSION, actionMenuEntries, channelActions, listingBandActions, type PermissionState } from './channelActions';
import { invalidatePublishActions } from '../publishActionsApi';
import { inactiveStatusMark, isInactiveCell, isWaitingCell, operationToast, publishCellKey, usePublishActions, waitingCountsOf, waitingStatusMark, waitingTotalOf, type PublishCellInput } from '../usePublishActions';
import { sheetPublishColumnOf, usePublishCellEditing, type PublishCellPlace } from '../usePublishCellEditing';
import { STATUS_COLUMN, statusColumn, statusSheetColumn, type PublishCellReadState } from './statusColumn';
import { ACTION_COLUMN, PublishActionMenu, actionColumn, actionSheetColumn } from './actionColumn';
import { useDeleteRows } from '../deleteRows/useDeleteRows';
import { FamilySelectionVerbs } from '../master/FamilySelectionBar';
import type { PublishActionChange } from '@nexus/shared/publish-actions';
import { ExpandSlot, SELLING_ROW_MARK_CLASS, UNSAVED_ROW_CLASS, isUnsavedRowData, rowCarriesInactiveMark } from '@/design-system/grid';
import { aliasKeyOf, wireAliasKey, type ChannelScopeChannel, type ChannelSheetRow, type StudioCellValue, type StudioRow } from './types';
import './channel-sheet.css';
import { buildSheetColumns } from '../buildSheetColumns';
import { useSheetControl } from '../useSheetControl';
import { channelResetOffer, controlColumnFacts } from '../sheetReset';
import { useIdentitySkuColumn } from '../identitySkuColumn';
import { IDENTITY_SKU_COLUMN, identitySkuEditability, listingSkuLabel } from '../identitySkuEdit';
import { NewRowCell } from '../newRows/NewRowCell';
import { NewRowsControl } from '../newRows/NewRowsControl';
import { aliasTarget, newRowsContextMenu, newRowsGridKey, newRowsPaste, useNewRows, variationTarget } from '../newRows/useNewRows';
import { channelNewRow, lockedOnNewRows, newRowRefusal, unsavedOf, withNewRows } from '../newRows/newRowsGrid';
import type { NewRowKind } from '../newRows/newRows';
import { sharedIdentityRows } from '../familyOrder';
import { useFamilyRank } from '../useFamilyRank';
import { FamilyOrderNotice } from '../FamilyOrderNotice';
/** Add rows — a channel scope adds variations or listings (aliases). */
const CHANNEL_ROW_KINDS: readonly NewRowKind[] = ['variation', 'alias'];
/** No rows yet — one constant, so the family rank is not rebuilt on every render while the sheet loads. */
const NO_ROWS: readonly StudioRow[] = [];
export interface ChannelSheetProps {
    shopifySchema?: import('@nexus/shared/shopify-linked-products').ShopifyStoreSchema | null;
    accountId?: string;
    productId: string;
    channel: ChannelScopeChannel;
    marketplace: string;
    locale?: string;
}
const DRAWER_READ_ONLY = 'Edit channel values in the sheet — the drawer is read-only on a channel scope.';
/** The server's `schemaMissing` entry for a Shopify scope built without the store's field list. */
const SHOPIFY_FIELDS_UNREAD = 'SHOPIFY:*';
export function useChannelSheetAdapter({ productId, channel, marketplace, locale, accountId, shopifySchema }: ChannelSheetProps): ProductSheetModel<ChannelSheetRow, null, ChannelSheetRow> {
    const record = useStudioRecord();
    const { apiRef, gridReady, getGridApi, bindGridApi, releaseGrid, search, setSearch, showRefusedOnly, setShowRefusedOnly, lastDataCell, refusalReason, onCellFocused, onCellDoubleClicked, onCellKeyDown, onSelectionChanged, clearSelection, rowSelection, selectedRows: selected, setSelectedRows: setSelected, announceRefusals } = useProductSheetInteraction<ChannelSheetRow>('channel');
    const savedAtRef = useRef<(at: string) => void>(() => undefined);
    const { toast } = useToast();
    const languageScope = useStudioScope();
    const { accounts, destination, setListing, registerScopeChangeGuard } = languageScope;
    const alternateAccount = !studioAccountAccess(accounts, accountId).supportsPrimaryTools;
    const { data: loadedData, loading: sheetLoading, switching, error, backendMissing, reload, refresh } = useChannelSheet({
        productId,
        locales: languageScope.locales,
        schemaRevision: shopifySchema?.revision,
        channel,
        marketplace,
        locale,
        accountId,
    });
    const selectedAlias = destination.status === 'ready' ? destination.data.aliasKey : null;
    /* Sheet publish parity, step 2 — a publication's result arrives without a click: the toolbar mark below and one toast. */
    const publication = usePublicationStatus({ channel, marketplace, accountId, aliasKey: destination.status === 'ready' ? destination.data.aliasKey ?? '' : null });
    // Selling changes send no publication event: the Last publish column reads again while one is still being sent — on
    // the main (or chosen) listing, or on any alias shown with it (aliases, Owner 2026-10-05).
    useSellingChangeReRead([publication.status, ...[...publication.aliasReads.values()].map((read) => read.status)].find((status) => sellingChangeInFlight(status)) ?? null, publication.reload);

    /* Build shape v2, P8 — the Status and Action columns: the family's waiting values on this channel · market (every
       listing of it: rows are matched by their listing id). Read alongside the sheet, not after it. */
    const publishActions = usePublishActions(productId, { channel, marketplace, accountId: accountId ?? null }, { familyId: loadedData?.family?.id ?? null });
    const selectedData = useMemo(() => !loadedData || selectedAlias === null ? loadedData : {
        ...loadedData, rows: loadedData.rows.filter(row => (row.aliasId ?? '') === selectedAlias),
        aliases: loadedData.aliases.filter(alias => (alias.id ?? '') === selectedAlias),
    }, [loadedData, selectedAlias]);
    const shopifyData = useMemo(() => withShopifyColumns(selectedData, shopifySchema), [selectedData, shopifySchema]);
    const data = useReferenceNames(shopifyData, channel, marketplace, accountId);
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;
    /* TOOLBAR REBUILD (2026-09-27) — the scope's readiness (the Editing menu's percentages) is read again after every
       confirmed save, on Reload and on "Refresh progress". A burst of saves asks once. */
    const refreshReadiness = useReadinessRefresh();
    const readinessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (readinessTimer.current) clearTimeout(readinessTimer.current); }, []);
    /* P2 review 4 — a save since the last readiness read wrote the shared record (a master field, content saved to every
       channel): the Shared chip and every channel that follows it moved, so the whole family is read. */
    const readinessForFamily = useRef(false);
    const refreshReadinessSoonRef = useRef(() => { });
    refreshReadinessSoonRef.current = () => {
        if (readinessTimer.current) clearTimeout(readinessTimer.current);
        // P2 (I4-9) — a save that moved this coordinate only reads it, not the family's every coordinate.
        readinessTimer.current = setTimeout(() => {
            readinessTimer.current = null;
            const family = readinessForFamily.current;
            readinessForFamily.current = false;
            refreshReadiness(family ? undefined : { coordinate: true });
        }, 800);
    };
    /* When the rows (and so this scope's progress bars) were last read — "Refresh progress · read 12:04". */
    const [progressReadAt, setProgressReadAt] = useState<number | null>(null);
    useEffect(() => { if (data) setProgressReadAt(Date.now()); }, [data]);
    const progressReadAtRef = useRef(progressReadAt);
    progressReadAtRef.current = progressReadAt;
    const [tracker] = useState(() => new CellSaveTracker());
    const activeCellsRef = useRef<{
        byRow: Record<string, string[]>;
    } | null>(null);
    const reporter = useSaveReporter();
    const reporterRef = useRef(reporter);
    reporterRef.current = reporter;
    const writeSeq = useRef(0);
    const writeInstanceId = useId();
    const [requirementsOpen, setRequirementsOpen] = useState(false);
    const [formulaHistoryOpen, setFormulaHistoryOpen] = useState(false);
    const [bulkFormulaRows, setBulkFormulaRows] = useState<Array<{
        id: string;
        label: string;
        rowId: string;
        aliasKey: string;
    }> | null>(null);
    const [transferIntent, setTransferIntent] = useState<'import' | 'export'>('import');
    const [transferOpen, setTransferOpen] = useState(false);
    const surfaceKey = channelSurfaceKey(channel, marketplace);
    const [exportNote, setExportNote] = useState<string | null>(null);
    /* P2 (I4-4) — a server row keeps its grid row object: reference names landing, or a read that returns the row
       unchanged, never make AG re-render it, and an edit settled in place (`savedCellPatch.ts`) survives them. */
    const rowObjects = useRef(new WeakMap<object, ChannelSheetRow>());
    /* Owner 2026-10-07 (Option A) — the rows inside each alias block follow the Matrix's family order (`useFamilyRank`). */
    /* Ranked from every row the sheet read, before a listing is chosen: picking one alias must not read the family again. */
    const rankRows = useMemo(() => sharedIdentityRows(loadedData?.rows ?? NO_ROWS), [loadedData]);
    const familyOrder = useFamilyRank(productId, rankRows, loadedData?.columns);
    /* Held until the family order is first read: rows that moved after the first paint would leave a focused cell on another SKU. */
    const orderPending = !!data && !familyOrder.settled;
    /* Everything that reads "loaded" — the toolbar, Export, the chips, the drawer — waits for the order too. */
    const loading = sheetLoading || orderPending;
    const rows = useMemo(() => (data && familyOrder.settled ? orderRows(withRowIdentity(data.rows, data.aliases, rowObjects.current), familyOrder.rank) : []), [data, familyOrder.settled, familyOrder.rank]);
    // Read live (Owner, 2026-09-26) — one ⋯ item and its drawer; everything else lives in _studio/live-read.
    const liveRead = useLiveRead({ productId, channel, channelLabel: data?.scope.label ?? channel, marketplace, accountId, aliasKey: selectedAlias, rows });
    const channelRefusal = (key: string, row: ChannelSheetRow): string | null => {
        if (key === IDENTITY_SKU_COLUMN)
            return identitySkuEditability({ kind: 'channel', channel, marketplace }, row).reason;
        const col = data?.columns.find(column => column.key === key);
        if (!col)
            return null;
        const cell = row.values?.[key];
        if (isCellEditable(cell))
            return null;
        return cell?.writeBlockedReason || refusalWords(col.label || col.key, { kind: cell?.writable === false ? 'channel-not-writable' : col.editable === false ? 'column-read-only' : 'cell-locked' });
    };
    /* Step 4.3 #3 — a locked bullets cell says why: the first locked position's own reason. */
    refusalReason.current = (key, row) => {
        const fresh = newRowRefusal(key, row);
        return fresh !== undefined ? fresh : isSlotListKey(key) ? slotListRefusal(key, row, data?.columns ?? [], channelRefusal) : channelRefusal(key, row);
    };
    const { bandWidthRef, bandDerivedRef, revealCell } = useSheetGeometry({ scope: 'channel', rows, getGridApi, gridReady, recordId: record.rowId });
    const dataRef = useRef(data);
    dataRef.current = data;
    const rowsRef = useRef(rows);
    rowsRef.current = rows;
    /* Sheet publish parity, step 3 — the "Last publish" column reads the destination's publication status through a
       ref, so a new answer refreshes its cells without rebuilding the column (`refreshCells` below). */
    const publishLookup = useMemo(() => publishColumnLookup(data?.columns ?? [], data?.scope.label ?? ''), [data?.columns, data?.scope.label]);
    const publishValueRef = useRef<(row: ChannelSheetRow) => PublishCellValue>(() => undefined);
    /* Aliases (Owner 2026-10-05) — with every listing shown, each alias's rows read that alias's own last publish
       (`publication.aliasReads`, the same reader as the mark and the toast); the main (or chosen) listing's rows read
       `publication.read`. With one listing chosen there are no other reads. */
    const listingPublications = publication.aliasReads;
    const rowPublicationStatus = useCallback((row: { aliasId: string | null }) => publishReadFor(row, publication.read, listingPublications).status, [publication.read, listingPublications]);
    publishValueRef.current = (row) => rowPublishValue(row, publishReadFor(row, publication.read, listingPublications), publishLookup, publishDestinationLabel(channel, marketplace));
    const [showRejectedOnly, setShowRejectedOnly] = useState(false);
    const rejectedCount = useMemo(() => rejectedRowCount(rows, rowPublicationStatus), [rows, rowPublicationStatus]);
    useEffect(() => { if (!rejectedCount) setShowRejectedOnly(false); }, [rejectedCount]);
    /* Create path, step 6 — a save that STARTED this coordinate's draft (parent + variants) has its listings adopted
       into the rows in place (`commitChannelRow` → `adoptCreatedListings`), so the next save on any row of the family
       carries the real version. The epoch makes the header and chip read those rows again at once, and the toast
       says what happened: a draft, and nothing sent. */
    const [listingEpoch, setListingEpoch] = useState(0);
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const onListingsCreatedRef = useRef<(created: CreatedListing[]) => void>(() => { });
    onListingsCreatedRef.current = (created) => {
        setListingEpoch((n) => n + 1);
        const family = dataRef.current?.family;
        if (family)
            toastRef.current(draftStartedMessage({ rootSku: family.sku, familyId: family.id, channel, market: marketplace, created }), 'success');
    };
    const formulaRowIds = useMemo(() => rows.map(r => r.rowId), [rows]);
    const formulaRowScopes = useMemo(() => Object.fromEntries(rows.map(r => [r.rowId, { productId: r.id, aliasKey: r.aliasId ?? '' }])), [rows]);
    const formulas = useCellFormulas({
        writeFacts: (rowId, fieldKey) => rows.find(row => row.rowId === rowId)?.values[fieldKey],
        productId,
        scope: 'channel',
        channel,
        marketplace,
        market: marketplace,
        locale: data?.scope.locale ?? locale ?? '',
        rowIds: formulaRowIds,
        columnKeys: data?.columns.map(column => column.key),
        rowScopes: formulaRowScopes,
        /* P0 — the rows already say which cells hold a formula, so no editor waits for the formula reads. */
        seedRows: rows,
        channelConnectionId: data?.scope.connectionId ?? accountId,
        onSettled: () => { void refresh(() => !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0); },
        onValueSaved: (rowId, fieldKey, value) => {
            const node = getGridApi()?.getRowNode(rowId);
            if (!node?.data)
                return;
            const cell = node.data.values?.[fieldKey];
            if (cell)
                node.data.values = { ...node.data.values, [fieldKey]: { ...cell, value } };
            getGridApi()?.refreshCells({ rowNodes: [node], columns: [fieldKey], force: true });
        },
    });
    const candidatesFor = useCallback((row: ChannelSheetRow, fieldKey?: string): FormulaCandidate[] => {
        const cols = formulaCandidates(dataRef.current?.columns ?? [], row.values, fieldKey, locale ?? '');
        const fns = formulas.functions.map((f) => ({
            name: f.name,
            kind: 'function' as const,
            label: f.name,
            group: 'Functions',
        }));
        return [...cols, ...fns];
    }, [formulas, locale]);
    const colIdOfRef = useCallback((name: string, fieldKey?: string) => formulaColumnId(dataRef.current?.columns ?? [], name, fieldKey, dataRef.current?.scope.locale ?? ''), []);
    const formulaLive = useRef({ candidatesFor, colIdOfRef, formulas, alternateAccount });
    formulaLive.current = { candidatesFor, colIdOfRef, formulas, alternateAccount };
    /* Option A (2026-09-26) — the cell editor's history and "follows" context (this scope has no AI draft layer). Assigned
       once the scope is known; read through this ref so the wiring stays one stable object. */
    const editorContextLive = useRef<(row: ChannelSheetRow, key: string) => CellEditorContext | null>(() => null);
    useEffect(() => {
        const api = getGridApi();
        if (!api || api.isDestroyed())
            return;
        api.refreshCells({ force: true });
    }, [formulas.exprFor, formulas.errorFor]);
    const refusedReasonFor = useCallback((productId: string, fieldKey: string) => formulaLive.current.formulas.errorFor(productId, fieldKey), []);
    const formulaWiring = useMemo<FormulaWiring<ChannelSheetRow>>(() => ({
        canEditRow: () => true,
        candidatesFor: (row, fieldKey) => formulaLive.current.candidatesFor(row, fieldKey),
        preview: (rowId, fieldKey, expr, signal) => formulaLive.current.formulas.preview(rowId, fieldKey, expr, signal),
        functions: () => formulaLive.current.formulas.functions,
        replaceFormula: (rowId: string, fieldKey: string, value: unknown) => formulaLive.current.formulas.replace(rowId, fieldKey, value),
        unavailableReason: (rowId, fieldKey) => formulaLive.current.formulas.unavailableFor(rowId, fieldKey),
        retry: () => formulaLive.current.formulas.reload(),
        sourceLabel: fieldKey => formulaLive.current.formulas.sourceLabelFor(fieldKey),
        exprFor: (rowId, fieldKey) => formulaLive.current.formulas.exprFor(rowId, fieldKey),
        errorFor: (rowId, fieldKey) => formulaLive.current.formulas.errorFor(rowId, fieldKey),
        colIdOfRef: (name, fieldKey) => formulaLive.current.colIdOfRef(name, fieldKey),
        contextFor: (row, key) => editorContextLive.current(row, key),
    }), []);
    const formulaClipboard = useMemo(() => formulaTransfer<ChannelSheetRow>({
        exprFor: (row, key) => formulaWiring.exprFor(row.rowId, key),
        canEditRow: formulaWiring.canEditRow,
    }), [formulaWiring]);
    const unsettledWrites = useRef(new Map<string, {
        writeId: string;
        subject: string;
    }>());
    /* P2 (I4-4) — a confirmed save the sheet could not settle in place owes ONE quiet read, taken when the sheet is idle;
       P2 review 3 — a read that is dropped (an editor open, a newer write, a failed fetch) stays owed and is tried again. */
    const [followUp] = useState(() => new FollowUpRead({
        idle: () => writerRef.current?.pending === 0 && !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0,
        read: (canApply) => refreshRef.current(canApply),
        sequence: () => writeSeq.current,
        schedule: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
    }));
    useEffect(() => () => followUp.dispose(), [followUp]);
    useLiveStockCells({ familyId: data?.family?.id ?? null, accountId: data?.scope.connectionId ?? accountId, rowsRef, getGridApi, tracker, owe: () => { followUp.owe(); followUp.settle(); } });
    /** Repaint the cells a save settled in place: the saved columns of the saved row, its progress, the theme token. */
    const repaintSettled = (patched: Set<ChannelSheetRow>, columns: Set<string>, request: SheetWriteRequest<ChannelSheetRow>) => {
        const api = getGridApi();
        if (!api || api.isDestroyed())
            return;
        const nodes = [...patched].flatMap((row) => { const node = api.getRowNode(row.rowId); return node ? [node] : []; });
        /* 2026-10-01 — the request's OWN cells are repainted by the writer's settle a moment later (`SheetWriter.settle`
           repaints every cell it sent); forcing them here too drew each edited cell twice. Every other patched cell —
           another row of the family, another column of this row — is still forced here. */
        const sent = new Set(request.cells.map((cell) => cell.colId));
        const others = nodes.filter((node) => node.id !== request.rowId);
        const own = nodes.find((node) => node.id === request.rowId);
        const ownColumns = [...columns].filter((colId) => !sent.has(colId));
        if (others.length)
            api.refreshCells({ rowNodes: others, columns: [...columns], force: true });
        if (own && ownColumns.length)
            api.refreshCells({ rowNodes: [own], columns: ownColumns, force: true });
        /* The progress cell is compared, not forced: its column's `equals` repaints it only when the reading changed. */
        api.refreshCells({ rowNodes: nodes, columns: [SCOPE_PROGRESS_COLUMN] });
    };
    const writerRef = useRef<SheetWriter<ChannelSheetRow> | null>(null);
    if (writerRef.current === null) {
        /* ONE row's save, with its reporter bookkeeping. `bulkSend` present = this row is one unit of a sheet operation
           (`runBulkOperation`, `bulkOperation.ts`), which leaves as ONE bulk-save request with every other row it changed. */
        const commitOne = async (req: SheetWriteRequest<ChannelSheetRow>, bulkSend?: BulkSend) => {
            const { writeId, subject } = channelWriteIdentity(req.rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId });
            reporterRef.current.pending(writeId, subject);
            /* VT.2 — the COLUMN's kind, so a `variationTheme` cell can leave by its own route.
               🔴 `dataRef.current`, NOT `data`: this `commit` closure is created once and lives
               for the writer's lifetime, so a captured `data` is whatever it was at mount —
               `undefined` on the first render, which made `kindOf` answer undefined for every
               column and silently disabled the split. Witnessed: a theme pick on Amazon·IT
               reported `set` in the editor's own footer and issued no projection request at all.
               The same ref discipline the formula candidates two hooks above already follow. */
            /* P2 (I4-4) — how this save settled: patched in place from its answer (`savedCellPatch.ts`), or it owes the one
               quiet read. P2 review 1 — only when EVERY cell it sent was reported patched: a part that reports nothing (a
               variation theme, a Shopify field) or asks for a read makes the sheet read (`rowSettle`). */
            const save = rowSettle(req);
            if (save.touchesMaster()) readinessForFamily.current = true;
            const result = await commitChannelRow(req, { channel, marketplace, accountId, locale, kindOf: (colId) => dataRef.current?.columns?.find((c) => c.key === colId)?.kind,
                familyRows: () => rowsRef.current, onListingsCreated: (created) => onListingsCreatedRef.current(created), bulkSend,
                onProductVersionsChanged: (changed) => writerRef.current?.seed(changed.map(row => ({ id: row.rowId, version: row.version }))),
                columnOf: (colId) => dataRef.current?.columns?.find((c) => c.key === colId),
                onStored: (outcome) => save.onStored(outcome),
                /* P1 review (2) — the family rows a listing-level eBay save moved: repaint them with their new value and token.
                   P2 — only the saved columns of those rows, never every cell of the family. */
                onFamilyChanged: (changed, columns) => {
                    const api = getGridApi();
                    if (!api || api.isDestroyed())
                        return;
                    const nodes = changed.flatMap((moved) => { const node = api.getRowNode(moved.rowId); if (node?.data && node.data !== moved) node.data.values = moved.values; return node ? [node] : []; });
                    api.refreshCells({ rowNodes: nodes, ...(columns?.length ? { columns } : {}), force: true });
                } });
            const inPlace = save.inPlace(result.ok);
            if (inPlace) repaintSettled(inPlace.rows, inPlace.columns, req);
            else if (result.ok) followUp.owe();
            if (result.unreachable)
                unsettledWrites.current.set(req.rowId, { writeId, subject });
            else
                reporterRef.current.resolved(writeId, result.ok, result.reason, subject);
            return result;
        };
        /* The scope's read, ONCE, for every row a lost answer left unknown (`readBackBatch`) or for one row (`readBack`). */
        const readScope = async (requests: SheetWriteRequest<ChannelSheetRow>[]) => {
            const recoveryLanguages = columnLanguages(requests.flatMap(request => request.cells.map(cell => cell.colId)));
            const response = await fetch(channelScopeUrl({ productId, channel, marketplace, accountId, locale, locales: recoveryLanguages.length ? [...new Set([...(locale ? [locale] : []), ...recoveryLanguages])] : null }), { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30000) });
            if (!response.ok)
                return null;
            const page = await response.json();
            return Promise.all(requests.map(request => recoverSheetRow(page, request, { channel, market: marketplace, accountId, locale })));
        };
        writerRef.current = new SheetWriter<ChannelSheetRow>({
            mergeRow: preserveContentVersions,
            tracker,
            getApi: getGridApi,
            commit: (req: SheetWriteRequest<ChannelSheetRow>) => commitOne(req),
            // A fill, a paste, an undo — every row it changed leaves as ONE request (measured 2026-09-29: one request per
            // row made 224 of 250 rows fail or go unconfirmed).
            // Shopify (lane01): ONE stable action id for the whole batch — the root-creation proof and every cells request
            // carry it, unlike the engine's per-round request keys — and rows in write order (follower detach, sources,
            // follower attach). A batch without Shopify units leaves exactly as before.
            commitBatch: (requests) => runBulkOperation(orderShopifyColumnRequests(requests), commitOne, { retrySignal: writerRef.current!.retrySignal,
                post: createShopifyBulkPost(newOperationId(), { signal: writerRef.current!.retrySignal }) }),
            readBackBatch: async (requests) => {
                const reads = await readScope(requests);
                if (!reads)
                    return null;
                return new Map(requests.flatMap((request, i) => reads[i] ? [[request.rowId, reads[i]!] as const] : []));
            },
            onConflict: () => { },
            /* R-VT-15 — the same announcement the master scope makes, from the same shared
               implementation (`useProductSheetInteraction.announceRefusals`), through the one DS toast
               provider this route mounts. Captured once with the writer because it is a stable
               `useCallback`; a changing callback here would rebuild the writer and orphan its queue.
               Before this the channel scope's refusals — including the axis and content-address ones
               this programme measured — appeared only as a red cell mark. */
            onRefused: announceRefusals,
            readBack: async (request) => (await readScope([request]))?.[0] ?? null,
            onReconciled: ({ rowId, ok, savedAt }) => {
                const { writeId, subject } = channelWriteIdentity(rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId });
                const held = unsettledWrites.current.get(rowId);
                ok = ok && !Object.keys(rowsRef.current.find(row => row.rowId === rowId)?.values ?? {}).some(key => tracker.get(rowId, key)?.state === 'refused');
                reporterRef.current.resolved(held?.writeId ?? writeId, ok, ok ? undefined : 'Review the highlighted edits against the stored values.', held?.subject ?? subject);
                unsettledWrites.current.delete(rowId);
                if (ok) {
                    savedAtRef.current(savedAt);
                    refreshReadinessSoonRef.current();
                    // A lost answer is always read back, and that read too stays owed until it lands.
                    followUp.owe();
                    followUp.settle();
                }
            },
            onSettled: ({ ok, savedAt }) => {
                if (!ok)
                    return;
                savedAtRef.current(savedAt);
                refreshReadinessSoonRef.current();
                if (writerRef.current?.pending !== 0)
                    return;
                // P2 (I4-4) — a read only when a save since the last read could not be settled in place.
                followUp.settle();
            },
        });
    }
    const writer = writerRef.current;
    useSheetPublicationGuard(writer, tracker, getGridApi);
    const { saveStatus, refused, refusedRowIds, refreshCounts } = useSheetSaveStatus(writer, tracker, rows, data?.columns);
    savedAtRef.current = saveStatus.saved;
    /* ⌘Z undoes a whole operation (a fill, a paste) in one step and one save, and still works after the sheet re-reads. */
    const undo = useSheetUndo(writer, getGridApi);
    /* S11 — the first column's SKU is THIS listing's own (`../identitySkuColumn.tsx`, rules in `../identitySkuEdit.ts`). */
    /* Add rows (R2, R3) — empty rows in page memory; the SKU typed into one creates a draft variation, or a new listing
       of this product here whose SKU is that listing's own (`../newRows/`). */
    const canAddRows = useAuth().has('products.edit');
    const newRows = useNewRows({ kinds: CHANNEL_ROW_KINDS, registerScopeChangeGuard, say: toast, getGridApi,
        target: (kind) => kind === 'variation' ? variationTarget(rows.find((row) => row.rowKind === 'parent'), canAddRows)
            : aliasTarget({ productId, channel, marketplace, accountId, noAccount: !accountId && !data?.scope.connectionId && accounts.length === 0, canEdit: canAddRows }),
        skuContext: () => ({ family: null, takenSkus: rows.flatMap((row) => [row.sku, row.skuFacts?.wanted ?? '']) }),
        onCreated: (kinds) => { followUp.owe(); followUp.settle(); refreshReadiness(); if (kinds.has('alias')) { invalidatePublishActions(productId); if (selectedAlias !== null) setListing(undefined) } } });
    useEffect(() => newRows.store.landed(new Set([...rows.map((row) => row.id), ...(data?.aliases ?? []).flatMap((alias) => (alias.id ? [alias.id] : []))])), [rows, data, newRows.store]);
    const identitySku = useIdentitySkuColumn<ChannelSheetRow>({ scope: { kind: 'channel', channel, marketplace }, tracker, writer, getGridApi, rowIdOf, recordUndo: undo.record, announce: announceRefusals,
        onCreate: (row, sku) => { newRows.store.type(row.rowId, sku); } });
    const identityNodeRef = useRef(identitySku.node);
    const identityHoverRef = useRef(identitySku.hover);
    useEffect(() => {
        writer.arm();
        return () => writer.destroy();
    }, [writer]);
    useEffect(() => {
        if (!data)
            return;
        writer.seed(rows.map((r) => ({ id: r.rowId, version: r.version, row: r })));
    }, [data, rows, writer]);
    const refreshCountsRef = useRef(refreshCounts);
    refreshCountsRef.current = refreshCounts;
    const reloadConfirm = useActionConfirm();
    const onReload = useCallback(async () => {
        const impact = reloadImpact({ pending: writer.pending, refused, unknown: writer.unknownCount });
        if (impact && !(await reloadConfirm.ask(impact)))
            return;
        reporterRef.current.cleared(rows.map(row => channelWriteIdentity(row.rowId, 0, { channel, marketplace, accountId, locale, instanceId: writeInstanceId }).subject));
        writer.discard();
        newRows.store.clear();
        reload();
        familyOrder.reload();
        refreshReadiness();
    }, [writer, refused, rows, channel, marketplace, accountId, locale, writeInstanceId, reload, familyOrder.reload, reloadConfirm.ask, refreshReadiness, newRows.store]);
    /** "Refresh progress": the rows' bars (a quiet re-read — edits in flight stay) and the scope's readiness. */
    const refreshProgress = useCallback(() => {
        refreshReadiness();
        void refreshRef.current(() => !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0);
    }, [refreshReadiness, tracker, getGridApi]);
    const aliasLabel = useCallback((aliasId: string | null) => {
        const alias = data?.aliases.find((a) => aliasKeyOf(a.id) === aliasKeyOf(aliasId));
        return alias?.label == null ? 'Listing alias label not reported' : alias.label;
    }, [data]);
    const listResetConfirm = useActionConfirm();
    const onCascade = useCallback(async (row: ChannelSheetRow, cell: StudioCellValue, intent: CascadeIntent) => {
        if (!offersCascade(cell))
            return;
        const colKey = Object.keys(row.values).find((k) => row.values[k] === cell) ?? cell.writeField;
        if (intent.action === 'reset' && wholeListWriteField(cell.writeField)) {
            await writer.flush();
            const base = wholeListWriteField(cell.writeField)!;
            const slots = (data?.columns ?? []).filter(col => wholeListWriteField(row.values[col.key]?.writeField ?? '') === base);
            const followsMaster = !!cell.mapped?.sourcePath && !cell.mapped.usesExpression;
            const confirmed = await listResetConfirm.ask({ level: 'confirm', title: followsMaster ? 'Follow Shared for the whole list?' : 'Remove the whole list’s override?',
                consequences: [
                    `Remove the override for all ${slots.length} positions in this list for ${row.sku} on ${channel} · ${marketplace}, ${aliasLabel(row.aliasId)}.`,
                    followsMaster ? 'Future changes to the Shared product will flow through its channel mapping.' : 'The list will use its configured mapping or default. It may become empty if no source is configured.',
                    'Current values being replaced:',
                    ...slots.map(col => `${col.label}: ${String(row.values[col.key]?.value ?? 'Empty')}`),
                ] });
            if (!confirmed)
                return;
            writer.set(row.rowId, colKey, null, { row, intent: 'reset-list' });
            return;
        }
        writer.set(row.rowId, colKey, intent.value, { row, intent: intent.action });
    }, [writer, data, channel, marketplace, aliasLabel, listResetConfirm.ask]);
    /* P1 — full control: Reset to inherited in the cell menu, on a selection and on a whole column; Set every row…;
       Delete asks Clear or Reset; Shift+F10 opens a cell's menu. The same hook serves the Master sheet. */
    const control = useSheetControl<ChannelSheetRow>({
        getGridApi, writer, operation: undo.operation,
        rowIdOf, skuOf: row => row.sku,
        offerOf: (row, colId) => channelResetOffer(row, colId, !!formulaLive.current.formulas.exprFor(row.rowId, colId)),
        listOf: (row, colId) => wholeListWriteField(row.values?.[colId]?.writeField ?? ''),
        columnFacts: colId => controlColumnFacts(dataRef.current?.columns.find(column => column.key === colId)),
        hidesInherited: () => true,
        removeFormula: (rowId, colId) => formulaLive.current.formulas.pinOver(rowId, colId),
        // A whole list keeps its review of the positions it replaces (`onCascade`).
        resetOne: (row, colId, offer) => {
            const cell = row.values?.[colId];
            if (offer.intent !== 'reset-list' || offer.formula || !cell) return false;
            void onCascade(row, cell, { action: 'reset', target: row.rowKind === 'parent' ? 'alias' : 'aliasVariant', value: null });
            return true;
        },
        say: (message, tone = 'danger') => toast(message, tone),
        /* Cell details (2026-10-04) — the shared window, menu item and ⋯ item; the channel's own words (`channelCellDetails`)
           on every column of the scope, read-only ones included. */
        details: {
            explains: colId => !!data?.columns.some(column => column.key === colId),
            describe: (row, colId): CellDetailsContent | null => {
                const column = data?.columns.find(c => c.key === colId);
                return column ? channelCellDetails(row, column, {
                    productLevelOnly: data?.meta?.mapping?.productLevelOnly ?? false, scopeLabel: data?.scope.label ?? '', channel, marketplace,
                    refusedReasonFor, exprFor: (rowId, colKey) => formulaLive.current.formulas.exprFor(rowId, colKey), tracker, aliasLabel,
                    reset: (targets): Promise<void> => control.reset(targets), cascade: onCascade,
                }) : null;
            },
        },
    });
    /* Amazon sheet gaps (D4=B) — offer changes waiting for Publish: toolbar mark, its filter, the ⋯ items (`offerDrafts.ts`). */
    const [showWaitingOnly, setShowWaitingOnly] = useState(false);
    const offerDrafts = useMemo(() => offerDraftControls(rows, { filterOn: showWaitingOnly, toggle: () => setShowWaitingOnly(v => !v), destination: publishDestinationLabel(channel, marketplace), labelOf: colId => dataRef.current?.columns.find(c => c.key === colId)?.label ?? colId,
        discard: (impact, targets) => void Promise.resolve(listResetConfirm.ask(impact)).then(ok => { if (ok) discardOfferDrafts(writer, targets, rowId => rowsRef.current.find(r => r.rowId === rowId)); }) }), [rows, showWaitingOnly, channel, marketplace, listResetConfirm.ask, writer]);
    useEffect(() => { if (!offerDrafts.count.changes) setShowWaitingOnly(false); }, [offerDrafts.count.changes]);
    type PendingContentEdit = {
        rowId: string;
        colId: string;
        value: unknown;
        row: ChannelSheetRow;
        previous: unknown;
    };
    const [pendingWrites, setPendingWrites] = useState<PendingContentEdit[]>([]);
    const pendingMasterWrite = pendingWrites[0] ?? null;
    /* LX.14 — one queued choice per edited cell (a bullets cell's positions queue one each); the reducer lives in
       `slotListColumns.ts` unchanged so the bullets arm runs it. */
    const setPendingMasterWrite = (next: PendingContentEdit | null) => setPendingWrites(prior => queuePendingEdit(prior, next));
    const acknowledgedRef = useRef(false);
    const revertingRef = useRef(false);
    useEffect(() => {
        acknowledgedRef.current = false;
        setPendingWrites([]);
    }, [channel, marketplace, accountId, locale]);
    const onCellValueChanged = useCallback((e: {
        data?: ChannelSheetRow;
        colDef: {
            colId?: string;
        };
        newValue: unknown;
        source?: string;
        oldValue?: unknown;
    }): void => {
        const colId = e.colDef.colId;
        if (!e.data || !colId)
            return;
        if (identitySku.onValueChanged(e))
            return;
        /* Step 4.3 #3 (A-52, R-55) — the one bullets cell is not a field: its change leaves as one dispatch per CHANGED
           position, each through THIS handler under that slot's own column id (gate, acknowledgement, formula check,
           `writer.set`) — exactly the path a typed slot takes. The writer coalesces them into the row's one request. */
        const fanOut = slotFanOut(colId, e.oldValue, e.newValue, dataRef.current?.columns ?? []);
        if (fanOut) {
            for (const slot of fanOut)
                onCellValueChanged({ data: e.data, colDef: { colId: slot.colId }, oldValue: slot.oldValue, newValue: e.data.values?.[slot.colId]?.value ?? slot.newValue, source: e.source });
            const node = getGridApi()?.getRowNode(rowIdOf(e.data));
            if (node)
                getGridApi()?.refreshCells({ force: true, rowNodes: [node], columns: [colId] });
            return;
        }
        const gate = channelWriteGate({
            colId,
            source: e.source,
            selfInflicted: revertingRef.current,
            cell: e.data.values?.[colId],
            acknowledged: acknowledgedRef.current,
        });
        if (gate === 'ignore' || gate === 'blocked')
            return;
        if (gate === 'acknowledge') {
            setPendingMasterWrite({
                rowId: e.data.rowId,
                colId,
                value: e.newValue,
                row: e.data,
                previous: (e as {
                    oldValue?: unknown;
                }).oldValue,
            });
            return;
        }
        const shopifyValue = !!data?.columns.find(column => column.key === colId)?.shopifyField;
        /* P0 — a cell whose formula state is not known yet keeps the edit and applies it once it is (the formula path if
           the cell turns out to hold one). Never refused: the refusal lost every paste made while formulas loaded. */
        if (!shopifyValue && !formulas.knownFor(e.data.rowId, colId)) {
            const rowId = e.data.rowId;
            tracker.set(rowId, colId, 'saving', HELD_FOR_FORMULAS);
            formulas.whenKnown(rowId, colId, () => {
                if (tracker.get(rowId, colId)?.reason === HELD_FOR_FORMULAS)
                    latestValueChanged.current(e);
            }, (reason) => tracker.set(rowId, colId, 'refused', reason ?? HELD_EDIT_DROPPED));
            return;
        }
        const typed = typeof e.newValue === 'string' ? e.newValue : null;
        if (!shopifyValue && ((typed !== null && isFormulaDraft(typed)) || formulas.exprFor(e.data.rowId, colId!))) {
            const row = e.data;
            const prev = row.values?.[colId];
            if (prev) {
                row.values = { ...row.values, [colId]: { ...prev, value: e.oldValue } };
                const node = getGridApi()?.getRowNode(rowIdOf(row));
                if (node)
                    getGridApi()?.refreshCells({ force: true, rowNodes: [node], columns: [colId] });
            }
            const { writeId, subject } = channelWriteIdentity(row.rowId, ++writeSeq.current, { channel, marketplace, accountId, locale, instanceId: writeInstanceId });
            reporterRef.current.pending(writeId, subject);
            void (typed !== null && isFormulaDraft(typed) ? formulas.save(row.rowId, colId, exprOf(typed)) : formulas.replace(row.rowId, colId, e.newValue))
                .then((r) => {
                reporterRef.current.resolved(writeId, r.ok, r.error, subject);
                tracker.set(row.rowId, colId, r.ok ? 'saved' : 'refused', r.error);
                if (!r.ok) {
                    const cell = row.values?.[colId];
                    if (cell) {
                        row.values = { ...row.values, [colId]: { ...cell, value: e.newValue } };
                        const n = getGridApi()?.getRowNode(rowIdOf(row));
                        if (n)
                            getGridApi()?.refreshCells({ force: true, rowNodes: [n], columns: [colId] });
                    }
                }
            })
                .catch((err: unknown) => {
                const reason = err instanceof Error ? err.message : String(err);
                tracker.set(row.rowId, colId, 'unknown', `Could not confirm this save. Refresh to check: ${reason}`);
                reporterRef.current.resolved(writeId, false, reason, subject);
            });
            return;
        }
        /* Shopify (lane01): the history keeps the cell's own/follow state with its value, and an undo/redo replay writes
           with the intent that state needs (`reset` restores following, also when the values are equal). */
        const history = shopifyValue ? shopifyHistoryChange(e.data.values?.[colId], e.oldValue, e.newValue) : null;
        undo.record({ rowId: e.data.rowId, colId, before: history ? history.before : e.oldValue, after: history ? history.after : e.newValue }, e.source);
        const replay = shopifyValue ? takeShopifyReplayIntent(e.data.values?.[colId]) : undefined;
        writer.set(e.data.rowId, colId, replay === 'reset' ? null : e.newValue, { row: e.data, intent: replay ?? 'set' });
    }, [writer, formulas, reload, channel, marketplace, accountId, locale, writeInstanceId, undo.record, identitySku.onValueChanged]);
    /* A held edit re-enters through the LATEST handler, which sees the formula state that released it. */
    const latestValueChanged = useRef(onCellValueChanged);
    latestValueChanged.current = onCellValueChanged;
    /* The band stops before the progress column (2026-09-26): the listing row keeps its own progress cell there, as
       master's parent row does. */
    const bandSpan = useMemo(() => bandColSpan<ChannelSheetRow>({ isBand: (d) => d?.rowKind === 'parent', stopBefore: isProgressColumn }), []);
    const auth = useAuth();
    const permission: PermissionState = auth.status === 'loading' ? 'checking'
        : auth.status === 'anon' ? 'no-session'
            : auth.has(CHANNEL_VERB_PERMISSION) ? 'granted'
                : 'denied';
    /* ── Build shape v2, P8 — the Status and Action columns, Action ▾, the waiting mark and the inactive chip ─────────
       The values live in `usePublishActions` (never in the row, never in the sheet's writer); a cell edit, a fill, a
       paste, a reset or Action ▾ STAGES its cells in one fence, and they leave as one write per column and value, with
       ONE toast. Nothing here sends anything to a channel: Publish does. */
    const publishActionsRef = useRef(publishActions);
    publishActionsRef.current = publishActions;
    /* A row finds its cell by its listing id; a row with no listing here yet (a new row, or one whose drafts a choice
       just started, until the sheet reads again) by its product and listing alias. */
    const publishCellOf = useCallback((row: ChannelSheetRow) => {
        const id = row.listing?.id;
        const byId = id ? publishActionsRef.current.byListingId.get(id) : undefined;
        return byId ?? (id ? null : publishActionsRef.current.byProductKey.get(publishCellKey(row.id, wireAliasKey(row.aliasId))) ?? null);
    }, []);
    const publishLock = auth.status !== 'loading' && !auth.has('products.publish') ? ACTION_ROLE_CANNOT_PUBLISH : null;
    const publishRead = useMemo<PublishCellReadState>(() => ({
        loaded: publishActions.status === 'ready' || publishActions.status === 'error',
        failed: publishActions.status === 'error',
        lockedReason: publishLock,
    }), [publishActions.status, publishLock]);
    const publishReadRef = useRef(publishRead);
    publishReadRef.current = publishRead;
    const canDeleteRef = useRef(false);
    canDeleteRef.current = auth.has('products.delete');
    const repaintPublishCells = useCallback((rowIds?: Iterable<string>) => {
        const api = getGridApi();
        if (!api || api.isDestroyed())
            return;
        const nodes = rowIds ? [...new Set(rowIds)].flatMap((id) => { const node = api.getRowNode(id); return node ? [node] : []; }) : undefined;
        api.refreshCells({ ...(nodes ? { rowNodes: nodes } : {}), columns: [STATUS_COLUMN, ACTION_COLUMN], force: true });
    }, [getGridApi]);
    /** A sheet row's publish cell of one column: where it is, its stored value and the SKU it holds or sends here. */
    const publishPlaceOf = useCallback((column: PublishActionChange['column'], row: ChannelSheetRow): PublishCellPlace => ({
        rowId: row.rowId, colId: sheetPublishColumnOf(column), column, cell: publishCellOf(row), sku: listingSkuLabel(row),
    }), [publishCellOf]);
    /* The editing is the shared one (`usePublishCellEditing`): the Matrix's Status columns are edited by the same code. */
    const publishEditing = usePublishCellEditing({
        write: (change, listingIds) => publishActionsRef.current.write(change, listingIds),
        places: () => {
            // Every row's cell id — a listing id, or a new row's `new:` id — to the sheet row.
            const rowIdOfListing = new Map(rowsRef.current.flatMap((row) => { const id = publishCellOf(row)?.listingId ?? row.listing?.id; return id ? [[id, row.rowId] as const] : []; }));
            return {
                place: (listingId, column) => { const rowId = rowIdOfListing.get(listingId); return rowId ? { rowId, colId: sheetPublishColumnOf(column) } : null; },
                label: (listingId) => { const row = rowsRef.current.find((r) => r.rowId === rowIdOfListing.get(listingId)); return row ? listingSkuLabel(row) : null; },
            };
        },
        read: () => publishReadRef.current,
        repaint: repaintPublishCells,
        toast: (message, tone, options) => toastRef.current(message, tone, options),
        // New listings: a choice started the family's drafts — the sheet reads its rows again, quietly (their listing ids).
        onStarted: () => { void refreshRef.current(() => !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0); },
    });
    const publishTracker = publishEditing.tracker;
    const { stage: stagePlace, fill: fillPlaces, onClearKey: clearPublishCells, begin: beginPublishOperation, end: endPublishOperation } = publishEditing;
    /** A cell received a value: a refusal is marked at once; a change waits in the fence for the rest of its operation. */
    const stagePublishCell = useCallback((column: PublishActionChange['column'], row: ChannelSheetRow, received: PublishCellInput) => {
        stagePlace(publishPlaceOf(column, row), received);
    }, [stagePlace, publishPlaceOf]);
    /** Fill the ticked rows' cells of one column (Action ▾): one operation, so one write and one toast. */
    const fillPublishCells = useCallback((change: PublishActionChange, targets: readonly ChannelSheetRow[]) => {
        fillPlaces(change, targets.map((row) => publishPlaceOf(change.column, row)));
    }, [fillPlaces, publishPlaceOf]);
    /** Delete / Backspace on a Status or Action cell: the selected cells of those columns go back to "no change" / Partial update. */
    const onPublishCellKey = useCallback((event: { event?: Event | null; column?: { getColId(): string } | null }): boolean => clearPublishCells<ChannelSheetRow>(event, getGridApi() ?? null, rowIdOf,
        (colId) => colId === STATUS_COLUMN || colId === ACTION_COLUMN,
        (target) => target.colId === STATUS_COLUMN ? publishPlaceOf('status', target.row) : target.colId === ACTION_COLUMN ? publishPlaceOf('send', target.row) : null), [clearPublishCells, getGridApi, publishPlaceOf]);
    /* A new read (or a permission answer) repaints only the cells whose value changed (`equals`). */
    useEffect(() => { getGridApi()?.refreshCells({ columns: [STATUS_COLUMN, ACTION_COLUMN] }); }, [publishActions.version, publishRead, getGridApi]);
    /* The inactive row-start mark: AG applies row classes when it draws a row, so a row whose state changed is redrawn. */
    const rowClassRules = useMemo(() => ({ [SELLING_ROW_MARK_CLASS]: (p: { data?: ChannelSheetRow }) => !!p.data && rowCarriesInactiveMark([publishCellOf(p.data)?.state]),
        [UNSAVED_ROW_CLASS]: (p: { data?: ChannelSheetRow }) => isUnsavedRowData(p.data) }), [publishCellOf]);
    const inactiveRowIds = useRef(new Set<string>());
    useEffect(() => {
        const next = new Set(rows.filter((row) => isInactiveCell(publishCellOf(row))).map((row) => row.rowId));
        const changed = [...next].filter((id) => !inactiveRowIds.current.has(id)).concat([...inactiveRowIds.current].filter((id) => !next.has(id)));
        inactiveRowIds.current = next;
        const api = getGridApi();
        if (!api || api.isDestroyed() || !changed.length)
            return;
        const nodes = changed.flatMap((id) => { const node = api.getRowNode(id); return node ? [node] : []; });
        if (nodes.length) api.redrawRows({ rowNodes: nodes });
    }, [rows, publishActions.version, publishCellOf, getGridApi, gridReady]);
    /* The toolbar: "4 waiting for Publish" and "3 inactive", each a filter; the ⋯ menu offers both and "Clear …". */
    const [publishFilter, setPublishFilter] = useState<'waiting' | 'inactive' | null>(null);
    const publishCounts = useMemo(() => {
        const withChildren = new Set(rows.filter((row) => row.rowKind === 'variant').map((row) => aliasKeyOf(row.aliasId)));
        const cells = rows.map((row) => publishCellOf(row));
        return {
            waiting: waitingCountsOf(cells),
            waitingRows: rows.filter((row) => isWaitingCell(publishCellOf(row))).length,
            // A main row with variations shows their state ("Mixed"): count the listings that sell, not it.
            inactive: rows.filter((row) => isInactiveCell(publishCellOf(row)) && (row.rowKind === 'variant' || !withChildren.has(aliasKeyOf(row.aliasId)))).length,
        };
    }, [rows, publishActions.version, publishCellOf]);
    useEffect(() => {
        if ((publishFilter === 'waiting' && !publishCounts.waitingRows) || (publishFilter === 'inactive' && !publishCounts.inactive))
            setPublishFilter(null);
    }, [publishFilter, publishCounts]);
    const destinationWords = publishDestinationLabel(channel, marketplace);
    const togglePublishFilter = useCallback((which: 'waiting' | 'inactive') => setPublishFilter((current) => (current === which ? null : which)), []);
    const waitingMarkStatus = useMemo(() => waitingStatusMark(publishCounts.waiting, publishFilter === 'waiting', () => togglePublishFilter('waiting')), [publishCounts.waiting, publishFilter, togglePublishFilter]);
    const inactiveMarkStatus = useMemo(() => inactiveStatusMark(publishCounts.inactive, destinationWords, publishFilter === 'inactive', () => togglePublishFilter('inactive')), [publishCounts.inactive, destinationWords, publishFilter, togglePublishFilter]);
    const waitingTotal = waitingTotalOf(publishCounts.waiting);
    /** ⋯ "Clear N waiting values on <market>": every waiting value of this sheet back to the default, with Undo. */
    const clearWaitingValues = useCallback(async () => {
        const cells = rowsRef.current.map((row) => publishCellOf(row)).filter((cell): cell is NonNullable<typeof cell> => !!cell);
        // A row not on the channel has no Action value of its own (it reads Full update); its Status choice clears below
        // (a deleted row chosen to be listed again goes back to Not listed; Undo chooses it again).
        const sends = cells.filter((cell) => !cell.create && cell.send.mode !== 'partial' && !cell.send.noLongerApplies);
        const statuses = cells.filter((cell) => !!cell.status.target && !cell.status.noLongerApplies);
        if (!sends.length && !statuses.length)
            return;
        const outcomes = await Promise.all([
            ...(sends.length ? [publishActionsRef.current.write({ column: 'send', mode: 'partial' }, sends.map((cell) => cell.listingId))] : []),
            ...(statuses.length ? [publishActionsRef.current.write({ column: 'status', target: null }, statuses.map((cell) => cell.listingId))] : []),
        ]);
        const failed = outcomes.find((outcome) => !outcome.ok);
        const cleared = outcomes.reduce((n, outcome) => n + outcome.applied.length, 0);
        if (failed && !cleared) {
            toastRef.current(`Nothing was cleared: ${failed.error ?? 'the request failed.'}`, 'danger', { duration: 10000 });
            return;
        }
        const appliedIds = new Set(outcomes.flatMap((outcome) => outcome.applied.map((id) => `${outcome.change.column}|${id}`)));
        // Undo puts back what was cleared (each value again as yours, now).
        const undoWrites = new Map<string, { change: PublishActionChange; ids: string[] }>();
        for (const cell of sends) if (appliedIds.has(`send|${cell.listingId}`)) {
            const change: PublishActionChange = { column: 'send', mode: cell.send.mode };
            const k = JSON.stringify(change);
            undoWrites.set(k, { change, ids: [...(undoWrites.get(k)?.ids ?? []), cell.listingId] });
        }
        for (const cell of statuses) if (appliedIds.has(`status|${cell.listingId}`)) {
            const change: PublishActionChange = { column: 'status', target: cell.status.target };
            const k = JSON.stringify(change);
            undoWrites.set(k, { change, ids: [...(undoWrites.get(k)?.ids ?? []), cell.listingId] });
        }
        const putBack = async () => {
            const back = await Promise.all([...undoWrites.values()].map(({ change, ids }) => publishActionsRef.current.write(change, ids)));
            const summary = operationToast(back, []);
            if (summary) toastRef.current(summary.message, summary.tone, { duration: 8000 });
        };
        const kept = failed ? ` Some could not be cleared: ${failed.error ?? 'the request failed.'}` : '';
        toastRef.current(<>{`Cleared ${cleared.toLocaleString('en')} waiting ${cleared === 1 ? 'value' : 'values'} on ${destinationWords}.${kept}`} <Button variant="link" size="sm" onClick={() => void putBack()}>Undo</Button></>, failed ? 'warning' : 'success', { duration: 10000 });
    }, [publishCellOf, destinationWords]);
    const publishOverflow = useMemo<MenuItemDef[]>(() => [
        ...(publishCounts.waitingRows ? [{ id: 'show-waiting', label: publishFilter === 'waiting' ? 'Show all rows' : `Show the ${publishCounts.waitingRows === 1 ? 'row' : `${publishCounts.waitingRows} rows`} waiting for Publish`, description: 'Rows with a Status or Action that Publish will send', onSelect: () => togglePublishFilter('waiting') }] : []),
        ...(publishCounts.inactive ? [{ id: 'show-inactive', label: publishFilter === 'inactive' ? 'Show all rows' : `Show the ${publishCounts.inactive === 1 ? 'inactive row' : `${publishCounts.inactive} inactive rows`}`, description: `Listings that do not sell on ${destinationWords} now`, onSelect: () => togglePublishFilter('inactive') }] : []),
        { id: 'clear-waiting', label: waitingTotal ? `Clear ${waitingTotal.toLocaleString('en')} waiting ${waitingTotal === 1 ? 'value' : 'values'} on ${destinationWords}` : `Clear waiting values on ${destinationWords}`,
            description: waitingTotal ? `Status back to no change, Action back to Partial update${publishCounts.waiting.relist ? ' (a deleted row back to Not listed)' : ''}. Undo puts them back.` : 'Nothing waits for Publish on this sheet.',
            disabled: !waitingTotal || !!publishLock, onSelect: () => void clearWaitingValues() },
    ], [publishCounts, publishFilter, togglePublishFilter, destinationWords, waitingTotal, publishLock, clearWaitingValues]);
    /* Action ▾ counts what each item would do to the ticked rows. */
    const actionEntries = useMemo(() => actionMenuEntries(selected.map((row) => ({ sku: row.sku, cell: publishCellOf(row) })),
        { publish: !publishLock && auth.status !== 'loading', delete: auth.has('products.delete') }), [selected, publishCellOf, publishActions.version, publishLock, auth]);
    /* The grid's operation events open and close the Status and Action fence too (after the sheet's own fence). */
    const publishFenceProps = useMemo(() => {
        const g = undo.gridProps;
        const begin = beginPublishOperation;
        const end = endPublishOperation;
        return {
            onFillStart: () => { g.onFillStart(); begin(); }, onFillEnd: () => { g.onFillEnd(); end(); },
            onPasteStart: () => { g.onPasteStart(); begin(); }, onPasteEnd: () => { g.onPasteEnd(); end(); },
            onCellSelectionDeleteStart: () => { g.onCellSelectionDeleteStart(); begin(); }, onCellSelectionDeleteEnd: () => { g.onCellSelectionDeleteEnd(); end(); },
        };
    }, [undo.gridProps, beginPublishOperation, endPublishOperation]);
    const fieldsBanner = useMissingFieldsBanner({ channel, market: marketplace, missing: data?.meta.schemaMissing ?? [], ready: !!data && !loading && auth.status !== 'loading',
        canLoad: auth.has(LOAD_FIELDS_PERMISSION), onLoaded: reload });
    /* Delete rows (Owner 2026-10-06) — the same "Delete…" as the Shared view: a Main listing row deletes the product
       everywhere (to the recycle bin), an extra listing's main row removes that listing only. The selection bar and every
       row menu offer it. An archived listing shown alone leaves the page on every listing again. */
    const deleteRows = useDeleteRows<ChannelSheetRow>({ productId, target: (row) => ({ productId: row.id, aliasId: row.aliasId }), onChanged: () => {
        clearSelection(); reload(); refreshReadiness(); invalidatePublishActions(productId); if (selectedAlias !== null) setListing(undefined);
    } });
    const deleteVerbs = useMemo(() => [deleteRows], [deleteRows]);
    const verbs = useMemo(() => data
        ? [...channelActions({
            accountSpecific: alternateAccount,
            channelConnectionId: data.scope.connectionId,
            channel,
            marketplace,
            scopeLabel: data.scope.label,
            aliases: data.aliases,
            permission,
            siblingMarkets: [],
            pickMarkets: async () => null,
            openRecord: (rowId: string) => record.open(rowId, lastDataCell.current ?? undefined),
            openRecordId: record.rowId,
        }), deleteRows]
        : [], [data, channel, marketplace, permission, record.open, record.rowId, alternateAccount, deleteRows]);
    const { press, problem, clearProblem, confirmElement } = useActionPress<ChannelSheetRow>();
    const isRecordRow = useCallback((r: ChannelSheetRow) => r.rowKind === 'variant', []);
    const menuItems = useMemo(() => actionMenuItems<ChannelSheetRow>({ actions: verbs, onSelect: press, isRecord: isRecordRow }), [verbs, press, isRecordRow]);
    /* Aliases (Owner 2026-10-05) — a listing band's own verbs: show this listing alone (or every listing again) and
       publish only this listing, in the studio's own Publish window. The band's ⋯ and its right-click offer them. */
    const studioProduct = useStudioProduct();
    const [publishListingScope, setPublishListingScope] = useState<StudioPublishScope | null>(null);
    const publishAccount = data?.scope.connectionId ?? accountId ?? null;
    const bandVerbs = useMemo(() => [...listingBandActions({
        listingCount: loadedData?.aliases.length ?? 0,
        shownAliasKey: selectedAlias,
        // The `listing=` that shows one listing alone: the alias id, or THIS page's product's own main record — a
        // variation's page stays on the variation (review 2026-10-05).
        selectionOf: (aliasId) => pageListingSelection(aliasId, loadedData?.rows ?? [], studioProduct.id),
        setListing,
        publishListing: (aliasId) => { if (publishAccount) setPublishListingScope(listingPublishScope({ channel, marketplace, accountId: publishAccount }, aliasId)); },
        publishRefusal: studioProduct.deletedAt ? 'This product is deleted, so it cannot be published.'
            : !publishAccount ? 'Choose an account for this market first.' : null,
    }), deleteRows], [loadedData?.aliases.length, loadedData?.rows, selectedAlias, setListing, publishAccount, channel, marketplace, studioProduct.deletedAt, studioProduct.id, deleteRows]);
    // A listing band the sheet read — never an empty "new listing" row that has no listing yet.
    const isBandRow = useCallback((r: ChannelSheetRow) => r.rowKind === 'parent' && !isUnsavedRowData(r), []);
    const bandMenuItems = useMemo(() => actionMenuItems<ChannelSheetRow>({ actions: bandVerbs, onSelect: press, isRecord: isBandRow }), [bandVerbs, press, isBandRow]);
    const contextMenu = useMemo(() => {
        const actions = actionContextMenu<ChannelSheetRow>({ actions: verbs, onSelect: press, isRecord: isRecordRow });
        const bandActions = actionContextMenu<ChannelSheetRow>({ actions: bandVerbs, onSelect: press, isRecord: isBandRow });
        return (params: GetContextMenuItemsParams<ChannelSheetRow>) => {
            const items = params.node?.data && isBandRow(params.node.data) ? bandActions(params) : actions(params);
            const row = params.node?.data;
            const column = data?.columns.find(c => c.key === params.column?.getColId());
            if (row && column)
                items.unshift(...control.cellMenuItems(params));
            const mapping = data && column?.channels?.[data.scope.label];
            const field = mapping?.key ?? mapping?.attribute;
            if (!row || !field)
                return items;
            const supplyingRule = column && row.values[column.key]?.mapped?.supplyingRule;
            return [{ name: 'Open reusable mapping for this field', tooltip: 'This rule can affect other matching products. Opens separately to preserve your edits.',
                    action: () => window.open(supplyingRule?.href ?? mappingHref({ channel, market: marketplace, category: row.productType, field, productId: row.id }), '_blank', 'noopener') }, ...items];
        };
    }, [verbs, bandVerbs, press, isRecordRow, isBandRow, data, channel, marketplace, control.cellMenuItems]);
    const productLevelOnly = data?.meta?.mapping?.productLevelOnly ?? false;
    const familyShowsAxes = useMemo(() => {
        const variants = rows.filter((r) => r.rowKind === 'variant');
        return variants.length > 0 && variants.every((r) => Object.keys(r.axisValues ?? {}).length > 0);
    }, [rows]);
    const viewCtxNow = useMemo(() => ({
        variationAxes: data?.family?.variationAxes ?? [],
        locale: data?.scope.locale ?? locale ?? '',
        scopeLabel: data?.scope.label,
        flaggedKeys: flaggedColumnKeys(rows),
        requiredKeys: [...new Set(rows.flatMap(row => Object.entries(row.values).filter(([, cell]) => cell.mapped?.requiredByRule).map(([key]) => key)))],
    }), [data, rows, locale]);
    /* P2 (I4-4) — the column model is keyed on what it reads, never on a read's object identity: the same columns, scope
       and view facts keep every column definition, so AG never rebuilds (and re-renders) every cell after a read. */
    const viewCtx = useMemo(() => viewCtxNow, [JSON.stringify(viewCtxNow)]);
    const columnsKey = useMemo(() => JSON.stringify(data?.columns ?? []), [data?.columns]);
    const stableColumns = useMemo(() => data?.columns ?? [], [columnsKey]);
    const scopePage = useMemo(() => (data ? { scope: data.scope } : null), [JSON.stringify(data?.scope ?? null)]);
    /* The alias label for the marks' sentences, read at paint time: a renamed alias must not rebuild every column. */
    const aliasLabelOf = useCallback((aliasId: string | null) => dataRef.current?.aliases.find((a) => aliasKeyOf(a.id) === aliasKeyOf(aliasId))?.label ?? null, []);
    const authRef = useRef(auth);
    authRef.current = auth;
    const authKey = `${auth.status}:${auth.isOwner}:${[...auth.permissions].sort().join(',')}`;
    const authLive = useMemo(() => ({ has: (permission: string) => authRef.current.has(permission) }), [authKey]);
    /* Shopify undo (lane01, Owner decision (a)): a step whose earlier state was a saved pin under a following sharing rule
       is refused, not approximated. One message per undo, naming each earlier value for review. */
    const historyRefusals = useRef<Array<{ where: string; earlier: string }>>([]);
    const shopifyHistoryRefused = useCallback<ShopifyHistoryRefused>((row, column, earlier) => {
        historyRefusals.current.push({ where: `${column.label} on ${row.sku}`, earlier });
        if (historyRefusals.current.length > 1) return;
        setTimeout(() => {
            const refused = historyRefusals.current.splice(0);
            toastRef.current(refused.length === 1 ? shopifyHistoryRefusal(refused[0].where, refused[0].earlier)
                : `Undo did not change ${refused.length} Shopify cells: before that edit each kept a saved Nexus draft while its sharing rule still copied the shared source, which undo cannot recreate exactly. Nothing was saved for them. Review the earlier values: ${refused.map(r => `${r.where}: ${r.earlier}`).join('; ')}.`, 'danger');
        }, 0);
    }, []);
    const shopifyEditor = useShopifyDraftCell(shopifySchema, getGridApi, shopifyHistoryRefused);
    /* Owner 2026-10-05 — the pop-up names the row's listing as its band does (★ Main listing, ① ALT1). */
    const mediaListingOf = useCallback((row: { aliasId?: string | null; aliasPosition?: number }) => mediaListingName(row.aliasPosition ?? 0, aliasLabelOf(row.aliasId ?? null), dataRef.current?.aliases.length ?? 1), [aliasLabelOf]);
    const mediaEditor = useProductMediaEditor(() => { void refresh(() => !tracker.hasUnconfirmedChanges && (getGridApi()?.getEditingCells().length ?? 0) === 0); }, data?.scope.locale ?? locale, mediaListingOf);
    const mediaClipboard = useMemo(() => mediaGridTransfer(formulaClipboard, mediaEditor.actions), [formulaClipboard, mediaEditor.actions]);
    /* Step 4.3 #3 (A-52, R-56) — the one bullets cell joins the grid's columns (the media column's pattern): built, in
       Customise, in the views; never a server column, never a write field. */
    /* 2026-10-01 — the media column joins the sheet's groups (Images, on eBay and Amazon) and every column carries its
       group's colour (`../sheetGroups`). */
    const gridColumns = useMemo(() => withSheetGroups(withSlotListColumns(withProductMediaColumn(stableColumns).filter((col) => !RESERVED_COLUMN_IDS.includes(col.key as never)))), [stableColumns]);
    const headerPaste = useHeaderPaste<ChannelSheetRow>(gridColumns.map(column => ({ colId: column.key, headerName: column.label })), (message, tone) => toast(message, tone));
    // Add rows — a paste on an empty row's SKU fills the empty rows; any other paste is the header-aware one.
    const pasteIntoNewRows = useMemo(() => newRowsPaste(newRows.store, headerPaste.processDataFromClipboard), [newRows.store, headerPaste.processDataFromClipboard]);
    // Add rows — an empty row's cell menu holds only "Remove this row".
    const menuWithNewRows = useMemo(() => newRowsContextMenu(newRows.store, contextMenu), [newRows.store, contextMenu]);
    const columnDefs = useMemo(() => control.decorate(buildSheetColumns('channel', {
        data: scopePage, gridColumns, formulaWiring, accountId, productLevelOnly, aliasLabelOf,
        refusedReasonFor, tracker, activeCellsRef, viewCtx, mediaEditor, shopifyEditor, shopifySchema, auth: authLive,
    })), [scopePage, gridColumns, formulaWiring, accountId, aliasLabelOf, productLevelOnly, refusedReasonFor,
        tracker, viewCtx, mediaEditor.open, mediaEditor.actions, shopifyEditor.open, shopifySchema, authLive, control.decorate]);
    /**
     * The scope's PROGRESS COLUMN (2026-09-26) — the bar left the Product cell. The same builder as master
     * (`../progressColumns`), fed by this sheet's own rows: `completeness` is measured against THIS channel's fields.
     */
    const progressColumns = useMemo<ColDef<ChannelSheetRow>[]>(() => {
        const data = scopePage;
        if (!data) return [];
        const label = data.scope.label;
        const presence = (field: string): ColumnPresence => {
            const col = getGridApi()?.getColumn(field);
            return !col ? 'absent' : col.isVisible() ? 'visible' : 'hidden';
        };
        return [progressColumn<ChannelSheetRow>({
            colId: SCOPE_PROGRESS_COLUMN,
            headerName: label,
            headerTooltip: `Progress on ${label}: filled ÷ every field ${label} applies here, required and optional. Red — a required field is empty. Yellow — only optional fields are empty. Green — nothing is empty. Grey — this listing cannot be scored yet. Hover or click a bar to see what is missing. Completeness, not publish readiness.`,
            value: (row) => rowProgressValue(row, rowProgressUnscorable(row, dataRef.current?.aliases.find(alias => aliasKeyOf(alias.id) === aliasKeyOf(row.aliasId)))),
            menu: () => [refreshProgressItem(refreshProgress, progressReadAtRef.current)],
            cell: {
                scopeLabel: label,
                subjectOf: (p) => (p.data as ChannelSheetRow | undefined)?.sku ?? null,
                actionFor: (field, fieldLabel) => sheetFieldAction(presence(field), fieldLabel, 'Not a column on this sheet'),
                onGoTo: (field, p) => {
                    const row = p.data as ChannelSheetRow | undefined;
                    const api = getGridApi();
                    if (row && api) landOnCell(api, { rowId: rowIdOf(row), colId: field, reveal: (colId) => revealCell(colId, 'reveal'), root: document.querySelector('.nds-grid-sheet') ?? undefined });
                },
                footerLink: () => ({ label: `All products for ${label}`, href: listingsHref({ channel: data.scope.channel, market: marketplace, language: data.scope.locale }) }),
            },
        })];
    }, [scopePage, marketplace, getGridApi, revealCell, refreshProgress]);
    /** The card's "See publish history" (P8): the studio's Activity tab on that publish — a shallow address change. */
    const canChangeEditor = languageScope.canChangeEditor;
    const openPublishHistory = useCallback((runId: string, sku: string | null) => {
        if (canChangeEditor && !canChangeEditor())
            return;
        const url = new URL(window.location.href);
        // A fresh state object: Next's patched pushState then moves `useSearchParams` (see contracts.tsx `flushUrl`).
        window.history.pushState({}, '', `${url.pathname}${publishHistorySearch(url.search, runId, sku)}${url.hash}`);
    }, [canChangeEditor]);
    /** Step 3 — the "Last publish" column, right after progress. Channel scopes only (this adapter); master has none. */
    const publishColumns = useMemo<ColDef<ChannelSheetRow>[]>(() => scopePage ? [publishColumn<ChannelSheetRow>({
        value: (row) => publishValueRef.current(row),
        cell: {
            onGoToField: (columnKey, p) => {
                const row = p.data as ChannelSheetRow | undefined;
                const api = getGridApi();
                if (row && api) landOnCell(api, { rowId: rowIdOf(row), colId: columnKey, reveal: (colId) => revealCell(colId, 'reveal'), root: document.querySelector('.nds-grid-sheet') ?? undefined });
            },
            // "See publish history": the Activity tab on that publish, the row's SKU expanded (P8).
            onOpenHistory: (publicationId, p) => openPublishHistory(publicationId, (p.data as ChannelSheetRow | undefined)?.sku ?? null),
        },
    })] : [], [scopePage, getGridApi, revealCell, openPublishHistory]);
    useEffect(() => { getGridApi()?.refreshCells({ columns: [PUBLISH_COLUMN] }); }, [publication.read, listingPublications, publishLookup, getGridApi]);
    // "Show in sheet" from Publish history lands on the FIELD the channel named (the request names the row and fields).
    useEffect(() => {
        if (!gridReady || !rows.length)
            return;
        const request = takeSheetLanding({ channel, marketplace });
        const api = getGridApi();
        if (!request || !api || !rows.some(row => rowIdOf(row) === request.rowId))
            return;
        const column = request.fieldNames.map(name => publishLookup(name)).find(ref => !!ref);
        if (column)
            landOnCell(api, { rowId: request.rowId, colId: column.key, reveal: (colId) => revealCell(colId, 'reveal'), root: document.querySelector('.nds-grid-sheet') ?? undefined });
    }, [gridReady, rows, channel, marketplace, getGridApi, publishLookup, revealCell]);
    /** Build shape v2, P8 — Status and Action, right after "Last publish". Their values are read through refs. */
    const statusActionColumns = useMemo<ColDef<ChannelSheetRow>[]>(() => {
        if (!scopePage) return [];
        const shared = { cell: publishCellOf, read: () => publishReadRef.current, canDelete: () => canDeleteRef.current, tracker: publishTracker, rowIdOf };
        return [
            statusColumn<ChannelSheetRow>({ ...shared, onInput: (row, input) => stagePublishCell('status', row, input) }),
            actionColumn<ChannelSheetRow>({ ...shared, onInput: (row, input) => stagePublishCell('send', row, input) }),
        ];
    }, [scopePage, publishCellOf, publishTracker, stagePublishCell]);
    // Add rows — on an empty row every cell but the SKU is locked and blank (`lockedOnNewRows`).
    const allColumnDefs = useMemo(() => lockedOnNewRows([...progressColumns, ...publishColumns, ...statusActionColumns, ...columnDefs]), [progressColumns, publishColumns, statusActionColumns, columnDefs]);
    const searchColumnLabels = useMemo(() => new Map(gridColumns.map(col => [col.key, col.optionLabels])), [gridColumns]);
    const searchTerm = search.trim().toLowerCase();
    const matchesSearch = useCallback((r: ChannelSheetRow) => {
        if (!searchTerm)
            return true;
        if (`${r.sku ?? ''} ${r.name ?? ''}`.toLowerCase().includes(searchTerm))
            return true;
        return Object.entries(r.values ?? {}).some(([key, c]) => referenceSearchText(c?.value, searchColumnLabels.get(key)).includes(searchTerm));
    }, [searchTerm, searchColumnLabels]);
    const scopeRows = useMemo(() => {
        const afterRefused = showRefusedOnly && refusedRowIds.size ? filterProductSheetRows(rows, row => refusedRowIds.has(productSheetRowKey(row))) : rows;
        // Step 3 — the channel's rejections in the latest publish (the toolbar mark's filter), not the save refusals above.
        const afterRejected = showRejectedOnly && rejectedCount ? filterProductSheetRows(afterRefused, row => isRejectedRow(row, rowPublicationStatus(row))) : afterRefused;
        const afterWaiting = offerDrafts.filterOn ? filterProductSheetRows(afterRejected, offerDrafts.keep) : afterRejected;
        // P8 — the waiting mark's and the inactive chip's filters.
        const afterPublish = publishFilter === 'waiting' ? filterProductSheetRows(afterWaiting, row => isWaitingCell(publishCellOf(row)))
            : publishFilter === 'inactive' ? filterProductSheetRows(afterWaiting, row => isInactiveCell(publishCellOf(row)))
                : afterWaiting;
        return searchTerm ? filterProductSheetRows(afterPublish, matchesSearch) : afterPublish;
    }, [rows, searchTerm, matchesSearch, showRefusedOnly, refusedRowIds, showRejectedOnly, rejectedCount, rowPublicationStatus, offerDrafts, publishFilter, publishCellOf, publishActions.version]);
    useLanguageChips(data && !orderPending ? scopeRows : null, gridColumns);
    useSheetChips(data && !orderPending ? scopeRows : null, gridColumns, { scope: 'channel', mapping: true, warningsId: 'channel-warnings', mappingRun: data?.meta.mapping ?? null });
    const { activeId, active, setActive } = useViewChips();
    const visibleRows = useMemo(() => active ? filterProductSheetRows(scopeRows, row => (active.cells.byRow[productSheetRowKey(row)]?.length ?? 0) > 0) : scopeRows, [scopeRows, active]);
    /* Add rows — the empty rows after the rows on screen: a variation under the listing shown, a listing as a band of its own. */
    const gridRows = useMemo(() => withNewRows<ChannelSheetRow>(visibleRows, newRows.rows, (row) => channelNewRow(row, data?.family.id ?? productId, selectedAlias || null)), [visibleRows, newRows.rows, data?.family.id, productId, selectedAlias]);
    activeCellsRef.current = (active?.cells as {
        byRow: Record<string, string[]>;
    } | undefined) ?? null;
    useEffect(() => {
        getGridApi()?.refreshCells({ force: true });
    }, [activeId]);
    const crossChannelCols = useMemo(() => crossChannelColumnCount(rows.find((r) => r.rowKind === 'variant')), [rows]);
    /* Progress column (2026-09-26) — a member of the column model (Customise, views, locks), built above by the shared
       builder; the channel builder never sees it. */
    const modelColumns = useMemo(() => data ? withSheetGroups([progressSheetColumn<typeof gridColumns[number]>(SCOPE_PROGRESS_COLUMN, data.scope.label, `Progress on ${data.scope.label}: filled ÷ every field it applies here, required and optional.`), publishSheetColumn<typeof gridColumns[number]>(), statusSheetColumn<typeof gridColumns[number]>(), actionSheetColumn<typeof gridColumns[number]>(), ...gridColumns]) : gridColumns, [data, gridColumns]);
    const schemaColumns = useMemo(() => modelColumns as never as StudioSheetColumn[], [modelColumns]);
    const prefsBridge = useMemo<PrefsBridgeOptions>(() => ({
        columns: [{ key: '__identity', locked: true }, ...modelColumns.map((c) => ({ key: c.key }))],
        treeColumnKey: '__identity',
    }), [modelColumns]);
    const sheetColumns = useSheetColumns<ChannelSheetRow, null>({
        apiRef,
        gridReady,
        columns: schemaColumns,
        viewCtx,
        identityColumn: '__identity',
        prefsBridge,
        activeChip: active,
        /* TOOLBAR REBUILD (2026-09-27) — one layout and one remembered view per channel, on every market. */
        layoutSurface: `product-edit:layout:${channel.toUpperCase()}`,
        legacyLayoutSurface: `product-edit:layout:${channel.toUpperCase()}:${marketplace.toUpperCase()}`,
        productType: data ? data.family?.productType ?? null : undefined,
        grid: {
            surface: surfaceKey,
            viewsSurface: `product-edit:views:${channel.toUpperCase()}`,
            baseUrl: getBackendUrl(),
            getPageState: () => null,
            applyPageState: () => { },
        },
    });
    const { onGridReady, onGridPreDestroyed } = useSheetGridBindings({ apiRef, sheetColumns, bindGridApi, releaseGrid, clearRows: () => setSelected([]) });
    /**
     * LX.13 — the same ONE builder the master host uses (`sheet/compareTargets.ts`): every language of
     * the field (source first) on the shared record, then the coordinates. The old list was
     * `[Shared, this coordinate]`, so a translator could not see the German beside the Dutch without
     * changing scope — and the `Shared` entry carried no market, which `useCompare` then had to
     * back-fill from the open drawer.
     *
     * The coordinate rows are this scope's own listing today; the full "every coordinate carrying it"
     * list needs the family's listing inventory, which arrives with the per-coordinate readiness
     * columns (LX.15, deferred to VT.2's file).
     */
    editorContextLive.current = (row, key) => data ? {
        history: historyLoaderFor(row, key, { kind: 'channel', channel: data.scope.channel, marketplace, accountId: accountId ?? undefined, aliasId: row.aliasId ?? '', label: data.scope.label, locale: data.scope.locale }),
        inherited: inheritedContextOf(row.values?.[key], from => from === row.id ? null : rows.find(candidate => candidate.id === from)?.sku),
    } : null;
    const compareTargets = useMemo<CompareTarget[]>(() => {
        if (!data || !accountId)
            return [];
        const aliasId = rows.find(row => row.rowId === record.rowId)?.aliasId ?? '';
        return buildCompareTargets({
            scope: { kind: 'channel', channel: data.scope.channel, marketplace, accountId, aliasId, label: data.scope.label, locale: data.scope.locale },
            languages: languageScope.options.locales.map(language => language.code),
            primaryLanguage: languageScope.primaryLanguage,
            coordinates: [{ channel: data.scope.channel, marketplace, accountId, ...(aliasId ? { aliasId } : {}), locale: data.scope.locale ?? locale ?? '' }],
            labels: { channel: channelLabel, language: languageLabel },
            masterLabel: 'Shared',
            masterMarket: marketplace,
        });
    }, [data, marketplace, accountId, rows, record.rowId, languageScope.options.locales, languageScope.primaryLanguage, locale]);
    const onExport = useCallback((mode: SheetExportMode) => {
        const api = getGridApi();
        if (!api || api.isDestroyed() || !data)
            return;
        try {
            const r = exportGridCsv<ChannelSheetRow>(api, `${data.family?.sku ?? 'channel'}-${channel}-${marketplace}-table`, {
                columns: mode === 'all' ? sheetColumns.orderedKeys : 'displayed',
                leading: [
                    { colId: '__sku', header: 'SKU', value: row => row.sku },
                    { colId: '__account', header: 'Account', value: () => accountId ?? 'Primary account' },
                    { colId: '__market', header: 'Marketplace', value: () => marketplace },
                    // The alias's name as the band shows it (Owner 2026-10-05), not its id; the main listing has none.
                    { colId: '__alias', header: 'Listing alias', value: row => (row.aliasId ? aliasName(row.aliasPosition, aliasLabelOf(row.aliasId)) : '') },
                ],
                narrowed: searchTerm.length > 0 || !!activeId,
            });
            setExportNote(`${r.rows} rows · ${r.columns} columns → ${r.fileName} · reference table`);
        }
        catch (e: unknown) {
            setExportNote(e instanceof GridExportRefused ? e.message : 'Could not build the file.');
        }
    }, [data, channel, marketplace, accountId, searchTerm, activeId, sheetColumns, aliasLabelOf]);
    const { preferences, columnDialog, openCustomise, openNewView } = useSheetPreferences({ scope: 'channel', sheetColumns, getGridApi, bandWidthRef, bandDerivedRef, revealCell });
    const getDataPath = useCallback((d: ChannelSheetRow) => dataPathFor(d), []);
    const getRowId = useCallback((p: {
        data: ChannelSheetRow;
    }) => rowIdOf(p.data), []);
    const familyShowsAxesRef = useRef(familyShowsAxes);
    familyShowsAxesRef.current = familyShowsAxes;
    const menuItemsRef = useRef(menuItems);
    menuItemsRef.current = menuItems;
    const bandMenuItemsRef = useRef(bandMenuItems);
    bandMenuItemsRef.current = bandMenuItems;
    useUnpinOnNarrowSheet(getGridApi, gridReady);
    const autoGroupColumnDef = useMemo<ColDef<ChannelSheetRow>>(() => ({
        colSpan: bandSpan,
        cellRenderer: (p: ICellRendererParams<ChannelSheetRow>) => {
            const row = p.data;
            if (!row)
                return null;
            const fresh = unsavedOf(row);
            if (fresh)
                return <NewRowCell row={fresh} expand={fresh.kind === 'alias' ? undefined : <ExpandSlot />} noImage={fresh.kind === 'alias'} onRemove={(id) => newRows.store.remove(id)}/>;
            if (row.rowKind === 'parent') {
                const alias = (dataRef.current?.aliases ?? []).find((a) => aliasKeyOf(a.id) === aliasKeyOf(row.aliasId));
                if (!alias)
                    return null;
                return <AliasBandCell {...p} summary={summariseAlias(rowsRef.current, alias)} aliasCount={(dataRef.current?.aliases ?? []).length} menuItems={[...menuItemsRef.current(row), ...bandMenuItemsRef.current(row)]} skuNode={identityNodeRef.current(row)} titleOf={(own) => identityHoverRef.current(row, own)}/>;
            }
            const axes = familyShowsAxesRef.current ? Object.values(row.axisValues ?? {}).filter(Boolean) : [];
            const axisTitle = Object.entries(row.axisValues ?? {}).map(([axis, value]) => `${axis}: ${value}`).join(' · ');
            return (<IdentityBand expand={<BandExpander node={p.node}/>} role={<ProductRoleChip product={row}/>} image={row.imageUrl} noImage={!row.imageUrl} photoCount={row.imageInherited ? undefined : row.photoCount} imageMark={row.imageInherited ? (<ProvenanceMark provenance="inherited" tooltip="Inherited from the family's picture — this variation has none of its own"/>) : null} sku={row.sku ? identityNodeRef.current(row) : null} secondary={axes.length > 0 ? axes.join(' · ') : null} secondaryTitle={axisTitle || undefined} menuItems={menuItemsRef.current(row)} menuLabel={`Actions for ${row.sku ?? row.rowId}`}/>);
        },
        headerTooltip: 'One group per listing alias; the child SKUs beneath it are shared by every alias',
        headerName: 'Product',
        colId: 'alias',
        pinned: 'left',
        lockPinned: true,
        lockPosition: 'left',
        width: bandWidthRef.current,
        suppressHeaderMenuButton: true,
        cellClass: (p: { data?: ChannelSheetRow }) => (unsavedOf(p.data) ? 'nds-ag-cell nds-cell-full-strength' : 'nds-ag-cell'),
        // S11 — editable: this listing's own SKU (its editor, keys, marks, save marks and refusals).
        ...identitySku.columnDef,
    }), []);
    const shopifyClipboard = useMemo(() => shopifyGridTransfer(mediaClipboard, data?.columns ?? [], accountId ?? '', message => toast(message, 'info')), [mediaClipboard, data?.columns, accountId, toast]);
    const [preflightAlias, setPreflightAlias] = useState<PreflightAlias | null>(null);
    const [reviewBusy, setReviewBusy] = useState(false);
    const nativeReviewRow = preflightAlias ? rows.find(row => row.aliasId === preflightAlias.id && row.shopify) : null;
    const reviewPath = nativeReviewRow?.shopify && accountId ? `/api/products/${encodeURIComponent(nativeReviewRow.shopify.productId)}/shopify-linked?${new URLSearchParams({ accountId, listingId: nativeReviewRow.shopify.listingId, market: 'GLOBAL', ...(locale ? { locale } : {}) })}` : null;
    const overflowItems = useMemo<MenuItemDef[]>(() => {
        const items: MenuItemDef[] = (data?.aliases ?? []).map((a) => {
            const synchronize = !!accountId && rows.some(row => row.aliasId === a.id && row.shopify);
            const n = reviewRowsOf(rows, a.id, synchronize).length;
            const mark = aliasMark(a.position);
            const copy = reviewCopy(synchronize ? 'synchronize' : 'check');
            if (n === 0)
                return { id: `preflight:${a.id}`, label: `${copy.menu} ${mark}`, disabled: true, description: `${mark} has no applicable rows to check` };
            return {
                id: `preflight:${a.id}`,
                label: `${copy.menu} ${mark} (${n})`,
                disabled: refused > 0,
                description: copy.subtitle,
                onSelect: () => setPreflightAlias(a),
            };
        });
        // Add rows (R3, 2026-10-05) — a new listing (alias) is added from the footer's "Add rows ▾ → Listing (alias)", with
        // its SKU; the ⋯ item that made a SKU-less one is gone (one way in).
        items.unshift(control.cellDetails.overflowItem);
        return items;
    }, [data, rows, alternateAccount, channel, refused, control.cellDetails.overflowItem]);
    const unavailable = !loading && (backendMissing || !!error || !data);
    const emptyState = sheetEmptyState(rows.length, () => {
        setSearch('');
        setActive(null);
        setShowRefusedOnly(false);
        getGridApi()?.setFilterModel(null);
    }, reload);
    const unlisted = !!data?.aliases.length && data.aliases.every((a) => a.readiness?.state === 'unlisted');
    /* Create path, step 6 — what the family holds here, from the rows' own listings (and the drafts a save just
       started, `listingEpoch`). `none` on the primary listing: the first edit starts the draft, and the header says so —
       or, with no account to start it under, says the API's own refusal. `draft`: every listing here is still a Nexus
       draft by the shared rule (`isStillDraftListing`), and the chip says it is not published. */
    const listingState = useMemo(() => (data ? coordinateListingState(rows) : null), [data, rows, listingEpoch]);
    const asinPending = useMemo(() => (data ? asinPendingCount(rows, channel) : 0), [data, rows, channel]);
    const startsDraftHere = listingState === 'none' && rows.some((row) => row.aliasId == null);
    const noAccount = !accountId && !data?.scope.connectionId && accounts.length === 0;
    return {
        scope: 'channel',
        loading: loading, switching, unavailable: unavailable,
        errorLabel: `${channelLabel(channel)} · ${marketplace} information`,
        errorMessage: error,
        backendMissing: backendMissing, retry: reload,
        columns: sheetColumns,
        saveStatus,
        toolbar: {
            visible: visibleRows.length,
            total: rows.length,
            selected: selected.length,
            /* P8 — while rows are ticked: Action ▾ fills their Status or Action (it replaces "Mark paused / active").
               Broadcast and Open record stay where they were: the row menus and the drawer. */
            selectionActions: <FamilySelectionVerbs rows={selected} actions={deleteVerbs}>
                <PublishActionMenu entries={actionEntries} selected={selected.length} onChoose={(change) => fillPublishCells(change, selected)} disabled={publishActions.status !== 'ready'}/>
            </FamilySelectionVerbs>,
            onClearSelection: clearSelection,
            /* With no listing here, the alias count ("1 listing") counted the primary GROUP, not a listing — so it is left
               out, and the notice above the grid says what the first edit does. */
            descriptor: data && <span className="nds-cell-muted">
              {' · '}
              {listingState === 'none' || unlisted ? `${readinessMeta('unlisted', 'row').label} · ` : ''}
              {listingState === 'none' ? '' : `${data.aliases.length} ${data.aliases.length === 1 ? 'listing' : 'listings'} · `}
              {distinctVariantCount(rows)} variations
            </span>,
            search: search,
            onSearch: setSearch,
            onCustomise: openCustomise,
            onNewView: openNewView,
            onExport: () => { setTransferIntent('export'); setTransferOpen(true); },
            exportCounts: { view: sheetColumns.visibleAttributeKeys().length, all: sheetColumns.orderedKeys.length },
            exportDisabled: !data || loading || destination.status !== 'ready' || !auth.has('products.export'),
            exportPurpose: "workbook",
            onReload: onReload,
            onImport: () => { setTransferIntent('import'); setTransferOpen(true); },
            importDisabled: !data || loading || destination.status !== 'ready' || !auth.has('products.import'),
            loading: loading,
            unavailable: unavailable,
            overflow: [liveRead.menuItem, ...publishOverflow, ...(rejectedCount ? [{ id: 'show-rejected', label: rejectedFilterMenuLabel(rejectedCount, showRejectedOnly, channel, marketplace), description: 'The rows the channel rejected in the last publish', onSelect: () => setShowRejectedOnly(v => !v) }] : []), ...offerDrafts.menu, { id: 'refresh-progress', label: refreshProgressItem(refreshProgress, progressReadAt).name, description: `Read the progress bars of ${data?.scope.label ?? 'this scope'} again`, disabled: !data, onSelect: refreshProgress }, { id: 'requirements', label: 'Requirements…', disabled: !data, description: 'Inspect the requirements for this category and marketplace.', onSelect: () => setRequirementsOpen(true) }, ...overflowItems, { id: 'formula-history', label: 'Formula history…', disabled: selectedAlias == null && new Set(selected.map(row => row.aliasId ?? '')).size !== 1, description: 'Select rows from one listing to inspect its formula history.', onSelect: () => setFormulaHistoryOpen(true) }, { id: 'bulk-formula', label: 'Apply formula to selected products…', disabled: !selected.length || !formulas.ready || new Set(selected.map(row => row.aliasId ?? '')).size !== 1, onSelect: () => setBulkFormulaRows(selected.map(row => ({ id: row.id, label: row.sku ?? row.id, rowId: row.rowId, aliasKey: row.aliasId ?? '' })).sort((a, b) => Number(a.id === productId) - Number(b.id === productId))) }],
            /* Step 4 (D2, 2026-10-01) — one message per fact: a missing field list or category is said ONCE, by its banner
               above the grid (`useMissingFieldsBanner`, the Shopify notice). The chip, the ⋯ item and an empty-grid notice
               no longer repeat it; the chip stays only as the neutral Requirements note while nothing is missing. */
            status: [
                ...(switching ? [{ tone: 'info' as const, label: 'Loading languages…', detail: 'The sheet keeps the languages it shows until the new ones arrive; editing resumes then.' }] : []),
                ...(data ? [
                ...(listingState === 'draft' ? [{ tone: 'info' as const, label: DRAFT_CHIP_LABEL, detail: draftChipDetail(channel, marketplace) }] : []),
                ...(asinPending ? [{ tone: 'info' as const, label: ASIN_PENDING_CHIP_LABEL, detail: asinPendingChipDetail(asinPending, marketplace) }] : []),
                // P8 — what waits for Publish (danger when an End or a Delete waits: it never folds) and the inactive listings.
                ...(waitingMarkStatus ? [waitingMarkStatus] : []),
                ...(inactiveMarkStatus ? [inactiveMarkStatus] : []),
                ...(data.meta.schemaMissing.length ? [] : [(({ tone, label, detail }) => ({ tone, label, detail }))(rulesStatus(channel, marketplace, data.meta.schemaMissing))]),
            ] : []),
                ...(publication.mark ? [withRejectedFilter(publication.mark, rejectedCount, showRejectedOnly, () => setShowRejectedOnly(v => !v))!] : []),
                ...(offerDrafts.mark ? [offerDrafts.mark] : []),
            ],
        },
        toolbarExtra: <>    {liveRead.element}{pendingMasterWrite && (() => {
                const pm = pendingMasterWrite;
                const choices = pm.row.values[pm.colId]?.contentAcknowledgement;
                /* P1 (report 2 I-7) — ONE answer for the whole paste or fill: every queued edit takes it, each with its own
                   cell's address, and they leave as ONE save. */
                const accept = (tier: 'shared' | 'pin') => {
                    const { apply, keep } = acknowledgePendingEdits(pendingWrites, tier);
                    if (tier === 'shared' && apply.some(edit => !edit.row.values[edit.colId]?.contentAcknowledgement))
                        acknowledgedRef.current = true;
                    setPendingWrites(keep);
                    writer.beginOperation();
                    try {
                        for (const edit of apply)
                            onCellValueChanged({ data: edit.row, colDef: { colId: edit.colId }, newValue: edit.value, oldValue: edit.previous, source: 'edit' });
                    }
                    finally {
                        writer.endOperation();
                    }
                };
                const decline = () => {
                    const all = pendingWrites;
                    setPendingWrites([]);
                    revertingRef.current = true;
                    try {
                        for (const edit of all)
                            revertPendingEdit(edit);
                        const columns = [...new Set(all.flatMap(edit => { const oneCell = slotListKeyOfSlot(edit.colId, data?.columns ?? []); return oneCell ? [edit.colId, oneCell] : [edit.colId]; }))];
                        getGridApi()?.refreshCells({ force: true, columns });
                        const node = getGridApi()?.getRowNode(pm.rowId);
                        if (node?.rowIndex != null)
                            getGridApi()?.setFocusedCell(node.rowIndex, pm.colId);
                    }
                    finally {
                        revertingRef.current = false;
                    }
                };
                const cell = pm.row.values[pm.colId];
                const fieldLabel = data?.columns.find(column => column.key === pm.colId)?.label ?? pm.colId;
                const language = languageLabel(cell?.requested ?? cell?.language ?? data?.scope.locale ?? '');
                // "a, b and c" — a bare `join(', ')` read as one destination when the reach is two.
                const reach = choices?.reach.length
                    ? choices.reach.length > 1 ? `${choices.reach.slice(0, -1).join(', ')} and ${choices.reach[choices.reach.length - 1]}` : choices.reach[0]
                    : data?.scope.label ?? '';
                const many = pendingWrites.length > 1;
                return <Banner tone="warning" title={choices ? `${many ? `${pendingWrites.length} edits: ` : ''}${fieldLabel} follows the shared ${language} text` : `${many ? `${pendingWrites.length} edits: ` : ''}${fieldLabel} changes the shared product`} action={<div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-2)' }}>
                    <Button autoFocus variant="primary" size="sm" onClick={() => accept('shared')}>{choices?.shared.label ?? 'Save to all channels'}</Button>
                    {choices && <Button variant="secondary" size="sm" onClick={() => accept('pin')}>{choices.pin.label}</Button>}
                    <Button variant="secondary" size="sm" onClick={decline}>Cancel</Button>
                  </div>}>
                  {choices
                    ? `Editing it here changes ${language} on every listing that follows it: ${reach}. Pin it on this listing to change only this listing. Declining reverts the ${many ? 'cells' : 'cell'}.`
                    : `Every channel that follows this field receives the change. Declining reverts the ${many ? 'cells' : 'cell'}.`}
                  {many && ` Your answer applies to all ${pendingWrites.length} edits of this change, saved together.`}
                </Banner>;
            })()}</>,
        status: {
            rows: visibleRows.length,
            /* The selection is counted ONCE, on the toolbar, not again here (SHEET-VIEWS, 2026-09-26). */
        }, footerNote: {
            layoutRecovery: sheetColumns.loadError ? { retry: sheetColumns.reloadSavedPreferences } : null,
            showRefusedOnly: showRefusedOnly,
            onToggleRefused: () => setShowRefusedOnly((v) => !v),
            onRetry: () => { writer.retryFailed(); },
        }, footerExtra: exportNote ? <span className="nds-cell-sub">{exportNote}</span> : null, footerBefore: null, footerStart: <NewRowsControl {...newRows.control}/>, footerLead: <>    {data && crossChannelCols > 0 && (<span className="nds-cell-muted cs-cross-channel-note" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${crossChannelCols} of ${data.columns.length} columns write the Shared product — every channel sees those edits`}>
              {crossChannelCols} of {data.columns.length} columns write the Shared product — every channel sees those edits
            </span>)}</>,
        notice: <><FamilyOrderNotice error={familyOrder.error} onRetry={familyOrder.reload}/>{startsDraftHere && <Banner tone={noAccount ? 'warning' : 'info'} title={noAccount ? noAccountTitle(channel) : notListedTitle(channel, marketplace)}>{noAccount ? connectAccountSentence(channel, marketplace) : draftStartSentence(channel, 'edit')}</Banner>}
            {fieldsBanner}
            {problem && <Banner tone="warning" onDismiss={clearProblem}>{problem}</Banner>}
            {/* 2026-09-24 — never a silent short sheet: while the store's field list is not available, say so. The sheet reloads
                itself when the list arrives (`schemaRevision`), and the metafield columns appear then. */}
            {channel === 'SHOPIFY' && data && !loading && data.meta.schemaMissing.includes(SHOPIFY_FIELDS_UNREAD) && <Banner tone="info" title="Loading this store's Shopify fields">
              Metafields and metaobject fields appear here as soon as Shopify answers. The sheet updates by itself.
            </Banner>}</>,
        grid: {
            loading: loading,
            noRowsOverlayComponentParams: emptyState,
            ...shopifyClipboard,
            processDataFromClipboard: pasteIntoNewRows,
            defaultColDef: headerPaste.defaultColDef,
            rowData: gridRows,
            columnDefs: allColumnDefs,
            getDataPath: getDataPath,
            getRowId: getRowId,
            autoGroupColumnDef: autoGroupColumnDef,
            groupDefaultExpanded: 1,
            onGridReady: onGridReady,
            onGridPreDestroyed: onGridPreDestroyed,
            initialState: sheetColumns.initialState,
            onCellValueChanged: onCellValueChanged,
            // One operation (fill, paste, range delete) = one undo step and one save; ⌘Z is the sheet's own (`useSheetUndo`).
            ...undo.gridProps,
            // P8 — the same operation events fence the Status and Action cells: one write per column and value.
            ...publishFenceProps,
            rowClassRules: rowClassRules,
            rowSelection: rowSelection,
            onSelectionChanged: onSelectionChanged,
            onCellFocused: onCellFocused,
            onCellDoubleClicked: onCellDoubleClicked,
            onCellKeyDown: (event: Parameters<typeof onCellKeyDown>[0]) => { if (newRowsGridKey(newRows.store, event as never)) return; if (onPublishCellKey(event as never)) return; if (control.onKeyDown(event as never)) return; if (!undo.onKeyDown(event.event)) onCellKeyDown(event); },
            getContextMenuItems: menuWithNewRows,
            columnDialog: columnDialog,
        },
        gridOverlay: null,
        drawer: data && !unavailable ? {
            resolveRow: (id) => rows.find((r) => r.rowId === id) ?? null,
            onRevealCell: revealCell,
            columns: data.columns,
            scope: { kind: 'channel', accountId, aliasId: rows.find(r => r.rowId === record.rowId)?.aliasId ?? '', channel: data.scope.channel, marketplace: data.scope.marketplace, label: data.scope.label, locale: data.scope.locale },
            compareTargets: compareTargets,
            loading: loading,
            error: error,
            rowActions: verbs,
            onWrite: async () => ({ state: 'refused' as const, message: DRAWER_READ_ONLY }),
            writesRefused: DRAWER_READ_ONLY,
            // The record's selling state on this destination (its one listing here).
            selling: { status: publishActions.status, error: publishActions.error, cellsOf: (id: string) => {
                    const row = rows.find(r => r.rowId === id);
                    const cell = row ? publishCellOf(row) : null;
                    return cell ? [cell] : [];
                } },
            formulas: { ...formulas,
                exprFor: (id, key) => formulas.exprFor(record.rowId ?? id, key),
            },
        } : null,
        preferences: !unavailable ? preferences : null,
        before: null, beforePreferences: <>{data && <>
              <SchemaStatus open={requirementsOpen} onClose={() => setRequirementsOpen(false)} channel={channel} market={marketplace} accountId={accountId} categories={[...new Set(rows.map(row => row.productType).filter((v): v is string => !!v))]} categorySources={Object.fromEntries([...new Set(rows.map(row => row.productType).filter((v): v is string => !!v))].map(type => [type, [...new Set(rows.filter(row => row.productType === type).map(row => row.categorySource?.label).filter((v): v is string => !!v))].join('; ')]))} typeConflicts={[...new Set(rows.flatMap(row => row.categorySource?.otherMarketConflicts ?? []))]} missing={data.meta.schemaMissing} downloadable={rulesStatus(channel, marketplace, data.meta.schemaMissing).downloadable} differences={(data.meta.coverage ?? []).flatMap(c => c.marketDifference ? [{ category: c.category, ...c.marketDifference }] : [])} ages={data.meta.schemaAge} onRefreshed={reload}/>
              
              {preflightAlias && (<Modal open onClose={() => {
                        if (!reviewBusy)
                            setPreflightAlias(null);
                    }} title={`${reviewCopy(reviewPath != null ? 'synchronize' : 'check').title} · ${data.scope.label} · ${aliasMark(preflightAlias.position)}`} subtitle={reviewCopy(reviewPath != null ? 'synchronize' : 'check').subtitle} size="lg">
                  <>{reviewPath ? <ShopifySheetReview key={reviewPath} path={reviewPath} schema={shopifySchema} onBusyChange={setReviewBusy} onChanged={() => void refresh(() => !tracker.hasUnconfirmedChanges)}/> : <AliasPublishControl alias={preflightAlias} rows={rows} channel={channel} marketplace={marketplace} autoRun/>}</>
                </Modal>)}
        </>}
        {confirmElement}
            {listResetConfirm.element}
            {control.element}
            {reloadConfirm.element}</>, afterPreferences: <>
    {formulaHistoryOpen && <FormulaHistoryDialog familyProductId={productId} coordinate={{ scope: 'channel', channel, marketplace, market: marketplace, locale: data?.scope.locale ?? locale ?? '', channelConnectionId: data?.scope.connectionId ?? accountId ?? undefined, aliasKey: selectedAlias ?? selected[0]?.aliasId ?? '' }} onClose={() => setFormulaHistoryOpen(false)} onApplied={() => { formulas.reload(); void refresh(() => true); }}/>}
    {bulkFormulaRows && data && <FormulaBulkDialog rows={bulkFormulaRows} columns={data.columns} coordinate={{ scope: 'channel', channel, marketplace, market: marketplace, locale: data?.scope.locale ?? locale ?? '', channelConnectionId: data?.scope.connectionId ?? accountId ?? undefined, aliasKey: bulkFormulaRows[0]?.aliasKey ?? '' }} functions={formulas.functions} preview={(id, key, expr, signal) => formulas.preview(bulkFormulaRows.find(row => row.id === id)!.rowId, key, expr, signal)} candidatesFor={(id, fieldKey) => { const row = rows.find(row => row.rowId === bulkFormulaRows.find(item => item.id === id)?.rowId); return row ? candidatesFor(row, fieldKey) : []; }} onClose={() => setBulkFormulaRows(null)} onApplied={() => { formulas.reload(); void refresh(() => true); }}/>}</>, after: <><SheetTransfer open={transferOpen} intent={transferIntent} onClose={() => setTransferOpen(false)} productId={productId} market={marketplace} channel={channel} accountId={accountId} aliasKey={selectedAlias} locale={locale} selectedIds={selected.map(row => row.id)} onReference={() => onExport('view')} visibleFields={expandSlotListKeys(sheetColumns.visibleAttributeKeys(), gridColumns).flatMap(key => { const c = data?.columns.find(c => c.key === key); return c ? [c.slot?.of ?? c.key, ...Object.values(c.channels ?? {}).flatMap(channel => [channel.key, channel.attribute])] : []; })} onApplied={() => { formulas.reload(); reload(); familyOrder.reload(); }}/>
        {mediaEditor.element}
        {shopifyEditor.element}
        {/* "Publish this listing…" (a band's ⋯): the studio's own Publish window, only this listing ticked. */}
        {publishListingScope && <StudioPublishDialog onClose={() => setPublishListingScope(null)} initialDestination={publishListingScope}/>}</>,
    };
}
