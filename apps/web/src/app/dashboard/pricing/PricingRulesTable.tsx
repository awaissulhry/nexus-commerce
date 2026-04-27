'use client';

import { useState, useMemo } from 'react';
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
import EditRuleModal from './EditRuleModal';

interface PricingRulesTableProps {
  rules: PricingRule[];
  onRuleUpdated: () => void;
  onRuleDeleted: () => void;
}

function getRuleTypeColor(type: string): string {
  switch (type) {
    case 'MATCH_LOW':
      return 'bg-blue-100 text-blue-800';
    case 'PERCENTAGE_BELOW':
      return 'bg-purple-100 text-purple-800';
    case 'COST_PLUS_MARGIN':
      return 'bg-green-100 text-green-800';
    case 'FIXED_PRICE':
      return 'bg-orange-100 text-orange-800';
    case 'DYNAMIC_MARGIN':
      return 'bg-pink-100 text-pink-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

function getRuleTypeLabel(type: string): string {
  return type.replace(/_/g, ' ');
}

export default function PricingRulesTable({
  rules,
  onRuleUpdated,
  onRuleDeleted,
}: PricingRulesTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'priority', desc: false },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [editingRule, setEditingRule] = useState<PricingRule | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('Are you sure you want to deactivate this rule?')) return;

    try {
      setDeleting(ruleId);
      setError(null);
      await apiClient.deactivatePricingRule(ruleId);
      onRuleDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete rule');
      console.error('Error deleting rule:', err);
    } finally {
      setDeleting(null);
    }
  };

  const columns = useMemo<ColumnDef<PricingRule>[]>(
    () => [
      {
        accessorKey: 'priority',
        header: 'Priority',
        cell: (info) => (
          <span className="font-semibold text-gray-900">
            {info.getValue() as number}
          </span>
        ),
        size: 80,
      },
      {
        accessorKey: 'name',
        header: 'Rule Name',
        cell: (info) => (
          <div>
            <p className="font-medium text-gray-900">{info.getValue() as string}</p>
            <p className="text-xs text-gray-500 mt-1">
              {(info.row.original.description || 'No description')}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'type',
        header: 'Type',
        cell: (info) => {
          const type = info.getValue() as string;
          return (
            <span className={`px-2 py-1 rounded text-xs font-semibold ${getRuleTypeColor(type)}`}>
              {getRuleTypeLabel(type)}
            </span>
          );
        },
      },
      {
        accessorKey: 'minMarginPercent',
        header: 'Min Margin',
        cell: (info) => {
          const value = info.getValue() as number | null;
          return value !== null ? (
            <span className="text-sm text-gray-700">{value.toFixed(1)}%</span>
          ) : (
            <span className="text-sm text-gray-400">-</span>
          );
        },
      },
      {
        accessorKey: 'maxMarginPercent',
        header: 'Max Margin',
        cell: (info) => {
          const value = info.getValue() as number | null;
          return value !== null ? (
            <span className="text-sm text-gray-700">{value.toFixed(1)}%</span>
          ) : (
            <span className="text-sm text-gray-400">-</span>
          );
        },
      },
      {
        accessorKey: 'isActive',
        header: 'Status',
        cell: (info) => {
          const isActive = info.getValue() as boolean;
          return (
            <span
              className={`px-2 py-1 rounded text-xs font-semibold ${
                isActive
                  ? 'bg-green-100 text-green-800'
                  : 'bg-gray-100 text-gray-800'
              }`}
            >
              {isActive ? '✓ Active' : 'Inactive'}
            </span>
          );
        },
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        cell: (info) => (
          <span className="text-sm text-gray-600">
            {new Date(info.getValue() as string).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: (info) => {
          const rule = info.row.original;
          const isDeletingThis = deleting === rule.id;
          return (
            <div className="flex gap-2">
              <button
                onClick={() => setEditingRule(rule)}
                className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => handleDeleteRule(rule.id)}
                disabled={isDeletingThis}
                className="px-3 py-1.5 bg-red-600 text-white text-sm font-medium rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isDeletingThis ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          );
        },
      },
    ],
    [deleting]
  );

  const table = useReactTable({
    data: rules,
    columns,
    state: {
      sorting,
      columnFilters,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return (
    <>
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded">
          <p className="text-red-800 text-sm">{error}</p>
        </div>
      )}

      {rules.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-lg">No pricing rules yet</p>
          <p className="text-gray-400 text-sm mt-1">
            Create your first pricing rule to get started
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  {table.getHeaderGroups().map((headerGroup) =>
                    headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        className="px-4 py-3 text-left text-sm font-semibold text-gray-900"
                        style={{ width: header.getSize() }}
                      >
                        {header.isPlaceholder ? null : (
                          <div
                            {...{
                              className: header.column.getCanSort()
                                ? 'cursor-pointer select-none flex items-center gap-2'
                                : '',
                              onClick: header.column.getToggleSortingHandler(),
                            }}
                          >
                            {header.column.columnDef.header &&
                              typeof header.column.columnDef.header === 'string'
                              ? header.column.columnDef.header
                              : null}
                            {header.column.getCanSort() && (
                              <span className="text-xs">
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
                    ))
                  )}
                </tr>
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="border-b border-gray-200 hover:bg-gray-50">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3">
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
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
            <div className="text-sm text-gray-600">
              Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{' '}
              {Math.min(
                (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
                table.getFilteredRowModel().rows.length
              )}{' '}
              of {table.getFilteredRowModel().rows.length} rules
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                className="px-3 py-1.5 border border-gray-300 rounded text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                className="px-3 py-1.5 border border-gray-300 rounded text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

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
