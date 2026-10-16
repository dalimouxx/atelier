/**
 * Authentification : inscription, connexion, session, rôles.
 *
 * Le jeton vit dans un cookie httpOnly — inaccessible au JavaScript, donc
 * à l'abri d'un vol par injection de script. L'en-tête Authorization reste
 * accepté pour les appels serveur à serveur.
 */
import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';
import { config, isProd } from './config';
import { query, one, tx } from './db';
import { Err } from './lib/errors';
import { consume, recordFailure, countRecent, clear, clientIp } from './lib/ratelimit';
import { ledger } from './ledger';

export interface Ctx {
  userId: string;
  workspaceId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  isPlatformAdmin: boolean;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { ctx?: Ctx }
  }
}

const COOKIE = 'atelier_session';
const SESSION_DAYS = 30;

const LOGIN_LIMIT = { bucket: 'login', max: 8, windowSeconds: 900 };
// Les opérateurs mobiles tunisiens partagent une même IP publique entre
// de nombreux abonnés (NAT à grande échelle). Une limite trop basse
// bloquerait des clients légitimes derrière la même connexion : un
// cybercafé, un bureau, un partage de connexion 4G.
const SIGNUP_LIMIT = { bucket: 'signup', max: 30, windowSeconds: 3600 };

function sign(userId: string, workspaceId: string) {
  return jwt.sign({ sub: userId, ws: workspaceId }, config.JWT_SECRET, {
    expiresIn: `${SESSION_DAYS}d`,
  });
}

function setCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 86_400_000,
    path: '/',
  });
}

function slugify(name: string): string {
  const base = name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'espace';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Inscription
// ---------------------------------------------------------------------------
export async function signup(opts: {
  email: string; password: string; name: string;
  workspaceName?: string; kind?: string; ip: string;
}) {
  const email = opts.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw Err.badInput('Adresse e-mail invalide');
  }
  if (opts.password.length < 8) {
    throw Err.badInput('Le mot de passe doit faire au moins 8 caractères');
  }
  if (!opts.name.trim()) throw Err.badInput('Le nom est obligatoire');

  const gate = await consume(SIGNUP_LIMIT, `ip:${opts.ip}`);
  if (!gate.ok) throw Err.rateLimited(gate.retryAfter);

  const exists = await one('SELECT 1 FROM users WHERE email=$1', [email]);
  if (exists) throw Err.conflict('Un compte existe déjà avec cette adresse');

  const hash = await bcrypt.hash(opts.password, 11);
  const wsName = (opts.workspaceName || opts.name).trim();

  const result = await tx(async (c) => {
    const u = await c.query(
      `INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3)
       RETURNING id, email, name, is_platform_admin`,
      [email, opts.name.trim(), hash],
    );
    const user = u.rows[0];

    const w = await c.query(
      `INSERT INTO workspaces (name, slug, kind) VALUES ($1,$2,$3) RETURNING id`,
      [wsName, slugify(wsName), opts.kind === 'agency' ? 'agency' : 'seller'],
    );
    const workspaceId = w.rows[0].id;

    await c.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1,$2,'owner')`,
      [workspaceId, user.id],
    );
    await c.query('INSERT INTO credit_accounts (workspace_id) VALUES ($1)',
      [workspaceId]);

    return { user, workspaceId };
  });

  // Crédits offerts : coût borné, et l'utilisateur voit la qualité tout de suite.
  if (config.SIGNUP_BONUS_CREDITS > 0) {
    await ledger.credit({
      workspaceId: result.workspaceId,
      amount: config.SIGNUP_BONUS_CREDITS,
      reason: 'signup_bonus',
      refType: 'workspace',
      refId: result.workspaceId,
      metadata: { note: 'crédits de bienvenue' },
    });
  }

  await audit(result.workspaceId, result.user.id, 'signup', null, {}, opts.ip);

  return {
    token: sign(result.user.id, result.workspaceId),
    user: {
      id: result.user.id, email: result.user.email, name: result.user.name,
      workspaceId: result.workspaceId, role: 'owner',
    },
  };
}

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------
export async function login(opts: { email: string; password: string; ip: string }) {
  const email = opts.email.trim().toLowerCase();

  // Le compteur est indexé sur l'adresse ET l'IP : un attaquant qui change
  // d'IP reste freiné par l'adresse visée, et inversement.
  const byEmail = await countRecent('login', `e:${email}`, LOGIN_LIMIT.windowSeconds);
  const byIp = await countRecent('login', `ip:${opts.ip}`, LOGIN_LIMIT.windowSeconds);
  if (byEmail >= LOGIN_LIMIT.max || byIp >= LOGIN_LIMIT.max * 3) {
    throw Err.rateLimited(900);
  }

  const user = await one<{
    id: string; email: string; name: string; password_hash: string;
    is_platform_admin: boolean;
  }>('SELECT id, email, name, password_hash, is_platform_admin FROM users WHERE email=$1',
     [email]);

  // Message identique que le compte existe ou non : ne pas révéler
  // quelles adresses sont inscrites.
  const fail = async () => {
    await recordFailure('login', `e:${email}`);
    await recordFailure('login', `ip:${opts.ip}`);
    throw Err.unauthorized('Adresse e-mail ou mot de passe incorrect');
  };

  if (!user) {
    // Hachage à vide quand même : sans cela, la différence de temps de
    // réponse révèle si l'adresse existe.
    await bcrypt.compare(opts.password, '$2a$11$' + 'x'.repeat(53));
    return fail();
  }

  const ok = await bcrypt.compare(opts.password, user.password_hash);
  if (!ok) return fail();

  const member = await one<{ workspace_id: string; role: Ctx['role'] }>(
    `SELECT workspace_id, role FROM workspace_members
      WHERE user_id=$1 ORDER BY created_at LIMIT 1`, [user.id],
  );
  if (!member) throw Err.forbidden("Aucun espace de travail associé à ce compte");

  await clear('login', `e:${email}`);
  await query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
  await audit(member.workspace_id, user.id, 'login', null, {}, opts.ip);

  return {
    token: sign(user.id, member.workspace_id),
    user: {
      id: user.id, email: user.email, name: user.name,
      workspaceId: member.workspace_id, role: member.role,
      isPlatformAdmin: user.is_platform_admin,
    },
  };
}

export async function changePassword(
  userId: string, current: string, next: string,
) {
  if (next.length < 8) throw Err.badInput('Le nouveau mot de passe doit faire au moins 8 caractères');
  const u = await one<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id=$1', [userId]);
  if (!u) throw Err.notFound('Compte introuvable');
  if (!(await bcrypt.compare(current, u.password_hash))) {
    throw Err.unauthorized('Mot de passe actuel incorrect');
  }
  await query('UPDATE users SET password_hash=$2 WHERE id=$1',
    [userId, await bcrypt.hash(next, 11)]);
}

// ---------------------------------------------------------------------------
// Réinitialisation du mot de passe
// ---------------------------------------------------------------------------
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function requestReset(email: string): Promise<string | null> {
  const user = await one<{ id: string }>(
    'SELECT id FROM users WHERE email=$1', [email.trim().toLowerCase()]);
  if (!user) return null; // silence volontaire

  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at)
     VALUES ($1,$2,'reset', now() + interval '1 hour')`,
    [user.id, hashToken(token)],
  );
  return token; // à transmettre par e-mail une fois l'envoi branché
}

export async function performReset(token: string, newPassword: string) {
  if (newPassword.length < 8) {
    throw Err.badInput('Le mot de passe doit faire au moins 8 caractères');
  }
  const row = await one<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM auth_tokens
      WHERE token_hash=$1 AND purpose='reset'
        AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) throw Err.badInput('Lien expiré ou déjà utilisé');

  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash=$2 WHERE id=$1',
      [row.user_id, await bcrypt.hash(newPassword, 11)]);
    await c.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [row.id]);
  });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
function readToken(req: Request): string | null {
  const cookie = req.cookies?.[COOKIE];
  if (cookie) return cookie;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export async function loadContext(req: Request): Promise<Ctx | null> {
  const token = readToken(req);
  if (!token) return null;

  let payload: { sub: string; ws: string };
  try {
    payload = jwt.verify(token, config.JWT_SECRET) as any;
  } catch {
    return null;
  }

  // On relit l'appartenance à chaque requête : un membre retiré de l'espace
  // perd l'accès immédiatement, sans attendre l'expiration du jeton.
  const row = await one<{
    role: Ctx['role']; email: string; name: string;
    is_platform_admin: boolean; ws_status: string;
  }>(
    `SELECT m.role, u.email, u.name, u.is_platform_admin, w.status AS ws_status
       FROM workspace_members m
       JOIN users u      ON u.id = m.user_id
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id=$1 AND m.workspace_id=$2`,
    [payload.sub, payload.ws],
  );
  if (!row || row.ws_status !== 'active') return null;

  return {
    userId: payload.sub,
    workspaceId: payload.ws,
    role: row.role,
    isPlatformAdmin: row.is_platform_admin,
    email: row.email,
    name: row.name,
  };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const ctx = await loadContext(req);
    if (!ctx) throw Err.unauthorized();
    req.ctx = ctx;
    next();
  } catch (e) { next(e); }
}

/** Les rôles sont hiérarchiques : owner ⊃ admin ⊃ member ⊃ viewer. */
const RANK: Record<Ctx['role'], number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export function requireRole(min: Ctx['role']) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx) return next(Err.unauthorized());
    if (RANK[req.ctx.role] < RANK[min]) {
      return next(Err.forbidden(`Action réservée au rôle ${min} ou supérieur`));
    }
    next();
  };
}

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.ctx) return next(Err.unauthorized());
  if (!req.ctx.isPlatformAdmin) return next(Err.forbidden('Accès réservé à la plateforme'));
  next();
}

export { COOKIE, setCookie, clientIp };

// ---------------------------------------------------------------------------
export async function audit(
  workspaceId: string | null, userId: string | null, action: string,
  target: string | null, detail: Record<string, unknown>, ip?: string,
) {
  try {
    await query(
      `INSERT INTO audit_log (workspace_id, user_id, action, target, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [workspaceId, userId, action, target, JSON.stringify(detail), ip ?? null],
    );
  } catch {
    // Le journal d'audit ne doit jamais faire échouer l'action elle-même.
  }
}
