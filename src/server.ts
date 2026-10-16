/**
 * Point d'entrée.
 *
 * Un seul service sert l'API, les fichiers et l'interface — c'est ce qui
 * permet un déploiement Render en un service au lieu de trois, et ce qui
 * supprime toute question de CORS.
 *
 * Le worker tourne dans le même processus par défaut. Quand le volume
 * l'exigera, RUN_WORKER_IN_PROCESS=false et un service séparé suffisent :
 * rien d'autre ne change.
 */
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { join } from 'path';
import { existsSync } from 'fs';
import { config, isProd, enabled } from './config';
import { healthy, withLock, query } from './db';
import { api, files } from './routes';
import { AppError } from './lib/errors';
import { purgeOld } from './lib/ratelimit';
import { ledger } from './ledger';
import { payments } from './payments';
import { generation, onAttemptsExhausted } from './generation';
import { queue } from './queue';
import { storageDriver } from './storage';
import { registry } from './providers';

const app = express();

// Render place un proxy devant : sans ceci, toutes les requêtes semblent
// venir de la même IP et la limitation de débit devient inopérante.
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ---------------------------------------------------------------------------
app.get('/healthz', async (_req, res) => {
  const db = await healthy();
  res.status(db ? 200 : 503).json({
    status: db ? 'ok' : 'degraded',
    db,
    file: queue.kind,
    stockage: storageDriver,
    paiementCarte: payments.railAvailable,
    fournisseurs: registry.status().map((p) => p.name),
    version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'local',
  });
});

app.use('/api', api);
app.use('/files', files);

// Interface : fichiers statiques, puis repli sur index.html pour que les
// routes côté client fonctionnent au rechargement.
//
// Le chemin est résolu depuis le dossier de lancement, pas depuis __dirname :
// une fois compilé, __dirname vaut dist/src et viserait dist/public, qui
// n'existe pas. On garde un repli sur __dirname au cas où le processus
// serait lancé depuis un autre dossier.
const PUBLIC = [
  join(process.cwd(), 'public'),
  join(__dirname, '..', 'public'),
  join(__dirname, '..', '..', 'public'),
].find((p) => existsSync(join(p, 'index.html')));

if (!PUBLIC) {
  console.error("Dossier public/ introuvable — l'interface ne sera pas servie");
}
if (PUBLIC) {
  app.use(express.static(PUBLIC, { maxAge: isProd ? '1h' : 0, index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/files')) return next();
    res.sendFile(join(PUBLIC, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// Gestionnaire d'erreurs unique
// ---------------------------------------------------------------------------
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: err.code, message: err.message, ...(err.detail ?? {}),
    });
  }
  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'too_large',
      message: `Fichier trop volumineux (max ${config.MAX_UPLOAD_MB} Mo)`,
    });
  }
  console.error('[erreur]', req.method, req.path, err?.message ?? err);
  res.status(500).json({
    error: 'internal',
    message: 'Une erreur interne est survenue',
    ...(isProd ? {} : { detail: String(err?.message ?? err) }),
  });
});

// ---------------------------------------------------------------------------
// Worker et tâches planifiées
// ---------------------------------------------------------------------------
function startWorker() {
  queue.process(async (jobId) => generation.process(jobId));
  (queue as any).onAttemptsExhausted?.(onAttemptsExhausted);
  console.log(`[worker] démarré (file ${queue.kind}, ${config.WORKER_CONCURRENCY} en parallèle)`);
}

/**
 * Les tâches périodiques passent par un verrou consultatif Postgres :
 * si Render démarre plusieurs instances, une seule exécute le travail.
 */
function startCron() {
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    const t = setInterval(() => {
      withLock(name, fn).catch((e) => console.error(`[cron ${name}]`, e.message));
    }, ms);
    t.unref?.();
  };

  every(60_000, 'expire-holds', async () => {
    const n = await ledger.expireStaleHolds();
    if (n) console.log(`[cron] ${n} réservation(s) expirée(s) rendue(s)`);
  });

  every(300_000, 'reconcile-payments', async () => {
    const n = await payments.reconcilePending();
    if (n) console.log(`[cron] ${n} paiement(s) rattrapé(s)`);
  });

  every(3_600_000, 'purge-rate', async () => { await purgeOld(); });

  every(3_600_000, 'audit-ledger', async () => {
    const gaps = await ledger.auditAll();
    if (gaps.length) {
      console.error(`[ALERTE] ${gaps.length} compte(s) en écart comptable`, gaps);
    }
  });
}

// ---------------------------------------------------------------------------
async function main() {
  if (!(await healthy())) {
    console.error('Base de données injoignable — vérifiez DATABASE_URL');
    process.exit(1);
  }

  if (config.RUN_WORKER_IN_PROCESS) startWorker();
  startCron();

  const server = app.listen(config.PORT, () => {
    console.log(`\n  Atelier démarré sur le port ${config.PORT}`);
    console.log(`  environnement  ${config.NODE_ENV}`);
    console.log(`  file           ${queue.kind}`);
    console.log(`  stockage       ${storageDriver}`);
    console.log(`  fournisseurs   ${registry.status().map((p) => p.name).join(', ')}`);
    console.log(`  paiement carte ${payments.railAvailable ? 'configuré' : 'non configuré'}`);
    if (!enabled.byteplus && !enabled.anthropic) {
      console.log('\n  Aucune clé fournisseur : le mode démonstration est actif.');
      console.log('  Toute la chaîne est testable, les rendus sont des images témoins.\n');
    }
  });

  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] arrêt en cours…`);
    server.close();
    await queue.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => { console.error(e); process.exit(1); });
