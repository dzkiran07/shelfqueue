const express = require('express');
const bookController = require('../controllers/book.controller');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

const router = express.Router();

// Public/authenticated — catalog browsing doesn't require a session.
router.get('/', bookController.listBooks);
router.get('/:id', bookController.getBook);

router.post('/', requireAuth, requireRole('librarian'), bookController.createBook);
router.patch('/:id', requireAuth, requireRole('librarian'), bookController.updateBook);
router.delete('/:id', requireAuth, requireRole('librarian'), bookController.deleteBook);

module.exports = router;
