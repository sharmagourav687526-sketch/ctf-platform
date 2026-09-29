'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

let _transport = null;

function isConfigured() {
  return !!config.smtp.host;
}

function transport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return _transport;
}

async function send(to, subject, html) {
  if (!isConfigured()) return;
  await transport().sendMail({ from: config.smtp.from, to, subject, html });
}

function emailHtml(ctfName, heading, bodyHtml) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#222">
<h2 style="margin-bottom:4px">${heading}</h2>
<p style="color:#666;margin-top:4px">${ctfName}</p>
<hr style="border:none;border-top:1px solid #eee">
${bodyHtml}
<hr style="border:none;border-top:1px solid #eee">
<p style="color:#aaa;font-size:12px">If you didn't expect this email, you can safely ignore it.</p>
</body></html>`;
}

async function sendVerification(to, ctfName, token) {
  const url = `${config.appUrl}/verify-email?token=${token}`;
  await send(to, `Verify your email – ${ctfName}`, emailHtml(ctfName, 'Verify your email',
    `<p>Click the button below to verify your email address. This link expires in <strong>24 hours</strong>.</p>
     <p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#6c63ff;color:#fff;text-decoration:none;border-radius:4px">Verify email</a></p>
     <p style="color:#888;font-size:12px">Or copy this link: ${url}</p>`));
}

async function sendPasswordReset(to, ctfName, token) {
  const url = `${config.appUrl}/reset-password?token=${token}`;
  await send(to, `Password reset – ${ctfName}`, emailHtml(ctfName, 'Reset your password',
    `<p>Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
     <p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#6c63ff;color:#fff;text-decoration:none;border-radius:4px">Reset password</a></p>
     <p style="color:#888;font-size:12px">Or copy this link: ${url}</p>
     <p>If you didn't request a password reset, your account is safe — ignore this email.</p>`));
}

module.exports = { isConfigured, sendVerification, sendPasswordReset };
