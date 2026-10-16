/**
 * Runner de migrations. Applique les fichiers .sql dans l'ordre, une seule fois,
 * et les enregistre dans schema_migrations. Sûr à relancer.
 *
 *   npm run migrate          -- applique le schéma
 *   npm run seed             -- applique le schéma puis les données de départ
 *   npm run migrate -- --reset  -- supprime tout et recommence (dev uniquement)
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const DIR = __dirname;

async function main() {
  const reset = process.argv.includes('--reset');
  const seed = process.argv.includes('--seed');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');

  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('localhost') || url.includes('127.0.0.1') || url.includes('/tmp')
      ? false
      : { rejectUnauthorized: false },
  });

  if (reset) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('--reset est interdit en production');
    }
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('· schéma réinitialisé');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => (seed ? true : !f.includes('seed')))
    .sort();

  for (const file of files) {
    const isSeed = file.includes('seed');
    if (!isSeed) {
      const { rowCount } = await pool.query(
        'SELECT 1 FROM schema_migrations WHERE filename=$1', [file],
      );
      if (rowCount) { console.log(`· ${file} déjà appliqué`); continue; }
    }

    const sql = readFileSync(join(DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      if (!isSeed) {
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)', [file],
        );
      }
      await client.query('COMMIT');
      console.log(`✓ ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`✗ ${file}`);
      throw e;
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('migrations terminées');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
