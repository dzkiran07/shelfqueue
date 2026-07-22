import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axiosClient from '../../api/axiosClient';

async function countLoans(status) {
  const { data } = await axiosClient.get('/api/admin/loans', { params: { status, limit: 1 } });
  return data.pagination.total;
}

export default function Dashboard() {
  const [counts, setCounts] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [pending, checkedOut, overdue, alertsRes] = await Promise.all([
          countLoans('requested'),
          countLoans('checked_out'),
          countLoans('overdue'),
          axiosClient.get('/api/admin/alerts', { params: { resolved: 'false', limit: 5 } }),
        ]);
        if (cancelled) return;
        setCounts({ pending, checkedOut, overdue });
        setAlerts(alertsRes.data.alerts);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || 'Could not load dashboard data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <h1>Librarian dashboard</h1>

      {error ? <div role="alert">{error}</div> : null}

      {loading ? (
        <p aria-live="polite">Loading dashboard…</p>
      ) : (
        <>
          <section>
            <h2>Summary</h2>
            <dl>
              <div>
                <dt>Pending loan requests</dt>
                <dd>{counts.pending}</dd>
              </div>
              <div>
                <dt>Checked-out loans</dt>
                <dd>{counts.checkedOut}</dd>
              </div>
              <div>
                <dt>Overdue loans</dt>
                <dd>{counts.overdue}</dd>
              </div>
            </dl>
            <p>
              <Link to="/librarian/loans">Go to loan approvals</Link>
            </p>
          </section>

          <section>
            <h2>Recent security alerts</h2>
            {alerts.length === 0 ? (
              <p>No unresolved alerts.</p>
            ) : (
              <ul aria-label="Recent unresolved security alerts">
                {alerts.map((alert) => (
                  <li key={alert._id}>
                    <p>
                      <strong>{alert.type}</strong> — {new Date(alert.timestamp).toLocaleString()}
                    </p>
                    {alert.ip ? <p>IP: {alert.ip}</p> : null}
                    {alert.details ? <p>{alert.details}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
