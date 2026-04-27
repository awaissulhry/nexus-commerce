'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/layout/PageHeader';
import { apiClient, BulkActionJob } from '@/lib/api-client';
import BulkActionsTable from './BulkActionsTable';

export default function BulkActionsDashboardPage() {
  const [jobs, setJobs] = useState<BulkActionJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchJobs = async () => {
    try {
      setError(null);
      const pendingJobs = await apiClient.getPendingBulkJobs();
      setJobs(pendingJobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch bulk action jobs');
      console.error('Error fetching bulk action jobs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    // Auto-refresh every 10 seconds
    const interval = setInterval(fetchJobs, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchJobs();
    setRefreshing(false);
  };

  const handleJobCancelled = async () => {
    await fetchJobs();
  };

  const handleJobRollback = async () => {
    await fetchJobs();
  };

  // Calculate summary stats
  const stats = {
    total: jobs.length,
    pending: jobs.filter(j => j.status === 'PENDING').length,
    inProgress: jobs.filter(j => j.status === 'IN_PROGRESS').length,
    completed: jobs.filter(j => j.status === 'COMPLETED').length,
    failed: jobs.filter(j => j.status === 'FAILED').length,
  };

  return (
    <div>
      <PageHeader
        title="Bulk Actions"
        subtitle="Monitor and manage asynchronous bulk operations"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Bulk Actions' },
        ]}
      />

      {/* Error Alert */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800 font-medium">Error loading bulk action jobs</p>
          <p className="text-red-700 text-sm mt-1">{error}</p>
        </div>
      )}

      {/* Summary Stats */}
      {!loading && (
        <div className="mb-6 grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-xs text-gray-600 font-medium">Total Jobs</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{stats.total}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-xs text-gray-600 font-medium">Pending</p>
            <p className="text-2xl font-bold text-yellow-600 mt-1">{stats.pending}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-xs text-gray-600 font-medium">In Progress</p>
            <p className="text-2xl font-bold text-blue-600 mt-1">{stats.inProgress}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-xs text-gray-600 font-medium">Completed</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{stats.completed}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-xs text-gray-600 font-medium">Failed</p>
            <p className="text-2xl font-bold text-red-600 mt-1">{stats.failed}</p>
          </div>
        </div>
      )}

      {/* Refresh Button */}
      <div className="mb-6 flex justify-end">
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {refreshing ? 'Refreshing...' : 'Refresh Now'}
        </button>
      </div>

      {/* Loading State */}
      {loading ? (
        <div className="space-y-4">
          <div className="h-12 bg-gray-100 rounded-lg animate-pulse" />
          <div className="h-96 bg-gray-100 rounded-lg animate-pulse" />
        </div>
      ) : (
        <BulkActionsTable
          jobs={jobs}
          onJobCancelled={handleJobCancelled}
          onJobRollback={handleJobRollback}
        />
      )}
    </div>
  );
}
