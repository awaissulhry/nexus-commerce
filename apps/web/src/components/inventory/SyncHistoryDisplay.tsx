'use client';

import { useState, useEffect } from 'react';

interface SyncLog {
  syncId: string;
  syncType: string;
  status: 'success' | 'partial' | 'failed';
  totalItems: number;
  successCount: number;
  failureCount: number;
  duration: number;
  startTime: string;
  endTime: string;
  details?: any;
}

interface SyncHistoryDisplayProps {
  limit?: number;
  onSyncClick?: (syncId: string) => void;
}

export function SyncHistoryDisplay({ limit = 10, onSyncClick }: SyncHistoryDisplayProps) {
  const [syncs, setSyncs] = useState<SyncLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSyncHistory();
  }, [limit]);

  const fetchSyncHistory = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(`/api/sync/amazon/catalog/history?limit=${limit}&offset=0`);
      if (!response.ok) {
        throw new Error('Failed to fetch sync history');
      }

      const result = await response.json();
      setSyncs(result.data.syncs || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch sync history';
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const baseClasses = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium';
    switch (status) {
      case 'success':
        return `${baseClasses} bg-green-100 text-green-800`;
      case 'partial':
        return `${baseClasses} bg-yellow-100 text-yellow-800`;
      case 'failed':
        return `${baseClasses} bg-red-100 text-red-800`;
      default:
        return `${baseClasses} bg-gray-100 text-gray-800`;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return '✓';
      case 'partial':
        return '⚠';
      case 'failed':
        return '✕';
      default:
        return '○';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <svg className="w-6 h-6 animate-spin text-blue-600" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="ml-3 text-gray-600">Loading sync history...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-sm text-red-700">{error}</p>
      </div>
    );
  }

  if (syncs.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500">No sync history available</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Sync ID</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Items</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Success</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Failed</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Duration</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Started</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-700">Action</th>
          </tr>
        </thead>
        <tbody>
          {syncs.map((sync) => (
            <tr key={sync.syncId} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
              <td className="px-4 py-3">
                <code className="text-xs bg-gray-100 px-2 py-1 rounded">{sync.syncId.substring(0, 12)}...</code>
              </td>
              <td className="px-4 py-3">
                <span className={getStatusBadge(sync.status)}>
                  <span>{getStatusIcon(sync.status)}</span>
                  <span className="capitalize">{sync.status}</span>
                </span>
              </td>
              <td className="px-4 py-3 font-medium text-gray-900">{sync.totalItems}</td>
              <td className="px-4 py-3">
                <span className="text-green-700 font-medium">{sync.successCount}</span>
              </td>
              <td className="px-4 py-3">
                <span className="text-red-700 font-medium">{sync.failureCount}</span>
              </td>
              <td className="px-4 py-3 text-gray-600">{formatDuration(sync.duration)}</td>
              <td className="px-4 py-3 text-gray-600 text-xs">{formatDate(sync.startTime)}</td>
              <td className="px-4 py-3">
                <button
                  onClick={() => onSyncClick?.(sync.syncId)}
                  className="text-blue-600 hover:text-blue-800 hover:underline transition-colors text-xs font-medium"
                >
                  View Details
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
