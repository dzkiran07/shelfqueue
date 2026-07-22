import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext.jsx';
import AppShell from '../components/layout/AppShell.jsx';
import AuthLayout from '../components/layout/AuthLayout.jsx';
import ConfirmDialog from '../components/ui/ConfirmDialog.jsx';

import Login from '../pages/member/Login.jsx';
import Register from '../pages/member/Register.jsx';
import ForgotPassword from '../pages/member/ForgotPassword.jsx';
import ResetPassword from '../pages/member/ResetPassword.jsx';
import MfaSetup from '../pages/member/MfaSetup.jsx';
import Catalog from '../pages/member/Catalog.jsx';
import LoanRequestForm from '../pages/member/LoanRequestForm.jsx';
import MyLoans from '../pages/member/MyLoans.jsx';
import MyWaitlist from '../pages/member/MyWaitlist.jsx';
import Profile from '../pages/member/Profile.jsx';

import Dashboard from '../pages/librarian/Dashboard.jsx';
import CatalogManager from '../pages/librarian/CatalogManager.jsx';
import LoanApprovals from '../pages/librarian/LoanApprovals.jsx';
import WaitlistManager from '../pages/librarian/WaitlistManager.jsx';
import AuditLogViewer from '../pages/librarian/AuditLogViewer.jsx';

import { buildAxiosMock } from './mockAxios.js';

const roleRef = { current: 'member' };

vi.mock('../api/axiosClient', () => {
  return {
    default: {
      get: (...args) => mockImpl.get(...args),
      post: (...args) => mockImpl.post(...args),
      patch: (...args) => mockImpl.patch(...args),
      delete: (...args) => mockImpl.delete(...args),
    },
    setCsrfToken: () => {},
    getCsrfToken: () => null,
  };
});

// Populated per-test in beforeEach; the module mock above delegates to
// whatever is assigned here so each test can pick a role/response set
// without re-mocking the module.
let mockImpl;

vi.mock('@hcaptcha/react-hcaptcha', () => ({
  default: () => <div data-testid="hcaptcha-stub">CAPTCHA widget</div>,
}));

function renderWithProviders(ui, { route = '/', path = '/' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>
        <Routes>
          <Route path={path} element={ui} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

async function expectNoA11yViolations(container) {
  const results = await axe(container);
  expect(results).toHaveNoViolations();
}

beforeEach(() => {
  mockImpl = buildAxiosMock({ role: roleRef.current });
});

describe('Public / auth pages', () => {
  it('Login page (inside AuthLayout) has no axe violations', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route element={<AuthLayout />}>
              <Route path="/login" element={<Login />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
    await screen.findAllByText(/Log in/i);
    await expectNoA11yViolations(container);
  });

  it('Register page has no axe violations', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/register']}>
        <Register />
      </MemoryRouter>
    );
    await screen.findByRole('heading', { name: 'Register' });
    await expectNoA11yViolations(container);
  });

  it('ForgotPassword page has no axe violations', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/forgot-password']}>
        <ForgotPassword />
      </MemoryRouter>
    );
    await screen.findByText('Forgot password');
    await expectNoA11yViolations(container);
  });

  it('ResetPassword page has no axe violations', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/reset-password/abc123']}>
        <Routes>
          <Route path="/reset-password/:token" element={<ResetPassword />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole('heading', { name: 'Reset password' });
    await expectNoA11yViolations(container);
  });

  it('MfaSetup page has no axe violations (form state)', async () => {
    mockImpl.post = vi.fn(() =>
      Promise.resolve({ data: { otpauthUrl: 'otpauth://totp/test', qrCodeDataUrl: 'data:image/png;base64,AA==' } })
    );
    const { container } = render(
      <MemoryRouter initialEntries={['/mfa-setup']}>
        <MfaSetup />
      </MemoryRouter>
    );
    await screen.findByText(/Set up two-factor authentication/i);
    await expectNoA11yViolations(container);
  });
});

describe('Member pages', () => {
  it('Catalog page has no axe violations', async () => {
    const { container } = renderWithProviders(<Catalog />, { route: '/catalog', path: '/catalog' });
    await screen.findByText('Catalog');
    await waitFor(() => expect(screen.queryByText(/Loading catalog/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('LoanRequestForm page has no axe violations', async () => {
    const { container } = renderWithProviders(<LoanRequestForm />, {
      route: '/loans/new?bookId=book-1',
      path: '/loans/new',
    });
    await screen.findByText('Request a loan');
    await waitFor(() => expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('MyLoans page has no axe violations', async () => {
    const { container } = renderWithProviders(<MyLoans />, { route: '/my-loans', path: '/my-loans' });
    await waitFor(() => expect(screen.queryByText(/Loading your loans/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('MyWaitlist page has no axe violations', async () => {
    const { container } = renderWithProviders(<MyWaitlist />, { route: '/my-waitlist', path: '/my-waitlist' });
    await waitFor(() => expect(screen.queryByText(/Loading your waitlist/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('Profile page has no axe violations', async () => {
    const { container } = renderWithProviders(<Profile />, { route: '/profile', path: '/profile' });
    await waitFor(() => expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('AppShell (member nav) has no axe violations', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/catalog']}>
        <AuthProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/catalog" element={<Catalog />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.queryByText(/Loading catalog/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('ConfirmDialog (open state) has no axe violations', async () => {
    const { container } = render(
      <ConfirmDialog
        open
        title="Log out?"
        message="You'll need to sign in again to access your account."
        confirmLabel="Log out"
        cancelLabel="Stay signed in"
        tone="danger"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    await expectNoA11yViolations(container);
  });
});

describe('Librarian pages', () => {
  beforeEach(() => {
    roleRef.current = 'librarian';
    mockImpl = buildAxiosMock({ role: 'librarian' });
  });

  it('Dashboard page has no axe violations', async () => {
    const { container } = renderWithProviders(<Dashboard />, { route: '/librarian', path: '/librarian' });
    await waitFor(() => expect(screen.queryByText(/Loading dashboard/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('CatalogManager page has no axe violations', async () => {
    const { container } = renderWithProviders(<CatalogManager />, {
      route: '/librarian/catalog',
      path: '/librarian/catalog',
    });
    await waitFor(() => expect(screen.queryByText(/Loading titles/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('LoanApprovals page has no axe violations', async () => {
    const { container } = renderWithProviders(<LoanApprovals />, {
      route: '/librarian/loans',
      path: '/librarian/loans',
    });
    await waitFor(() => expect(screen.queryByText(/Loading loans/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('WaitlistManager page has no axe violations', async () => {
    const { container } = renderWithProviders(<WaitlistManager />, {
      route: '/librarian/waitlist',
      path: '/librarian/waitlist',
    });
    await waitFor(() => expect(screen.queryByText(/Loading titles/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('AuditLogViewer page has no axe violations', async () => {
    const { container } = renderWithProviders(<AuditLogViewer />, {
      route: '/librarian/audit-logs',
      path: '/librarian/audit-logs',
    });
    await waitFor(() => expect(screen.queryByText(/Loading audit log/i)).not.toBeInTheDocument());
    await expectNoA11yViolations(container);
  });
});
