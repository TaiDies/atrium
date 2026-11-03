import { one, query } from './db.js';

// Server-wide settings changed from the admin panel, kept in the database and cached briefly.

export interface ServerSettings {
  /** Whether new people can create accounts (the admin can always create them). */
  allowSignups: boolean;
  /** The admin panel's password (bcrypt). */
  adminPasswordHash: string | null;
  /** The AI connection the server offers everyone (its key is encrypted). */
  ai: SharedAi | null;
  /** Limits for everyone who has no limit of their own (see limits.ts). */
  defaultLimits: Limits;
  /** Email set up in the admin panel (wins over the SMTP_* environment settings). */
  mail: MailSettings | null;
  /** New accounts must confirm their email; null follows REQUIRE_EMAIL_VERIFICATION. */
  requireEmailVerification: boolean | null;
  /** New versions: who's emailed, whether the server updates itself, and what's been done (updates.ts). */
  updates: UpdateSettings;
}

export interface UpdateSettings {
  /** "Server notifications receiver email": told when a new version is out ('' for nobody). */
  email: string;
  auto: boolean;
  notifiedVersion?: string;
  autoUpdatedVersion?: string;
}

/** Each key: a number (the limit), null (unlimited); missing means "use the default". */
export interface Limits {
  workspaces?: number | null;
  storageMb?: number | null;
  uploadMb?: number | null;
  members?: number | null;
  aiRequestsPerDay?: number | null;
  aiRequestsPerMonth?: number | null;
  aiTokensPerDay?: number | null;
  aiTokensPerMonth?: number | null;
}

export interface MailSettings {
  host: string;
  port: number;
  /** true: TLS from the start (usually port 465); false: STARTTLS when offered (587). */
  secure: boolean;
  user: string;
  /** Encrypted. */
  passwordEnc: string | null;
  from: string;
}

export interface SharedAi {
  provider: string;
  model: string;
  baseUrl: string | null;
  keyEnc: string | null;
  /** When the server has its own connection: whether people may use theirs instead. */
  allowOwn: boolean;
}

const DEFAULTS: ServerSettings = { allowSignups: true, adminPasswordHash: null, ai: null, defaultLimits: {}, mail: null, requireEmailVerification: null, updates: { email: '', auto: false } };

let cache: { at: number; value: ServerSettings } | null = null;

export async function getSettings(): Promise<ServerSettings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const rows = await query<{ key: string; value: unknown }>('select key, value from settings');
  const value = { ...DEFAULTS } as Record<string, unknown>;
  for (const r of rows) if (r.key in DEFAULTS) value[r.key] = r.value;
  cache = { at: Date.now(), value: value as unknown as ServerSettings };
  return cache.value;
}

export async function setSetting<K extends keyof ServerSettings>(key: K, value: ServerSettings[K]) {
  await query(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  cache = null;
}

/** Whether a setting has ever been saved (e.g. the admin password). */
export async function hasSetting(key: keyof ServerSettings) {
  return !!(await one('select 1 from settings where key = $1', [key]));
}
