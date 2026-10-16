/**
 * Surface HTTP. Les routes restent minces : elles valident, délèguent au
 * service concerné, et rendent du JSON. Aucune logique métier ici.
 */
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { randomUUID } from 'crypto';
import { config } from './config';
import { query, one, many } from './db';
import {
  signup, login, changePassword, requestReset, performReset,
  requireAuth, requireRole, requirePlatformAdmin, setCookie, COOKIE, audit,
} from './auth';
import { clientIp, rateLimit } from './lib/ratelimit';
import { ledger } from './ledger';
import { generation } from './generation';
import { batch } from './batch';
import { payments } from './payments';
import { storage, keyFor, verifyFileToken, storageDriver } from './storage';
import { moderation } from './moderation';
import { registry, invalidateCostBook } from './providers';
import { queue } from './queue';
import { Err } from './lib/errors';
import { requireUuid } from './lib/validate';

export const api = Router();

/** Enveloppe async : toute exception part vers le gestionnaire d'erreurs. */
const h = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 5 },
});

// ===========================================================================
// Authentification
// ===========================================================================
api.post('/auth/signup', h(async (req, res) => {
  const { email, password, name, workspaceName, kind } = req.body ?? {};
  const out = await signup({
    email: String(email ?? ''), password: String(password ?? ''),
    name: String(name ?? ''), workspaceName, kind, ip: clientIp(req),
  });
  setCookie(res, out.token);
  res.status(201).json({ user: out.user });
}));

api.post('/auth/login', h(async (req, res) => {
  const { email, password } = req.body ?? {};
  const out = await login({
    email: String(email ?? ''), password: String(password ?? ''), ip: clientIp(req),
  });
  setCookie(res, out.token);
  res.json({ user: out.user });
}));

api.post('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

api.get('/auth/me', requireAuth, h(async (req, res) => {
  const balance = await ledger.getBalance(req.ctx!.workspaceId);
  const ws = await one('SELECT name, kind, slug FROM workspaces WHERE id=$1',
    [req.ctx!.workspaceId]);
  res.json({
    user: {
      id: req.ctx!.userId, email: req.ctx!.email, name: req.ctx!.name,
      role: req.ctx!.role, isPlatformAdmin: req.ctx!.isPlatformAdmin,
    },
    workspace: { id: req.ctx!.workspaceId, ...(ws as object) },
    balance,
  });
}));

api.post('/auth/password', requireAuth, h(async (req, res) => {
  await changePassword(req.ctx!.userId,
    String(req.body?.current ?? ''), String(req.body?.next ?? ''));
  res.json({ ok: true });
}));

api.post('/auth/forgot',
  rateLimit({ bucket: 'forgot', max: 5, windowSeconds: 3600 }),
  h(async (req, res) => {
    const token = await requestReset(String(req.body?.email ?? ''));
    // Réponse identique que le compte existe ou non.
    res.json({
      ok: true,
      // Tant que l'envoi d'e-mail n'est pas branché, le jeton est rendu
      // en développement pour pouvoir tester le parcours.
      ...(token && config.NODE_ENV !== 'production' ? { devToken: token } : {}),
    });
  }));

api.post('/auth/reset', h(async (req, res) => {
  await performReset(String(req.body?.token ?? ''), String(req.body?.password ?? ''));
  res.json({ ok: true });
}));

// ===========================================================================
// Catalogue
// ===========================================================================
api.get('/apps', h(async (_req, res) => {
  const apps = await many(
    `SELECT id, title, description, category, modality, input_schema,
            credit_cost, est_seconds
       FROM ai_apps WHERE status='live' ORDER BY sort_order, id`,
  );
  res.json(apps);
}));

api.get('/apps/:id', h(async (req, res) => {
  const app = await one(
    `SELECT id, title, description, category, modality, input_schema,
            credit_cost, est_seconds FROM ai_apps WHERE id=$1 AND status='live'`,
    [req.params.id],
  );
  if (!app) throw Err.notFound('Application introuvable');
  res.json(app);
}));

// ===========================================================================
// Envoi de fichiers
// ===========================================================================
api.post('/uploads', requireAuth,
  rateLimit({ bucket: 'upload', max: 120, windowSeconds: 3600 }, 'workspace'),
  upload.array('files', 5),
  h(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw Err.badInput('Aucun fichier reçu');

    const out = [];
    for (const f of files) {
      const verdict = await moderation.checkUpload(f.mimetype, f.size);
      if (!verdict.allowed) throw Err.badInput(verdict.reason!);

      const stored = await storage.put(
        keyFor(req.ctx!.workspaceId, 'in', f.mimetype), f.buffer, f.mimetype);

      const asset = await one<{ id: string }>(
        `INSERT INTO assets
           (workspace_id, kind, storage_key, mime, bytes, sha256, label)
         VALUES ($1,'upload',$2,$3,$4,$5,$6) RETURNING id`,
        [req.ctx!.workspaceId, stored.key, stored.mime, stored.bytes,
         stored.sha256, f.originalname?.slice(0, 120) ?? null],
      );

      out.push({
        id: asset!.id,
        url: await storage.signedUrl(stored.key, 3600),
        mime: stored.mime, bytes: stored.bytes,
        name: f.originalname,
      });
    }
    res.status(201).json({ assets: out });
  }));

// ===========================================================================
// Génération
// ===========================================================================
api.post('/generate', requireAuth, requireRole('member'),
  rateLimit({ bucket: 'generate', max: 240, windowSeconds: 3600 }, 'workspace'),
  h(async (req, res) => {
    const out = await generation.submit({
      workspaceId: req.ctx!.workspaceId,
      userId: req.ctx!.userId,
      appId: String(req.body?.appId ?? ''),
      inputs: req.body?.inputs ?? {},
      brandKitId: req.body?.brandKitId || undefined,
    });
    res.status(202).json(out);
  }));

api.get('/jobs/:id', requireAuth, h(async (req, res) => {
  res.json(await generation.get(
    requireUuid(req.params.id, 'identifiant de travail'), req.ctx!.workspaceId));
}));

api.post('/jobs/:id/cancel', requireAuth, requireRole('member'), h(async (req, res) => {
  await generation.cancel(requireUuid(req.params.id), req.ctx!.workspaceId);
  res.json({ ok: true });
}));

api.get('/jobs', requireAuth, h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 24), 100);
  res.json(await generation.recent(req.ctx!.workspaceId, limit));
}));

// ===========================================================================
// Production en lot
// ===========================================================================
api.post('/batches/parse', requireAuth, requireRole('member'),
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) throw Err.badInput('Aucun fichier reçu');
    const { columns, rows } = batch.parseCsv(req.file.buffer);
    res.json({ columns, rowCount: rows.length, preview: rows.slice(0, 5), rows });
  }));

api.post('/batches', requireAuth, requireRole('member'), h(async (req, res) => {
  const { appId, label, rows, mapping, fixed, brandKitId } = req.body ?? {};
  if (!Array.isArray(rows) || !rows.length) throw Err.badInput('Aucune ligne à traiter');
  if (rows.length > config.MAX_BATCH_ROWS) {
    throw Err.badInput(`Maximum ${config.MAX_BATCH_ROWS} lignes par lot`);
  }
  res.status(202).json(await batch.start({
    workspaceId: req.ctx!.workspaceId, userId: req.ctx!.userId,
    appId: String(appId ?? ''), label: String(label ?? 'Lot sans nom'),
    rows, mapping: mapping ?? {}, fixed: fixed ?? {}, brandKitId,
  }));
}));

api.get('/batches', requireAuth, h(async (req, res) => {
  res.json(await batch.list(req.ctx!.workspaceId));
}));

api.get('/batches/:id', requireAuth, h(async (req, res) => {
  res.json(await batch.status(requireUuid(req.params.id), req.ctx!.workspaceId));
}));

api.post('/batches/:id/retry', requireAuth, requireRole('member'), h(async (req, res) => {
  res.json(await batch.retryFailed(
    requireUuid(req.params.id), req.ctx!.workspaceId, req.ctx!.userId));
}));

api.post('/batches/:id/resume', requireAuth, requireRole('member'), h(async (req, res) => {
  res.json(await batch.resume(requireUuid(req.params.id), req.ctx!.workspaceId));
}));

api.post('/batches/:id/cancel', requireAuth, requireRole('member'), h(async (req, res) => {
  res.json(await batch.cancel(requireUuid(req.params.id), req.ctx!.workspaceId));
}));

/** Export ZIP d'un lot — flux direct, sans fichier temporaire. */
api.get('/batches/:id/export', requireAuth, h(async (req, res) => {
  const batchId = requireUuid(req.params.id);
  const files = await batch.outputs(batchId, req.ctx!.workspaceId);
  if (!files.length) throw Err.notFound('Aucun fichier à exporter');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="lot-${batchId.slice(0, 8)}.zip"`);

  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', (e) => { res.destroy(e); });
  zip.pipe(res);

  const textes: string[] = [];
  for (const f of files) {
    const ext = f.mime?.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
    const name = `ligne-${String(f.row_index ?? 0).padStart(4, '0')}.${ext}`;
    try {
      zip.append(await storage.get(f.storage_key), { name });
    } catch { /* fichier manquant : on n'interrompt pas tout l'export */ }
    if (f.output_text) {
      textes.push(`--- ligne ${f.row_index} ---\n${f.output_text}\n`);
    }
  }
  if (textes.length) zip.append(textes.join('\n'), { name: 'textes.txt' });
  await zip.finalize();
}));

// ===========================================================================
// Bibliothèque
// ===========================================================================
api.get('/assets', requireAuth, h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 48), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const kind = req.query.kind ? String(req.query.kind) : null;

  const rows = await many<any>(
    `SELECT a.id, a.kind, a.storage_key, a.mime, a.bytes, a.label, a.created_at,
            j.app_id
       FROM assets a
       LEFT JOIN generation_jobs j ON j.id = a.job_id
      WHERE a.workspace_id=$1
        AND a.kind <> 'upload'
        AND ($2::text IS NULL OR a.kind = $2)
      ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
    [req.ctx!.workspaceId, kind, limit, offset],
  );

  res.json(await Promise.all(rows.map(async (a) => ({
    id: a.id, kind: a.kind, mime: a.mime, bytes: Number(a.bytes ?? 0),
    label: a.label, appId: a.app_id, createdAt: a.created_at,
    url: await storage.signedUrl(a.storage_key, 3600),
  }))));
}));

api.delete('/assets/:id', requireAuth, requireRole('member'), h(async (req, res) => {
  const a = await one<any>(
    'SELECT storage_key FROM assets WHERE id=$1 AND workspace_id=$2',
    [requireUuid(req.params.id), req.ctx!.workspaceId]);
  if (!a) throw Err.notFound('Fichier introuvable');

  await query('DELETE FROM assets WHERE id=$1', [req.params.id]);
  await storage.remove(a.storage_key).catch(() => {});
  res.json({ ok: true });
}));

// ===========================================================================
// Identité de marque
// ===========================================================================
api.get('/brands', requireAuth, h(async (req, res) => {
  res.json(await many(
    `SELECT id, name, palette, tone, is_default, created_at
       FROM brand_kits WHERE workspace_id=$1 ORDER BY is_default DESC, created_at`,
    [req.ctx!.workspaceId]));
}));

api.post('/brands', requireAuth, requireRole('member'), h(async (req, res) => {
  const { name, palette, tone, isDefault } = req.body ?? {};
  if (!String(name ?? '').trim()) throw Err.badInput('Le nom est obligatoire');

  if (isDefault) {
    await query('UPDATE brand_kits SET is_default=false WHERE workspace_id=$1',
      [req.ctx!.workspaceId]);
  }
  const b = await one(
    `INSERT INTO brand_kits (workspace_id, name, palette, tone, is_default)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, name, palette, tone, is_default`,
    [req.ctx!.workspaceId, String(name).trim(),
     JSON.stringify(Array.isArray(palette) ? palette.slice(0, 8) : []),
     tone ? String(tone).slice(0, 1000) : null, !!isDefault],
  );
  res.status(201).json(b);
}));

api.put('/brands/:id', requireAuth, requireRole('member'), h(async (req, res) => {
  const id = requireUuid(req.params.id);
  const { name, palette, tone, isDefault } = req.body ?? {};

  const exists = await one('SELECT 1 FROM brand_kits WHERE id=$1 AND workspace_id=$2',
    [id, req.ctx!.workspaceId]);
  if (!exists) throw Err.notFound('Identité introuvable');

  if (isDefault) {
    await query('UPDATE brand_kits SET is_default=false WHERE workspace_id=$1',
      [req.ctx!.workspaceId]);
  }
  const b = await one(
    `UPDATE brand_kits
        SET name=COALESCE($3,name), palette=COALESCE($4,palette),
            tone=COALESCE($5,tone), is_default=COALESCE($6,is_default)
      WHERE id=$1 AND workspace_id=$2
      RETURNING id, name, palette, tone, is_default`,
    [id, req.ctx!.workspaceId, name ? String(name).trim() : null,
     palette ? JSON.stringify(palette.slice(0, 8)) : null,
     tone !== undefined ? String(tone ?? '').slice(0, 1000) : null,
     isDefault === undefined ? null : !!isDefault],
  );
  res.json(b);
}));

api.delete('/brands/:id', requireAuth, requireRole('admin'), h(async (req, res) => {
  await query('DELETE FROM brand_kits WHERE id=$1 AND workspace_id=$2',
    [requireUuid(req.params.id), req.ctx!.workspaceId]);
  res.json({ ok: true });
}));

// ===========================================================================
// Crédits et paiement
// ===========================================================================
api.get('/credits', requireAuth, h(async (req, res) => {
  res.json(await ledger.getBalance(req.ctx!.workspaceId));
}));

api.get('/credits/history', requireAuth, h(async (req, res) => {
  const before = req.query.before ? Number(req.query.before) : undefined;
  res.json(await ledger.history(req.ctx!.workspaceId, 50, before));
}));

api.get('/packs', h(async (_req, res) => {
  res.json({ packs: await payments.packs(), railAvailable: payments.railAvailable });
}));

api.post('/credits/topup', requireAuth, requireRole('admin'),
  rateLimit({ bucket: 'topup', max: 10, windowSeconds: 3600 }, 'workspace'),
  h(async (req, res) => {
    res.json(await payments.startTopup({
      workspaceId: req.ctx!.workspaceId,
      userId: req.ctx!.userId,
      packId: String(req.body?.packId ?? ''),
      buyer: { email: req.ctx!.email, name: req.ctx!.name, phone: req.body?.phone },
      ip: clientIp(req),
    }));
  }));

api.get('/payments', requireAuth, h(async (req, res) => {
  res.json(await payments.history(req.ctx!.workspaceId));
}));

api.get('/payments/:id', requireAuth, h(async (req, res) => {
  res.json(await payments.refresh(requireUuid(req.params.id), req.ctx!.workspaceId));
}));

/**
 * Webhook Konnect. Toujours répondre 200 : un code d'erreur déclenche des
 * relances en cascade. Le contenu du corps n'est pas cru — settle()
 * réinterroge Konnect.
 */
api.post('/webhooks/konnect', h(async (req, res) => {
  const ref = String(req.query.payment_ref ?? req.body?.payment_ref ?? '');
  if (ref) await payments.settle(ref).catch((e) => console.error('[webhook]', e.message));
  res.json({ ok: true });
}));

// ===========================================================================
// Membres de l'espace de travail
// ===========================================================================
api.get('/members', requireAuth, h(async (req, res) => {
  res.json(await many(
    `SELECT u.id, u.email, u.name, m.role, m.created_at
       FROM workspace_members m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 ORDER BY m.created_at`,
    [req.ctx!.workspaceId]));
}));

api.put('/members/:id/role', requireAuth, requireRole('owner'), h(async (req, res) => {
  const role = String(req.body?.role ?? '');
  if (!['admin', 'member', 'viewer'].includes(role)) {
    throw Err.badInput('Rôle invalide');
  }
  if (req.params.id === req.ctx!.userId) {
    throw Err.badInput('Vous ne pouvez pas modifier votre propre rôle');
  }
  await query(
    'UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2',
    [req.ctx!.workspaceId, req.params.id, role]);
  res.json({ ok: true });
}));

// ===========================================================================
// Administration de la plateforme
// ===========================================================================
api.get('/admin/margin', requireAuth, requirePlatformAdmin, h(async (req, res) => {
  const days = Math.min(Number(req.query.days ?? 30), 365);

  const parApp = await many(
    `SELECT j.app_id,
            a.title ->> 'fr'                       AS titre,
            count(*)::int                          AS generations,
            count(*) FILTER (WHERE j.served_from_cache)::int AS depuis_cache,
            COALESCE(SUM(j.credit_cost),0)::int    AS credits_encaisses,
            COALESCE(SUM(j.cost_usd_micros),0)::bigint AS cout_micros
       FROM generation_jobs j
       JOIN ai_apps a ON a.id = j.app_id
      WHERE j.status='succeeded'
        AND j.created_at > now() - ($1 || ' days')::interval
      GROUP BY j.app_id, a.title
      ORDER BY cout_micros DESC`,
    [String(days)],
  );

  const totaux = await one(
    `SELECT COALESCE(SUM(credit_cost),0)::int AS credits,
            COALESCE(SUM(cost_usd_micros),0)::bigint AS cout_micros,
            count(*)::int AS generations,
            count(*) FILTER (WHERE served_from_cache)::int AS cache
       FROM generation_jobs
      WHERE status='succeeded' AND created_at > now() - ($1 || ' days')::interval`,
    [String(days)],
  );

  const ventes = await one(
    `SELECT COALESCE(SUM(credits),0)::int AS credits_vendus,
            COALESCE(SUM(amount_minor),0)::bigint AS encaisse_millimes
       FROM payments
      WHERE status='paid' AND created_at > now() - ($1 || ' days')::interval`,
    [String(days)],
  );

  res.json({ jours: days, parApp, totaux, ventes });
}));

api.get('/admin/health', requireAuth, requirePlatformAdmin, h(async (_req, res) => {
  res.json({
    fournisseurs: registry.status(),
    file: { type: queue.kind, ...(await queue.stats()) },
    stockage: storageDriver,
    paiementCarte: payments.railAvailable,
    ecartsLedger: await ledger.auditAll(),
  });
}));

api.post('/admin/credits/adjust', requireAuth, requirePlatformAdmin, h(async (req, res) => {
  const { workspaceId, amount, note } = req.body ?? {};
  await ledger.adjust({
    workspaceId: requireUuid(workspaceId, 'espace de travail'),
    amount: Number(amount), note: String(note ?? 'ajustement manuel'),
    by: req.ctx!.email,
  });
  await audit(workspaceId, req.ctx!.userId, 'credit_adjust', workspaceId,
    { amount, note }, clientIp(req));
  res.json({ ok: true, balance: await ledger.getBalance(workspaceId) });
}));

api.put('/admin/apps/:id', requireAuth, requirePlatformAdmin, h(async (req, res) => {
  const { credit_cost, status, sort_order } = req.body ?? {};
  const app = await one(
    `UPDATE ai_apps
        SET credit_cost = COALESCE($2, credit_cost),
            status      = COALESCE($3, status),
            sort_order  = COALESCE($4, sort_order),
            updated_at  = now()
      WHERE id=$1 RETURNING id, credit_cost, status, sort_order`,
    [req.params.id,
     credit_cost ? Number(credit_cost) : null,
     status ? String(status) : null,
     sort_order !== undefined ? Number(sort_order) : null],
  );
  if (!app) throw Err.notFound('Application introuvable');
  res.json(app);
}));

api.put('/admin/costs', requireAuth, requirePlatformAdmin, h(async (req, res) => {
  const { provider, model, unit, costUsdMicros } = req.body ?? {};
  await query(
    `INSERT INTO provider_costs (provider, model, unit, cost_usd_micros)
     VALUES ($1,$2,$3,$4)`,
    [String(provider), String(model), String(unit), Number(costUsdMicros)]);
  invalidateCostBook();
  res.json({ ok: true });
}));

// ===========================================================================
// Service des fichiers en mode stockage local
// ===========================================================================
export const files = Router();

files.get('/:key(*)', h(async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const token = String(req.query.t ?? '');
  if (!verifyFileToken(token, key)) throw Err.forbidden('Lien expiré ou invalide');

  try {
    const buf = await storage.get(key);
    const meta = await one<any>(
      'SELECT mime FROM assets WHERE storage_key=$1 LIMIT 1', [key]);
    res.setHeader('Content-Type', meta?.mime ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch {
    throw Err.notFound('Fichier introuvable');
  }
}));
