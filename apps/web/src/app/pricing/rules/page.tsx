'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/layout/PageHeader';
import { apiClient, PricingRule } from '@/lib/api-client';
import PricingRulesTable from './PricingRulesTable';
import CreateRuleModal from './CreateRuleModal';

export default function PricingRulesDashboardPage() {
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchRules = async () => {
    try {
      setError(null);
      const pricingRules = await apiClient.getPricingRules();
      setRules(pricingRules);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch pricing rules');
      console.error('Error fetching pricing rules:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchRules();
    setRefreshing(false);
  };

  const handleRuleCreated = async () => {
    setShowCreateModal(false);
    await fetchRules();
  };

  const handleRuleUpdated = async () => {
    await fetchRules();
  };

  const handleRuleDeleted = async () => {
    await fetchRules();
  };

  return (
    <div>
      <PageHeader
        title="Pricing Rules"
        subtitle="Engine-level rules — match-low, percentage-below, cost-plus margin, fixed price, dynamic margin. Evaluated as PRICING_RULE source in the resolver chain."
        breadcrumbs={[
          { label: 'Pricing', href: '/pricing' },
          { label: 'Rules' },
        ]}
      />

      {/* Error Alert */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800 font-medium">Error loading pricing rules</p>
          <p className="text-red-700 text-sm mt-1">{error}</p>
        </div>
      )}

      {/* Header Actions */}
      <div className="mb-6 flex justify-between items-center">
        <div className="text-sm text-gray-600">
          {rules.length} active rule{rules.length !== 1 ? 's' : ''}
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            + Create New Rule
          </button>
        </div>
      </div>

      {/* Loading State */}
      {loading ? (
        <div className="space-y-4">
          <div className="h-12 bg-gray-100 rounded-lg animate-pulse" />
          <div className="h-64 bg-gray-100 rounded-lg animate-pulse" />
        </div>
      ) : (
        <PricingRulesTable
          rules={rules}
          onRuleUpdated={handleRuleUpdated}
          onRuleDeleted={handleRuleDeleted}
        />
      )}

      {/* Create Rule Modal */}
      {showCreateModal && (
        <CreateRuleModal
          onClose={() => setShowCreateModal(false)}
          onRuleCreated={handleRuleCreated}
        />
      )}
    </div>
  );
}
