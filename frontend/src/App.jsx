import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './routes/ProtectedRoute.jsx';
import LibrarianRoute from './routes/LibrarianRoute.jsx';
import AppShell from './components/layout/AppShell.jsx';
import AuthLayout from './components/layout/AuthLayout.jsx';

import Register from './pages/member/Register.jsx';
import Login from './pages/member/Login.jsx';
import ForgotPassword from './pages/member/ForgotPassword.jsx';
import ResetPassword from './pages/member/ResetPassword.jsx';
import MfaSetup from './pages/member/MfaSetup.jsx';
import OAuthCallback from './pages/member/OAuthCallback.jsx';
import Catalog from './pages/member/Catalog.jsx';
import LoanRequestForm from './pages/member/LoanRequestForm.jsx';
import MyLoans from './pages/member/MyLoans.jsx';
import MyWaitlist from './pages/member/MyWaitlist.jsx';
import Profile from './pages/member/Profile.jsx';

import Dashboard from './pages/librarian/Dashboard.jsx';
import CatalogManager from './pages/librarian/CatalogManager.jsx';
import LoanApprovals from './pages/librarian/LoanApprovals.jsx';
import WaitlistManager from './pages/librarian/WaitlistManager.jsx';
import AuditLogViewer from './pages/librarian/AuditLogViewer.jsx';

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route element={<AuthLayout />}>
        <Route path="/register" element={<Register />} />
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password/:token" element={<ResetPassword />} />
        <Route path="/oauth/callback" element={<OAuthCallback />} />
      </Route>

      <Route element={<AppShell />}>
        {/* Member (any authenticated user) */}
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<Navigate to="/catalog" replace />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/loans/new" element={<LoanRequestForm />} />
          <Route path="/my-loans" element={<MyLoans />} />
          <Route path="/my-waitlist" element={<MyWaitlist />} />
          <Route path="/profile" element={<Profile />} />
          {/* Alias: the backend's Google-account-link flow redirects here by
              name (see googleLinkStart/googleCallback), so this path must
              exist regardless of what the nav calls the page. */}
          <Route path="/settings" element={<Profile />} />
          <Route path="/mfa-setup" element={<MfaSetup />} />
        </Route>

        {/* Librarian-only */}
        <Route path="/librarian" element={<LibrarianRoute />}>
          <Route index element={<Dashboard />} />
          <Route path="catalog" element={<CatalogManager />} />
          <Route path="loans" element={<LoanApprovals />} />
          <Route path="waitlist" element={<WaitlistManager />} />
          <Route path="audit-logs" element={<AuditLogViewer />} />
        </Route>
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
