import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from './config';

const local = /localhost|127\.0\.0\.1|\/tmp/.test(config.DATABASE_URL);

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 15,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Les bases managées (Render, Neon, Supabase) imposent TLS avec un
  // certificat que Node ne connaît pas ; en local on reste en clair.
  ssl: local ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] erreur client inactif:', err.message);
});

export async function query<T extends QueryResultRow = any>(
  text: string, params: unknown[] = [],
) {
  return pool.query<T>(text, params as any[]);
}

/** Première ligne, ou null. */
export async function one<T extends QueryResultRow = any>(
  text: string, params: unknown[] = [],
): Promise<T | null> {
  const r = await pool.query<T>(text, params as any[]);
  return r.rows[0] ?? null;
}

export async function many<T extends QueryResultRow = any>(
  text: string, params: unknown[] = [],
): Promise<T[]> {
  const r = await pool.query<T>(text, params as any[]);
  return r.rows;
}

/** Transaction avec ROLLBACK automatique sur exception. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Verrou consultatif Postgres : garantit qu'une tâche planifiée ne tourne
 * que sur une seule instance, même quand Render en démarre plusieurs.
 */
export async function withLock<T>(
  key: string, fn: () => Promise<T>,
): Promise<T | null> {
  const c = await pool.connect();
  try {
    const hash = [...key].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7);
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [hash]);
    if (!rows[0].ok) return null;
    try {
      return await fn();
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [hash]);
    }
  } finally {
    c.release();
  }
}

export async function healthy(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
