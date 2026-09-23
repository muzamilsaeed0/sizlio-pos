const express = require('express');
const router = express.Router();
const { authMiddleware, authorize } = require('../middleware/authMiddleware');
const userController = require('../controllers/userController');

router.get('/', authMiddleware, authorize('manager'), userController.getStaff);
router.post('/', authMiddleware, authorize('manager', 'super_admin'), userController.addStaff);
router.put('/:id', authMiddleware, authorize('manager'), userController.editStaff);
router.patch('/:id/deactivate', authMiddleware, authorize('manager'), userController.deactivateStaff);
router.patch('/:id/activate', authMiddleware, authorize('manager'), userController.activateStaff);

module.exports = router;