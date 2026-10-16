/**
 * Limitation de débit par fenêtre glissante, stockée en base.
 *
 * Pourquoi en base et pas en mémoire : Render peut faire tourner plusieurs
 * instances, et un compteur en mémoire se réinitialise à chaque
 * redéploiement. Une attaque par test de cartes exploite exactement ces
 * deux failles.
 */
import { Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { Err } from './errors';

export interface Limit {
  bucket: string;
  max: number;
  windowSeconds: number;
}

export async function consume(
  limit: Limit, subject: string,
): Promise<{ ok: boolean; retryAfter: number }> {
  const { rows } = await query(
    `SELECT count(*)::int AS n,
            COALESCE(EXTRACT(EPOCH FROM (
              MIN(created_at) + ($3 || ' seconds')::interval - now()
            )), 0)::int AS retry
       FROM rate_events
      WHERE bucket = $1 AND subject = $2
        AND created_at > now() - ($3 || ' seconds')::interval`,
    [limit.bucket, subject, String(limit.windowSeconds)],
  );

  const used = rows[0].n as number;
  if (used >= limit.max) {
    return { ok: false, retryAfter: Math.max(1, rows[0].retry as number) };
  }

  await query(
    'INSERT INTO rate_events (bucket, subject) VALUES ($1, $2)',
    [limit.bucket, subject],
  );
  return { ok: true, retryAfter: 0 };
}

/** Compte un échec sans consommer de quota de succès (ex. mot de passe faux). */
export async function recordFailure(bucket: string, subject: string) {
  await query('INSERT INTO rate_events (bucket, subject) VALUES ($1,$2)',
    [bucket, subject]);
}

export async function countRecent(
  bucket: string, subject: string, windowSeconds: number,
): Promise<number> {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM rate_events
      WHERE bucket=$1 AND subject=$2
        AND created_at > now() - ($3 || ' seconds')::interval`,
    [bucket, subject, String(windowSeconds)],
  );
  return rows[0].n;
}

export async function clear(bucket: string, subject: string) {
  await query('DELETE FROM rate_events WHERE bucket=$1 AND subject=$2',
    [bucket, subject]);
}

/** Purge des compteurs expirés — appelée par la tâche planifiée. */
export async function purgeOld() {
  const { rowCount } = await query(
    "DELETE FROM rate_events WHERE created_at < now() - interval '24 hours'",
  );
  return rowCount ?? 0;
}

/**
 * Middleware. `by` choisit le sujet compté : l'espace de travail quand
 * l'utilisateur est connecté, sinon l'adresse IP.
 */
export function rateLimit(limit: Limit, by: 'ip' | 'workspace' | 'user' = 'ip') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = (req as any).ctx;
      const subject =
        by === 'workspace' && ctx?.workspaceId ? `ws:${ctx.workspaceId}`
        : by === 'user' && ctx?.userId ? `u:${ctx.userId}`
        : `ip:${clientIp(req)}`;

      const r = await consume(limit, subject);
      if (!r.ok) {
        res.setHeader('Retry-After', String(r.retryAfter));
        throw Err.rateLimited(r.retryAfter);
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || 'inconnu';
}
