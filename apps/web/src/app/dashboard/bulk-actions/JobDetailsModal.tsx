'use client';

import { useState } from 'react';
import { BulkActionJob } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/ConfirmProvider';

interface JobDetailsModalProps {
  job: BulkActionJob;
  onClose: () => void;
  onJobRollback: () => void;
}

export default function JobDetailsModal({
  job,
  onClose,
}: JobDetailsModalProps) {
  const { toast } = useToast();
  const askConfirm = useConfirm();
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRollback = async () => {
    if (!(await askConfirm({ title: 'Rollback this job?', description: 'This action cannot be undone.', confirmLabel: 'Rollback', tone: 'warning' }))) {
      return;
    }

    try {
      setRolling(true);
      setError(null);
      // Note: rollback endpoint may not exist yet, but we'll prepare for it
      // await apiClient.rollbackBulkJob(job.id);
      // For now, just show a message
      toast.info('Rollback functionality coming soon');
      setRolling(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rollback job');
      console.error('Error rolling back job:', err);
      setRolling(false);
    }
  };

  const successRate = job.totalItems > 0 
    ? ((job.processedItems / job.totalItems) * 100).toFixed(1)
    : '0';

  const failureRate = job.totalItems > 0
    ? ((job.failedItems / job.totalItems) * 100).toFixed(1)
    : '0';

  const canRollback = job.status === 'COMPLETED' && job.processedItems > 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 sticky top-0 bg-white flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{job.jobName}</h2>
            <p className="text-sm text-gray-600 mt-1">Job ID: {job.id}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded">
              <p className="text-red-800 text-sm">{error}</p>
            </div>
          )}

          {/* Status Overview */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <p className="text-xs text-gray-600 font-medium">Status</p>
              <p className="text-lg font-bold text-gray-900 mt-2">{job.status}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <p className="text-xs text-gray-600 font-medium">Progress</p>
              <p className="text-lg font-bold text-blue-600 mt-2">{job.progressPercent}%</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <p className="text-xs text-gray-600 font-medium">Success Rate</p>
              <p className="text-lg font-bold text-green-600 mt-2">{successRate}%</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <p className="text-xs text-gray-600 font-medium">Failure Rate</p>
              <p className="text-lg font-bold text-red-600 mt-2">{failureRate}%</p>
            </div>
          </div>

          {/* Progress Bar */}
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Overall Progress</p>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className="bg-blue-600 h-3 rounded-full transition-all"
                style={{ width: `${job.progressPercent}%` }}
              />
            </div>
          </div>

          {/* Item Statistics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <p className="text-xs text-blue-700 font-medium">Total Items</p>
              <p className="text-2xl font-bold text-blue-900 mt-2">{job.totalItems}</p>
            </div>
            <div className="bg-green-50 rounded-lg p-4 border border-green-200">
              <p className="text-xs text-green-700 font-medium">Processed</p>
              <p className="text-2xl font-bold text-green-900 mt-2">{job.processedItems}</p>
            </div>
            <div className="bg-red-50 rounded-lg p-4 border border-red-200">
              <p className="text-xs text-red-700 font-medium">Failed</p>
              <p className="text-2xl font-bold text-red-900 mt-2">{job.failedItems}</p>
            </div>
            <div className="bg-yellow-50 rounded-lg p-4 border border-yellow-200">
              <p className="text-xs text-yellow-700 font-medium">Skipped</p>
              <p className="text-2xl font-bold text-yellow-900 mt-2">{job.skippedItems}</p>
            </div>
          </div>

          {/* Job Details */}
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-gray-700">Job Name</p>
              <p className="text-sm text-gray-600 mt-1">{job.jobName}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700">Action Type</p>
              <p className="text-sm text-gray-600 mt-1">{job.actionType}</p>
            </div>
            {job.channel && (
              <div>
                <p className="text-sm font-medium text-gray-700">Channel</p>
                <p className="text-sm text-gray-600 mt-1">{job.channel}</p>
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-gray-700">Created</p>
              <p className="text-sm text-gray-600 mt-1">
                {new Date(job.createdAt).toLocaleString()}
              </p>
            </div>
            {job.startedAt && (
              <div>
                <p className="text-sm font-medium text-gray-700">Started</p>
                <p className="text-sm text-gray-600 mt-1">
                  {new Date(job.startedAt).toLocaleString()}
                </p>
              </div>
            )}
            {job.completedAt && (
              <div>
                <p className="text-sm font-medium text-gray-700">Completed</p>
                <p className="text-sm text-gray-600 mt-1">
                  {new Date(job.completedAt).toLocaleString()}
                </p>
              </div>
            )}
          </div>

          {/* Error Logs (if any) */}
          {job.failedItems > 0 && (
            <div className="bg-red-50 rounded-lg p-4 border border-red-200">
              <p className="text-sm font-medium text-red-900 mb-3">
                ⚠ {job.failedItems} Item{job.failedItems !== 1 ? 's' : ''} Failed
              </p>
              <p className="text-xs text-red-700">
                Review the failed items and consider retrying or investigating the root cause.
              </p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-4 border-t border-gray-200">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium transition-colors"
            >
              Close
            </button>
            {canRollback && (
              <button
                onClick={handleRollback}
                disabled={rolling}
                className="flex-1 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
              >
                {rolling ? 'Rolling Back...' : 'Rollback Job'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
