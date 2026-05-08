'use client';

import { useState, useMemo } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  ColumnDef,
  SortingState,
  ColumnFiltersState,
} from '@tanstack/react-table';
import { PricingRule, apiClient } from '@/lib/api-client';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { useTranslations } from '@/lib/i18n/use-translations';
import EditRuleModal from './EditRuleModal';
import { Sliders } from 'lucide-react';

interface PricingRulesTableProps {
  rules: PricingRule[];
  onRuleUpdated: () => void;
  onRuleDeleted: () => void;
}

// Maps each rule type to a Badge variant. Per the audit's tone palette
// (rose/amber/emerald/blue/pink/slate/violet/indigo), Badge supports
// only default/success/warning/danger/info; we vary background colors
// inline for the remaining types so the visual hierarchy is preserved.
function ruleTypeBadgeClasses(type: string): string {
  switch (type) {
    case 'MATCH_LOW':
      return 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900';
    case 'PERCENTAGE_BELOW':
      return 'bg-violet-50 dark:bg-violet-950 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900';
    case 'COST_PLUS_MARGIN':
      return 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900';
    case 'FIXED_PRICE':
      return 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900';
    case 'DYNAMIC_MARGIN':
      return 'bg-pink-50 dark:bg-pink-950 text-pink-700 dark:text-pink-300 border-pink-200 dark:border-pink-900';
    default:
      return 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800';
  }
}

export default function PricingRulesTable({
  rules,
  onRuleUpdated,
  onRuleDeleted,
}: PricingRulesTableProps) {
  const { t } = useTranslations();
  const askConfirm = useConfirm();
  const { toast } = useToast();
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'priority', desc: false },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [editingRule, setEditingRule] = useState<PricingRule | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDeleteRule = async (ruleId: string) => {
    const ok = await askConfirm({
      title: t('pricing.rules.deleteConfirm.title'),
      description: t('pricing.rules.deleteConfirm.description'),
      confirmLabel: t('pricing.rules.deleteConfirm.confirm'),
      tone: 'warning',
    });
    if (!ok) return;

    try {
      setDeleting(ruleId);
      await apiClient.deactivatePricingRule(ruleId);
      onRuleDeleted();
    } catch (err) {
      toast.error(
        t('pricing.rules.deleteFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setDeleting(null);
    }
  };

  const columns = useMemo<ColumnDef<PricingRule>[]>(
    () => [
      {
        accessorKey: 'priority',
        header: () => t('pricing.rules.table.priority'),
        cell: (info) => (
          <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {info.getValue() as number}
          </span>
        ),
        size: 80,
      },
      {
        accessorKey: 'name',
        header: () => t('pricing.rules.table.name'),
        cell: (info) => (
          <div>
            <p className="font-medium text-slate-900 dark:text-slate-100">{info.getValue() as string}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {info.row.original.description ||
                t('pricing.rules.table.noDescription')}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'type',
        header: () => t('pricing.rules.table.type'),
        cell: (info) => {
          const type = info.getValue() as string;
          return (
            <span
              className={`inline-flex items-center text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${ruleTypeBadgeClasses(type)}`}
            >
              {t(`pricing.rules.type.${type}`) || type.replace(/_/g, ' ')}
            </span>
          );
        },
      },
      {
        accessorKey: 'minMarginPercent',
        header: () => t('pricing.rules.table.minMargin'),
        cell: (info) => {
          const value = info.getValue() as number | null;
          return value !== null && value !== undefined ? (
            <span className="text-base tabular-nums text-slate-700 dark:text-slate-300">
              {Number(value).toFixed(1)}%
            </span>
          ) : (
            <span className="text-sm text-slate-400 dark:text-slate-500">—</span>
          );
        },
      },
      {
        accessorKey: 'maxMarginPercent',
        header: () => t('pricing.rules.table.maxMargin'),
        cell: (info) => {
          const value = info.getValue() as number | null;
          return value !== null && value !== undefined ? (
            <span className="text-base tabular-nums text-slate-700 dark:text-slate-300">
              {Number(value).toFixed(1)}%
            </span>
          ) : (
            <span className="text-sm text-slate-400 dark:text-slate-500">—</span>
          );
        },
      },
      {
        accessorKey: 'isActive',
        header: () => t('pricing.rules.table.status'),
        cell: (info) => {
          const isActive = info.getValue() as boolean;
          return (
            <Badge variant={isActive ? 'success' : 'default'}>
              {isActive
                ? t('pricing.rules.status.active')
                : t('pricing.rules.status.inactive')}
            </Badge>
          );
        },
      },
      {
        accessorKey: 'createdAt',
        header: () => t('pricing.rules.table.created'),
        cell: (info) => (
          <span className="text-base text-slate-600 dark:text-slate-400 tabular-nums">
            {new Date(info.getValue() as string).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => t('pricing.rules.table.actions'),
        cell: (info) => {
          const rule = info.row.original;
          const isDeletingThis = deleting === rule.id;
          return (
            <div className="flex gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditingRule(rule)}
                icon={<Pencil size={11} />}
                aria-label={t('pricing.rules.action.edit')}
              >
                {t('pricing.rules.action.edit')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => handleDeleteRule(rule.id)}
                disabled={isDeletingThis}
                loading={isDeletingThis}
                icon={isDeletingThis ? null : <Trash2 size={11} />}
                aria-label={t('pricing.rules.action.delete')}
              >
                {isDeletingThis
                  ? t('pricing.rules.action.deleting')
                  : t('pricing.rules.action.delete')}
              </Button>
            </div>
          );
        },
      },
    ],
    [deleting, t],
  );

  const table = useReactTable({
    data: rules,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  if (rules.length === 0) {
    return (
      <EmptyState
        icon={Sliders}
        title={t('pricing.rules.table.empty')}
        description={t('pricing.rules.table.emptyHint')}
      />
    );
  }

  const pageIndex = table.getState().pagination.pageIndex;
  const pageSize = table.getState().pagination.pageSize;
  const total = table.getFilteredRowModel().rows.length;
  const fromIdx = pageIndex * pageSize + 1;
  const toIdx = Math.min((pageIndex + 1) * pageSize, total);

  return (
    <>
      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-md">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800">
                {table.getHeaderGroups().map((headerGroup) =>
                  headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      scope="col"
                      className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300"
                      style={{ width: header.getSize() }}
                    >
                      {header.isPlaceholder ? null : (
                        <div
                          className={
                            header.column.getCanSort()
                              ? 'cursor-pointer select-none inline-flex items-center gap-1'
                              : ''
                          }
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {typeof header.column.columnDef.header === 'function'
                            ? (header.column.columnDef.header as () => string)()
                            : (header.column.columnDef.header as string)}
                          {header.column.getCanSort() && (
                            <span className="text-xs text-slate-400 dark:text-slate-500">
                              {header.column.getIsSorted() === 'desc'
                                ? '↓'
                                : header.column.getIsSorted() === 'asc'
                                  ? '↑'
                                  : '⇅'}
                            </span>
                          )}
                        </div>
                      )}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-top">
                      {typeof cell.column.columnDef.cell === 'function'
                        ? cell.column.columnDef.cell(cell.getContext())
                        : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-3 py-2 border-t border-slate-200 dark:border-slate-800 text-base text-slate-600 dark:text-slate-400">
          <span className="tabular-nums">
            {t('pricing.rules.pagination.summary', {
              from: fromIdx,
              to: toIdx,
              total,
            })}
          </span>
          <div className="flex gap-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              {t('pricing.rules.pagination.previous')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              {t('pricing.rules.pagination.next')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Edit Rule Modal */}
      {editingRule && (
        <EditRuleModal
          rule={editingRule}
          onClose={() => setEditingRule(null)}
          onRuleUpdated={() => {
            setEditingRule(null);
            onRuleUpdated();
          }}
        />
      )}
    </>
  );
}
