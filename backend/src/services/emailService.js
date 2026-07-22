const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../utils/logger');

let transporter;
let usingRealSmtp = false;

function getTransporter() {
  if (!transporter) {
    if (env.SMTP_HOST) {
      usingRealSmtp = true;
      transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASSWORD,
        },
      });
    } else {
      // No real SMTP configured — fall back to the Ethereal sandbox, which
      // never delivers to a real inbox but lets the flow be exercised via
      // getLastPreviewUrl() below.
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: env.ETHEREAL_EMAIL,
          pass: env.ETHEREAL_PASSWORD,
        },
      });
    }
  }
  return transporter;
}

// Dev/demo convenience only — Ethereal never delivers to a real inbox, so
// this is the only way to actually see and click a reset link locally or
// while filming the PoC video. Module-level and in-memory on purpose: it's
// not persisted anywhere, resets on restart, and is never exposed via the
// debug route in production (see auth.routes.js).
let lastPreviewUrl = null;

function getLastPreviewUrl() {
  return lastPreviewUrl;
}

async function send({ toEmail, subject, text, html, logLabel }) {
  const transport = getTransporter();
  const info = await transport.sendMail({
    from: usingRealSmtp ? `"ShelfQueue" <${env.SMTP_FROM}>` : '"ShelfQueue" <no-reply@shelfqueue.test>',
    to: toEmail,
    subject,
    text,
    html,
  });

  if (usingRealSmtp) {
    logger.info(`${logLabel} sent to ${toEmail}`);
    return { info, previewUrl: null };
  }

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    lastPreviewUrl = previewUrl;
    logger.info(`${logLabel} preview: ${previewUrl}`);
  }

  return { info, previewUrl };
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
  return send({
    toEmail,
    subject: 'Reset your ShelfQueue password',
    text: `Reset your password using the link below. This link expires in 15 minutes and can only be used once.\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
    html: `<p>Reset your password using the link below. This link expires in 15 minutes and can only be used once.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
    logLabel: 'Password reset email',
  });
}

// Notification emails — unlike the reset-password email above, these are
// genuinely optional and callers are expected to check
// user.notificationPreferences.email before sending either of these (see
// waitlistService.offerNextInQueue and loanService.sweepOverdueLoans).
async function sendWaitlistOfferEmail(toEmail, { bookTitle, expiresAt }) {
  const expiresLabel = expiresAt.toLocaleString();
  return send({
    toEmail,
    subject: `Your copy of "${bookTitle}" is ready`,
    text: `A copy of "${bookTitle}" is now available for you. Claim it from "My waitlist" by ${expiresLabel}, or it will be offered to the next person in line.`,
    html: `<p>A copy of <strong>${bookTitle}</strong> is now available for you.</p><p>Claim it from "My waitlist" by <strong>${expiresLabel}</strong>, or it will be offered to the next person in line.</p>`,
    logLabel: 'Waitlist offer email',
  });
}

async function sendLoanOverdueEmail(toEmail, { bookTitle, dueDate }) {
  const dueLabel = dueDate.toLocaleDateString();
  return send({
    toEmail,
    subject: `"${bookTitle}" is overdue`,
    text: `Your loan of "${bookTitle}" was due on ${dueLabel} and is now overdue. Please return it as soon as possible.`,
    html: `<p>Your loan of <strong>${bookTitle}</strong> was due on <strong>${dueLabel}</strong> and is now overdue.</p><p>Please return it as soon as possible.</p>`,
    logLabel: 'Loan overdue email',
  });
}

module.exports = {
  sendPasswordResetEmail,
  sendWaitlistOfferEmail,
  sendLoanOverdueEmail,
  getLastPreviewUrl,
  getTransporter,
};
