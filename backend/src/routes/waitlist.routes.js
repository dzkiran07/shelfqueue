const express = require('express');
const waitlistController = require('../controllers/waitlist.controller');
const { requireAuth } = require('../middleware/auth');
const { requireOwnership } = require('../middleware/ownership');
const Waitlist = require('../models/Waitlist');

const router = express.Router();

const requireWaitlistOwnership = requireOwnership(Waitlist, 'id', 'memberId');

router.post('/', requireAuth, waitlistController.joinWaitlist);
router.get('/me', requireAuth, waitlistController.getMyWaitlist);
router.post('/:id/claim', requireAuth, waitlistController.claimWaitlistOffer);
router.delete('/:id', requireAuth, requireWaitlistOwnership, waitlistController.leaveWaitlist);

module.exports = router;
