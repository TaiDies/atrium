import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const uploadDir = path.join(dataDir, 'uploads');
mkdirSync(uploadDir, { recursive: true });

// Persist a generated secret so sessions survive restarts when JWT_SECRET is not set.
function loadSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, 'session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(48).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5432/atrium',
  sessionSecret: loadSecret(),
  dataDir,
  uploadDir,
  webDir: path.resolve(process.env.WEB_DIR ?? '../web/dist'),
  secureCookies: process.env.SECURE_COOKIES === 'true',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
  /** Largest export .zip that can be imported. */
  maxImportBytes: Number(process.env.MAX_IMPORT_MB ?? 1024) * 1024 * 1024,
  /**
   * Email (optional). With SMTP_HOST set, people can sign in and sign up with a code sent by email.
   * MAIL_TRANSPORT=log prints the emails to the server log instead (for trying it out).
   */
  mail: {
    transport: process.env.MAIL_TRANSPORT === 'log' ? ('log' as const) : process.env.SMTP_HOST ? ('smtp' as const) : null,
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@localhost',
  },
  /** New accounts must confirm their email with a code before they can use the app (needs email set up). */
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
  /** Shown in emails and to the apps when they connect. */
  appName: process.env.APP_NAME || 'Atrium',
  /**
   * The admin panel runs on its own port (keep it off the internet). Its password is ADMIN_PASSWORD,
   * or — when that isn't set — one made on first start, printed to the log and changeable in the panel.
   */
  admin: {
    port: Number(process.env.ADMIN_PORT || 3001),
    host: process.env.ADMIN_HOST || process.env.HOST || '0.0.0.0',
    password: process.env.ADMIN_PASSWORD || null,
    enabled: process.env.ADMIN_PANEL !== 'false',
  },
};
