import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import Wordmark from './Wordmark.jsx';
import ConfirmDialog from '../ui/ConfirmDialog.jsx';

const MEMBER_LINKS = [
  { to: '/catalog', label: 'Catalog' },
  { to: '/my-loans', label: 'My Loans' },
  { to: '/my-waitlist', label: 'Waitlist' },
  { to: '/profile', label: 'Profile' },
];

const LIBRARIAN_LINKS = [
  { to: '/librarian', label: 'Dashboard', end: true },
  { to: '/librarian/catalog', label: 'Catalog' },
  { to: '/librarian/loans', label: 'Loans' },
  { to: '/librarian/waitlist', label: 'Waitlist' },
  { to: '/librarian/audit-logs', label: 'Audit Log' },
  { to: '/profile', label: 'Account' },
];

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const mainRef = useRef(null);
  const isFirstRender = useRef(true);

  const links = user?.role === 'librarian' ? LIBRARIAN_LINKS : MEMBER_LINKS;

  // Move focus to the new page's content on every route change, so
  // keyboard/screen-reader users don't land back at the top of a
  // never-updated focus point (typically the last link they activated).
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [location.pathname]);

  async function handleLogout() {
    setConfirmingLogout(false);
    await logout();
    navigate('/login');
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <header className="navbar">
        <div className="navbar-inner">
          <NavLink to="/" className="brand" onClick={() => setMenuOpen(false)}>
            <Wordmark />
          </NavLink>

          <button
            type="button"
            className="nav-toggle"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="main-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>

          <nav id="main-nav" className={`nav-links${menuOpen ? ' is-open' : ''}`} aria-label="Main navigation">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
              >
                {link.label}
              </NavLink>
            ))}

            <div className="nav-user">
              {user ? <span className="nav-user-name">{user.name}</span> : null}
              <button type="button" className="btn-logout" onClick={() => setConfirmingLogout(true)}>
                Log out
              </button>
            </div>
          </nav>
        </div>
      </header>

      <main id="main-content" className="app-main" tabIndex={-1} ref={mainRef}>
        <div className="page" key={location.pathname}>
          <Outlet />
        </div>
      </main>

      <ConfirmDialog
        open={confirmingLogout}
        title="Log out?"
        message="You'll need to sign in again to access your account."
        confirmLabel="Log out"
        cancelLabel="Stay signed in"
        tone="danger"
        onConfirm={handleLogout}
        onCancel={() => setConfirmingLogout(false)}
      />
    </div>
  );
}
