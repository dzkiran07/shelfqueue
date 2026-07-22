const express = require('express');
const loanController = require('../controllers/loan.controller');
const { requireAuth } = require('../middleware/auth');
const { requireOwnership } = require('../middleware/ownership');
const Loan = require('../models/Loan');

const router = express.Router();

const requireLoanOwnership = requireOwnership(Loan, 'id', 'memberId');

router.post('/', requireAuth, loanController.createLoan);
router.get('/me', requireAuth, loanController.getMyLoans);

router.get('/:id', requireAuth, requireLoanOwnership, loanController.getLoan);
router.patch('/:id', requireAuth, requireLoanOwnership, loanController.updateLoan);
router.delete('/:id', requireAuth, requireLoanOwnership, loanController.cancelLoan);

module.exports = router;
