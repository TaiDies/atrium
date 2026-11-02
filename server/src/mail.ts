import nodemailer, { type Transporter } from 'nodemailer';
import { decryptKey } from './ai.js';
import { config } from './config.js';
import { getSettings } from './settings.js';

// Sending email (sign-in codes, invitations). Set up in the admin panel, or with the SMTP_* settings;
// without either, email codes are simply not offered.

interface MailConfig {
  transport: 'smtp' | 'log' | null;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

/** The admin panel's email settings when there are some, otherwise the environment's. */
export async function mailConfig(): Promise<MailConfig> {
  const saved = (await getSettings()).mail;
  if (saved?.host) {
    return {
      transport: 'smtp',
      host: saved.host,
      port: saved.port,
      secure: saved.secure,
      user: saved.user,
      password: decryptKey(saved.passwordEnc) ?? '',
      from: saved.from || saved.user || config.mail.from,
    };
  }
  return { ...config.mail };
}

export const mailEnabled = async () => (await mailConfig()).transport !== null;

/** Whether new accounts must confirm their email: the admin panel's choice, else REQUIRE_EMAIL_VERIFICATION. */
export async function verificationRequired() {
  const setting = (await getSettings()).requireEmailVerification;
  return (setting ?? config.requireEmailVerification) && (await mailEnabled());
}

let cached: { key: string; transporter: Transporter } | null = null;

function transport(c: MailConfig): Transporter {
  const key = JSON.stringify(c);
  if (cached?.key === key) return cached.transporter;
  const transporter =
    c.transport === 'log'
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.password } : undefined });
  cached = { key, transporter };
  return transporter;
}

export async function sendMail(to: string, subject: string, text: string, html: string) {
  const c = await mailConfig();
  if (!c.transport) throw new Error('Email is not set up');
  const info = await transport(c).sendMail({ from: c.from, to, subject, text, html });
  if (c.transport === 'log') console.log(`[mail] to ${to}: ${subject}
${text}`);
  return info;
}

/** Checks a set of email settings by connecting and signing in (nothing is sent). */
export async function verifyMail(c: MailConfig) {
  await nodemailer
    .createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.password } : undefined, connectionTimeout: 10_000 })
    .verify();
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function codeEmail(code: string, purpose: 'login' | 'signup' | 'verify') {
  const what = purpose === 'login' ? 'sign in' : purpose === 'signup' ? 'create your account' : 'confirm your email';
  const subject = `${code} is your ${config.appName} code`;
  const text = `Your code to ${what} is ${code}.\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:24px auto;color:#222">
  <p>Your code to ${escape(what)}:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${escape(code)}</p>
  <p style="color:#666;font-size:14px">It works for 10 minutes. If you didn't ask for it, you can ignore this email.</p>
</div>`;
  return { subject, text, html };
}

export function inviteEmail(inviter: string, workspace: string) {
  const subject = `${inviter} invited you to ${workspace} on ${config.appName}`;
  const text = `${inviter} invited you to the workspace "${workspace}".\n\nSign in (or create an account with this email address) and open the bell to accept or decline.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:24px auto;color:#222">
  <p><b>${escape(inviter)}</b> invited you to the workspace <b>${escape(workspace)}</b>.</p>
  <p>Sign in (or create an account with this email address) and open the bell to accept or decline.</p>
</div>`;
  return { subject, text, html };
}
