import { Link, Outlet } from 'react-router-dom';
import Wordmark from './Wordmark.jsx';

export default function AuthLayout() {
  return (
    <div className="auth-layout">
      <main className="auth-card">
        <Link to="/login" className="auth-brand">
          <Wordmark size="lg" />
        </Link>
        <Outlet />
      </main>
    </div>
  );
}
