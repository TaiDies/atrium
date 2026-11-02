import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool,
): Promise<T[]> {
  const res = await client.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool,
): Promise<T | undefined> {
  return (await query<T>(text, params, client))[0];
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function waitForDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('select 1');
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`Waiting for database (attempt ${attempt})...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function migrate() {
  await waitForDatabase();
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  await pool.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  );
  const applied = new Set((await query<{ name: string }>('select name from schema_migrations')).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    console.log(`Applied migration ${file}`);
  }
}
