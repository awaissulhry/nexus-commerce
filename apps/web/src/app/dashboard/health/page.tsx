'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/layout/PageHeader';
import { apiClient, ChannelHealthScore, UnresolvedConflict, SyncError } from '@/lib/api-client';
import HealthVitalsSection from './HealthVitalsSection';
import ConflictsSection from './ConflictsSection';
import SystemLogsSection from './SystemLogsSection';
import CronStatusPanel from './CronStatusPanel';
import StockDriftPanel from './StockDriftPanel';

export default function HealthDashboardPage() {
  const [healthScores, setHealthScores] = useState<ChannelHealthScore[]>([]);
  const [conflicts, setConflicts] = useState<UnresolvedConflict[]>([]);
  const [systemLogs, setSystemLogs] = useState<SyncError[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async () => {
    try {
      setError(null);
      const [scores, conflictsList, logs] = await Promise.all([
        apiClient.getAllHealthScores(24),
        apiClient.getConflicts(),
        Promise.all([
          apiClient.getErrors('amazon', 50, 24),
          apiClient.getErrors('ebay', 50, 24),
        ]).then(([amazonLogs, ebayLogs]) => [...amazonLogs, ...ebayLogs]),
      ]);

      setHealthScores(scores);
      setConflicts(conflictsList);
      setSystemLogs(logs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch health data');
      console.error('Error fetching health data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  const handleConflictResolved = async () => {
    // Refresh conflicts after resolution
    try {
      const updatedConflicts = await apiClient.getConflicts();
      setConflicts(updatedConflicts);
    } catch (err) {
      console.error('Error refreshing conflicts:', err);
    }
  };

  return (
    <div>
      <PageHeader
        title="Sync Health Dashboard"
        subtitle="Monitor marketplace sync health, conflicts, and system logs"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Health' },
        ]}
      />

      {/* Error Alert */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800 font-medium">Error loading health data</p>
          <p className="text-red-700 text-sm mt-1">{error}</p>
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
        <div className="space-y-6">
          <div className="h-32 bg-gray-100 rounded-lg animate-pulse" />
          <div className="h-96 bg-gray-100 rounded-lg animate-pulse" />
          <div className="h-96 bg-gray-100 rounded-lg animate-pulse" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Vitals Section */}
          <HealthVitalsSection healthScores={healthScores} />

          {/* Cron Jobs — observability for scheduled job runs */}
          <CronStatusPanel />

          {/* Stock + Price Drift — listing-level cascade health */}
          <StockDriftPanel />

          {/* Conflicts Section */}
          <ConflictsSection
            conflicts={conflicts}
            onConflictResolved={handleConflictResolved}
          />

          {/* System Logs Section */}
          <SystemLogsSection logs={systemLogs} />
        </div>
      )}
    </div>
  );
}
