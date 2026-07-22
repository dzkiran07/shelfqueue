const express = require('express');
const adminController = require('../controllers/admin.controller');
const loanController = require('../controllers/loan.controller');
const waitlistController = require('../controllers/waitlist.controller');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

const router = express.Router();

const librarianOnly = [requireAuth, requireRole('librarian')];

router.patch('/users/:id/role', ...librarianOnly, adminController.updateUserRole);
router.get('/audit-logs', ...librarianOnly, adminController.listAuditLogs);

router.get('/alerts', ...librarianOnly, adminController.listAlerts);
router.patch('/alerts/:id/resolve', ...librarianOnly, adminController.resolveAlert);

router.get('/loans', ...librarianOnly, loanController.adminListLoans);
router.patch('/loans/:id/approve', ...librarianOnly, loanController.approve);
router.patch('/loans/:id/reject', ...librarianOnly, loanController.reject);
router.patch('/loans/:id/mark-checked-out', ...librarianOnly, loanController.markCheckedOut);
router.patch('/loans/:id/mark-returned', ...librarianOnly, loanController.markReturned);
router.patch('/loans/:id/mark-lost', ...librarianOnly, loanController.markLost);
router.patch('/loans/:id/mark-damaged', ...librarianOnly, loanController.markDamaged);

router.get('/waitlist', ...librarianOnly, waitlistController.adminListForBook);
router.post('/waitlist/offer-next', ...librarianOnly, waitlistController.adminOfferNext);
router.post('/waitlist/:id/skip', ...librarianOnly, waitlistController.adminSkipEntry);

module.exports = router;
