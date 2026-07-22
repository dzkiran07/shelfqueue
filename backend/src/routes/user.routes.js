const express = require('express');
const userController = require('../controllers/user.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/me', requireAuth, userController.getMe);
router.patch('/me', requireAuth, userController.updateMe);
router.get('/me/export', requireAuth, userController.exportMyData);
router.post('/me/import', requireAuth, userController.importMyData);

module.exports = router;
