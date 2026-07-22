const { z } = require('zod');
const Loan = require('../models/Loan');

const ALLOWED_PROFILE_FIELDS = ['name', 'phone', 'notificationPreferences'];

function pick(obj, keys) {
  const result = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

// Only ever exposes fields a user should see about their own account —
// internal security bookkeeping (failedLoginAttempts, lockoutUntil,
// lockoutCount, passwordChangedAt) stays server-side. oauthProviders is
// reduced to just provider names (not Google's internal providerId) so the
// client can render "Google connected" state without seeing raw IDs.
function shapeUserForResponse(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone || null,
    notificationPreferences: user.notificationPreferences || { email: true },
    mfaEnabled: user.mfaEnabled,
    oauthProviders: (user.oauthProviders || []).map((p) => p.provider),
    status: user.status,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
  };
}

async function getMe(req, res) {
  return res.status(200).json({ user: shapeUserForResponse(req.user) });
}

async function updateMe(req, res, next) {
  try {
    const updates = pick(req.body || {}, ALLOWED_PROFILE_FIELDS);

    // Defense in depth on top of the allow-list itself: even if one of
    // these ever ended up in ALLOWED_PROFILE_FIELDS by accident in a
    // future edit, this line would still have to be deliberately removed
    // too before role/status/mfaEnabled/passwordHash could leak through —
    // never rely on a single point of failure for something this
    // sensitive. role changes have their own dedicated, audited endpoint
    // (PATCH /api/admin/users/:id/role) and never share a code path with
    // this one.
    delete updates.role;
    delete updates.status;
    delete updates.mfaEnabled;
    delete updates.passwordHash;

    if (updates.name !== undefined) {
      const trimmedName = String(updates.name).trim();
      if (!trimmedName || trimmedName.length > 100) {
        return res.status(400).json({ error: 'name must be between 1 and 100 characters' });
      }
      updates.name = trimmedName;
    }

    if (updates.phone !== undefined) {
      updates.phone = updates.phone === null ? undefined : String(updates.phone).trim();
    }

    if (updates.notificationPreferences !== undefined) {
      const prefs = updates.notificationPreferences;
      if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) {
        return res.status(400).json({ error: 'notificationPreferences must be an object' });
      }
      updates.notificationPreferences = { email: Boolean(prefs.email) };
    }

    Object.assign(req.user, updates);
    await req.user.save();

    return res.status(200).json({ user: shapeUserForResponse(req.user) });
  } catch (err) {
    return next(err);
  }
}

/**
 * DATA PORTABILITY (GET /me/export):
 * Maps to the "right to data portability" principle (e.g. GDPR Art. 20) —
 * giving the data subject their own personal data in a structured,
 * commonly-used, machine-readable format (plain JSON) so it can be
 * inspected, archived, or handed to another service independent of this
 * app. Only fields that are genuinely "this user's data" are included:
 * internal security state (passwordHash, passwordHistory,
 * mfaSecretEncrypted, failedLoginAttempts, lockoutUntil, lockoutCount) is
 * operational metadata about how the ACCOUNT is protected, not personal
 * data belonging to the user in the portability sense, so it's excluded —
 * same exclusions as shapeUserForResponse already applies for GET /me.
 * librarianNote on loans is also excluded: it's staff-internal commentary
 * ABOUT the member, not data the member authored or submitted themselves.
 */
async function exportMyData(req, res, next) {
  try {
    const loans = await Loan.find({ memberId: req.user._id }).sort({ requestedAt: -1 });

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      profile: shapeUserForResponse(req.user),
      loans: loans.map((loan) => ({
        id: loan._id,
        bookId: loan.bookId,
        status: loan.status,
        requestedAt: loan.requestedAt,
        dueDate: loan.dueDate,
        checkedOutAt: loan.checkedOutAt,
        returnedAt: loan.returnedAt,
        memberNote: loan.memberNote,
        conditionOnReturn: loan.conditionOnReturn,
      })),
    };

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="shelfqueue-export-${req.user._id}.json"`
    );
    return res.status(200).json(exportPayload);
  } catch (err) {
    return next(err);
  }
}

// Deliberately stricter than PATCH /me's pick()-based allow-list: .strict()
// makes zod REJECT the whole request if any field it doesn't recognize is
// present — at any level, including inside notificationPreferences — rather
// than silently dropping it. A portability feature that quietly ignored
// unrecognized fields would make it easy to miss that role/email/password/
// loans in a tampered (or naively re-uploaded, unmodified) export file were
// never actually being honored. The schema only recognizes the exact
// profile-preference shape this app can restore; it never lists id, email,
// role, status, or passwordHash as valid keys at all — there's no allow-
// list branch that could accidentally admit them.
const importProfileSchema = z
  .object({
    profile: z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        phone: z.string().trim().max(30).nullable().optional(),
        notificationPreferences: z.object({ email: z.boolean() }).strict().optional(),
      })
      .strict(),
  })
  .strict();

/**
 * DATA PORTABILITY (POST /me/import):
 * The other half of portability — receiving a previously exported file
 * back and having it mean something. Deliberately narrow in scope: only
 * profile PREFERENCES are restorable (name/phone/notification settings),
 * never loan history (that's a transactional record the library owns, not
 * something a user "recreates" by re-importing) and never identity/
 * security fields (email/role/password) — portability is about letting a
 * user reuse their own preference data, not a backdoor for re-establishing
 * account state through a less-guarded code path than the normal
 * authenticated write endpoints (registration, PATCH /me, the admin role
 * endpoint) already provide.
 */
async function importMyData(req, res, next) {
  const parsed = importProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid import payload',
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  try {
    const { profile } = parsed.data;

    if (profile.name !== undefined) {
      req.user.name = profile.name;
    }
    if (profile.phone !== undefined) {
      req.user.phone = profile.phone === null ? undefined : profile.phone;
    }
    if (profile.notificationPreferences !== undefined) {
      req.user.notificationPreferences = profile.notificationPreferences;
    }

    await req.user.save();

    return res.status(200).json({ user: shapeUserForResponse(req.user) });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getMe, updateMe, exportMyData, importMyData };
