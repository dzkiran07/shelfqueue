const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const SecurityAlert = require('../models/SecurityAlert');
const { logActivity } = require('../middleware/auditLogger');

const VALID_ROLES = ['member', 'librarian'];

// Deliberately its own endpoint with its own explicit audit write — role
// changes never share a code path with general profile updates (Phase 15),
// specifically so this security-sensitive action can never be silently
// bundled into an otherwise-ordinary PATCH /api/users/me request.
async function updateUserRole(req, res, next) {
  try {
    const { id } = req.params;
    const { role } = req.body || {};

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const targetUser = await User.findById(id);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const previousRole = targetUser.role;
    targetUser.role = role;
    await targetUser.save();

    await logActivity({
      actorId: req.user._id,
      action: 'role_change',
      resourceType: 'User',
      resourceId: targetUser._id,
      req,
      metadata: { previousRole, newRole: role },
    });

    return res.status(200).json({
      user: { id: targetUser._id, role: targetUser.role, previousRole },
    });
  } catch (err) {
    return next(err);
  }
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

async function listAuditLogs(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_LIMIT, 1),
      MAX_PAGE_LIMIT
    );

    const filter = {};

    if (typeof req.query.action === 'string' && req.query.action.trim()) {
      filter.action = req.query.action.trim();
    }

    if (typeof req.query.actorId === 'string' && mongoose.Types.ObjectId.isValid(req.query.actorId)) {
      filter.actorId = req.query.actorId;
    }

    if (req.query.from || req.query.to) {
      filter.timestamp = {};
      if (req.query.from) {
        const fromDate = new Date(req.query.from);
        if (!Number.isNaN(fromDate.getTime())) {
          filter.timestamp.$gte = fromDate;
        }
      }
      if (req.query.to) {
        const toDate = new Date(req.query.to);
        if (!Number.isNaN(toDate.getTime())) {
          filter.timestamp.$lte = toDate;
        }
      }
      if (Object.keys(filter.timestamp).length === 0) {
        delete filter.timestamp;
      }
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    return res.status(200).json({
      logs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return next(err);
  }
}

async function listAlerts(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_LIMIT, 1),
      MAX_PAGE_LIMIT
    );

    const filter = {};
    if (req.query.resolved === 'true') {
      filter.resolved = true;
    } else if (req.query.resolved === 'false') {
      filter.resolved = false;
    }

    const [alerts, total] = await Promise.all([
      SecurityAlert.find(filter)
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      SecurityAlert.countDocuments(filter),
    ]);

    return res.status(200).json({
      alerts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return next(err);
  }
}

async function resolveAlert(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid alert id' });
    }

    const alert = await SecurityAlert.findByIdAndUpdate(
      id,
      { resolved: true, resolvedBy: req.user._id, resolvedAt: new Date() },
      { new: true }
    );

    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    await logActivity({
      actorId: req.user._id,
      action: 'security_alert_resolved',
      resourceType: 'SecurityAlert',
      resourceId: alert._id,
      req,
    });

    return res.status(200).json({ alert });
  } catch (err) {
    return next(err);
  }
}

module.exports = { updateUserRole, listAuditLogs, listAlerts, resolveAlert };
