'use client';

import { useState } from 'react';
import { SyncError } from '@/lib/api-client';

interface SystemLogsSectionProps {
  logs: SyncError[];
}

function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
      return 'bg-red-100 text-red-800 border-red-300';
    case 'ERROR':
      return 'bg-orange-100 text-orange-800 border-orange-300';
    case 'WARNING':
      return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    case 'INFO':
      return 'bg-blue-100 text-blue-800 border-blue-300';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-300';
  }
}

function getSeverityIcon(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
      return '🔴';
    case 'ERROR':
      return '🟠';
    case 'WARNING':
      return '🟡';
    case 'INFO':
      return '🔵';
    default:
      return '⚪';
  }
}

function getSeverityBgClass(severity: string): string {
  switch (severity) {
    case 'CRITICAL':
      return 'bg-red-50 border-l-4 border-red-500';
    case 'ERROR':
      return 'bg-orange-50 border-l-4 border-orange-500';
    case 'WARNING':
      return 'bg-yellow-50 border-l-4 border-yellow-500';
    case 'INFO':
      return 'bg-blue-50 border-l-4 border-blue-500';
    default:
      return 'bg-gray-50 border-l-4 border-gray-500';
  }
}

export default function SystemLogsSection({ logs }: SystemLogsSectionProps) {
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<string | null>(null);

  const filteredLogs = filterSeverity
    ? logs.filter((log) => log.severity === filterSeverity)
    : logs;

  const severityCounts = {
    CRITICAL: logs.filter((l) => l.severity === 'CRITICAL').length,
    ERROR: logs.filter((l) => l.severity === 'ERROR').length,
    WARNING: logs.filter((l) => l.severity === 'WARNING').length,
    INFO: logs.filter((l) => l.severity === 'INFO').length,
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <h2 className="text-xl font-bold text-gray-900 mb-6">System Logs</h2>

      {/* Severity Filter Badges */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button
          onClick={() => setFilterSeverity(null)}
          className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            filterSeverity === null
              ? 'bg-gray-900 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          All ({logs.length})
        </button>
        {Object.entries(severityCounts).map(([severity, count]) => (
          <button
            key={severity}
            onClick={() => setFilterSeverity(severity)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              filterSeverity === severity
                ? `${getSeverityColor(severity)} border border-current`
                : `${getSeverityColor(severity)} opacity-60 hover:opacity-100`
            }`}
          >
            {getSeverityIcon(severity)} {severity} ({count})
          </button>
        ))}
      </div>

      {/* Logs List */}
      {filteredLogs.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg">
            {filterSeverity ? `No ${filterSeverity} logs` : 'No system logs'}
          </p>
          <p className="text-gray-400 text-sm mt-1">
            {filterSeverity ? 'Try selecting a different severity level' : 'All systems operational'}
          </p>
        </div>
      ) : (
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {filteredLogs.map((log) => (
            <div
              key={log.id}
              className={`${getSeverityBgClass(log.severity)} rounded-lg p-4 cursor-pointer hover:shadow-md transition-shadow`}
              onClick={() =>
                setExpandedLogId(expandedLogId === log.id ? null : log.id)
              }
            >
              {/* Log Header */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{getSeverityIcon(log.severity)}</span>
                    <span
                      className={`${getSeverityColor(log.severity)} px-2 py-0.5 rounded text-xs font-semibold`}
                    >
                      {log.severity}
                    </span>
                    <span className="text-xs text-gray-600 font-medium">
                      {log.channel.toUpperCase()}
                    </span>
                    <span className="text-xs text-gray-500">
                      {new Date(log.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-gray-900 break-words">
                    {log.errorMessage}
                  </p>
                  {log.errorType && (
                    <p className="text-xs text-gray-600 mt-1">
                      Type: <span className="font-mono">{log.errorType}</span>
                    </p>
                  )}
                </div>
                <div className="text-gray-400 text-lg flex-shrink-0">
                  {expandedLogId === log.id ? '▼' : '▶'}
                </div>
              </div>

              {/* Expanded Details */}
              {expandedLogId === log.id && (
                <div className="mt-4 pt-4 border-t border-current border-opacity-20 space-y-3">
                  {log.productId && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-1">Product ID</p>
                      <p className="text-sm font-mono text-gray-600 bg-white bg-opacity-50 rounded px-2 py-1">
                        {log.productId}
                      </p>
                    </div>
                  )}
                  {log.variationId && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-1">Variation ID</p>
                      <p className="text-sm font-mono text-gray-600 bg-white bg-opacity-50 rounded px-2 py-1">
                        {log.variationId}
                      </p>
                    </div>
                  )}
                  {log.errorDetails && Object.keys(log.errorDetails).length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-1">Error Details</p>
                      <pre className="text-xs text-gray-600 bg-white bg-opacity-50 rounded px-2 py-1 overflow-x-auto max-h-32 overflow-y-auto">
                        {JSON.stringify(log.errorDetails, null, 2)}
                      </pre>
                    </div>
                  )}
                  <div>
                    <p className="text-xs font-semibold text-gray-700 mb-1">Full Timestamp</p>
                    <p className="text-xs text-gray-600 font-mono">
                      {new Date(log.createdAt).toISOString()}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Summary Stats */}
      {logs.length > 0 && (
        <div className="mt-6 pt-6 border-t border-gray-200">
          <p className="text-xs text-gray-600 font-medium mb-3">Summary (Last 24 Hours)</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-red-50 rounded p-3 border border-red-200">
              <p className="text-xs text-red-700 font-medium">Critical</p>
              <p className="text-2xl font-bold text-red-600 mt-1">
                {severityCounts.CRITICAL}
              </p>
            </div>
            <div className="bg-orange-50 rounded p-3 border border-orange-200">
              <p className="text-xs text-orange-700 font-medium">Errors</p>
              <p className="text-2xl font-bold text-orange-600 mt-1">
                {severityCounts.ERROR}
              </p>
            </div>
            <div className="bg-yellow-50 rounded p-3 border border-yellow-200">
              <p className="text-xs text-yellow-700 font-medium">Warnings</p>
              <p className="text-2xl font-bold text-yellow-600 mt-1">
                {severityCounts.WARNING}
              </p>
            </div>
            <div className="bg-blue-50 rounded p-3 border border-blue-200">
              <p className="text-xs text-blue-700 font-medium">Info</p>
              <p className="text-2xl font-bold text-blue-600 mt-1">
                {severityCounts.INFO}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
