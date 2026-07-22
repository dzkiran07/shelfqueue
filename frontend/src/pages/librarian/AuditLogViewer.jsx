import { useCallback, useEffect, useState } from 'react';
import axiosClient from '../../api/axiosClient';
import Badge from '../../components/ui/Badge.jsx';
import DatePicker from '../../components/ui/DatePicker.jsx';

function actionTone(action) {
  if (/fail|error|denied|lockout|blocked/i.test(action)) return 'danger';
  if (/success|registered|completed|created|approved/i.test(action)) return 'success';
  if (/reset|requested|pending/i.test(action)) return 'warning';
  return 'info';
}

const EMPTY_FILTERS = { action: '', actorId: '', from: '', to: '' };

export default function AuditLogViewer() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page };
      if (appliedFilters.action) params.action = appliedFilters.action;
      if (appliedFilters.actorId) params.actorId = appliedFilters.actorId;
      if (appliedFilters.from) params.from = appliedFilters.from;
      if (appliedFilters.to) params.to = appliedFilters.to;

      const { data } = await axiosClient.get('/api/admin/audit-logs', { params });
      setLogs(data.logs);
      setPagination(data.pagination);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load audit logs.');
    } finally {
      setLoading(false);
    }
  }, [page, appliedFilters]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  function handleFilterSubmit(e) {
    e.preventDefault();
    setPage(1);
    setAppliedFilters(filters);
  }

  function handleClearFilters() {
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setPage(1);
  }

  return (
    <div>
      <h1>Audit log</h1>

      <form onSubmit={handleFilterSubmit} role="search" aria-label="Filter audit logs" noValidate>
        <div>
          <label htmlFor="audit-action">Action</label>
          <input
            id="audit-action"
            type="text"
            value={filters.action}
            onChange={(e) => setFilters((prev) => ({ ...prev, action: e.target.value }))}
          />
        </div>

        <div>
          <label htmlFor="audit-actor-id">Actor ID</label>
          <input
            id="audit-actor-id"
            type="text"
            value={filters.actorId}
            onChange={(e) => setFilters((prev) => ({ ...prev, actorId: e.target.value }))}
          />
        </div>

        <div>
          <label htmlFor="audit-from">From</label>
          <DatePicker
            id="audit-from"
            label="From"
            value={filters.from}
            onChange={(value) => setFilters((prev) => ({ ...prev, from: value }))}
          />
        </div>

        <div>
          <label htmlFor="audit-to">To</label>
          <DatePicker
            id="audit-to"
            label="To"
            value={filters.to}
            onChange={(value) => setFilters((prev) => ({ ...prev, to: value }))}
          />
        </div>

        <button type="submit">Apply filters</button>
        <button type="button" onClick={handleClearFilters}>
          Clear filters
        </button>
      </form>

      {error ? <div role="alert">{error}</div> : null}

      {loading ? (
        <p aria-live="polite">Loading audit log…</p>
      ) : logs.length === 0 ? (
        <p>No matching audit log entries.</p>
      ) : (
        <table>
          <caption>Audit log entries</caption>
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Action</th>
              <th scope="col">Resource</th>
              <th scope="col">Actor</th>
              <th scope="col">IP</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log._id}>
                <td>{new Date(log.timestamp).toLocaleString()}</td>
                <td>
                  <Badge tone={actionTone(log.action)}>{log.action}</Badge>
                </td>
                <td>
                  {log.resourceType ? `${log.resourceType}${log.resourceId ? ` (${log.resourceId})` : ''}` : '—'}
                </td>
                <td>{log.actorId || 'System'}</td>
                <td>{log.ip || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pagination && pagination.totalPages > 1 ? (
        <nav aria-label="Audit log pagination">
          <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            Previous
          </button>
          <span aria-live="polite">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
            disabled={page >= pagination.totalPages}
          >
            Next
          </button>
        </nav>
      ) : null}
    </div>
  );
}
