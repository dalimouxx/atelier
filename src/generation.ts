/**
 * Moteur de génération.
 *
 * Déroulé d'un travail, dans cet ordre strict :
 *   1. validation des entrées contre le schéma de l'application
 *   2. résolution du prompt avec l'identité de marque
 *   3. modération — AVANT toute dépense
 *   4. cache de déduplication — si déjà produit, on sert sans appeler personne
 *   5. réservation des crédits — AVANT la mise en file
 *   6. exécution, sondage si asynchrone
 *   7. rapatriement des fichiers chez nous
 *   8. débit définitif
 *
 * En cas d'échec à n'importe quelle étape après la réservation, le gel est
 * rendu : le client ne paie jamais un rendu qu'il n'a pas reçu.
 */
import { createHash, randomUUID } from 'crypto';
import Mustache from 'mustache';
import { query, one, many } from './db';
import { config } from './config';
import { ledger } from './ledger';
import { storage, ingest, keyFor } from './storage';
import { moderation } from './moderation';
import { registry, costOf, Route, Modality, GenerateResult } from './providers';
import { validateInputs, InputSchema } from './lib/validate';
import { Err, AppError, RetryableError } from './lib/errors';
import { queue } from './queue';

export interface AppRow {
  id: string; version: number; modality: Modality; routes: Route[];
  input_schema: InputSchema; prompt_template: string;
  default_params: Record<string, unknown>; credit_cost: number;
  est_seconds: number; cacheable: boolean; title: any;
}

async function loadApp(appId: string): Promise<AppRow> {
  const app = await one<AppRow>(
    `SELECT * FROM ai_apps WHERE id=$1 AND status='live'`, [appId],
  );
  if (!app) throw Err.notFound(`Application « ${appId} » indisponible`);
  return app;
}

async function loadBrand(brandKitId: string | undefined, workspaceId: string) {
  if (!brandKitId) {
    return one(`SELECT * FROM brand_kits WHERE workspace_id=$1 AND is_default LIMIT 1`,
      [workspaceId]);
  }
  return one('SELECT * FROM brand_kits WHERE id=$1 AND workspace_id=$2',
    [brandKitId, workspaceId]);
}

/**
 * Les images d'entrée sont des identifiants d'assets. On vérifie qu'ils
 * appartiennent bien à l'espace de travail : sans ce contrôle, un
 * utilisateur pourrait désigner le fichier d'un autre client.
 */
async function resolveInputAssets(
  ids: string[], workspaceId: string,
): Promise<{ id: string; storage_key: string }[]> {
  if (!ids.length) return [];
  const rows = await many<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM assets
      WHERE id = ANY($1::uuid[]) AND workspace_id = $2`,
    [ids, workspaceId],
  );
  if (rows.length !== ids.length) {
    throw Err.badInput('Une des images sélectionnées est introuvable');
  }
  // On respecte l'ordre choisi par l'utilisateur.
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

function dedupKey(appId: string, version: number, prompt: string, params: unknown, images: string[]) {
  return createHash('sha256')
    .update(JSON.stringify([appId, version, prompt, params, images.sort()]))
    .digest('hex');
}

export interface SubmitOpts {
  workspaceId: string;
  userId: string;
  appId: string;
  inputs: Record<string, unknown>;
  brandKitId?: string;
  batchId?: string;
  rowIndex?: number;
}

export const generation = {
  /**
   * Point d'entrée public. Rend la main immédiatement ; le travail réel
   * se fait dans le worker.
   */
  async submit(opts: SubmitOpts) {
    const app = await loadApp(opts.appId);

    // 1. validation
    const inputs = validateInputs(app.input_schema, opts.inputs);

    // 2. prompt + marque
    const brand = await loadBrand(opts.brandKitId, opts.workspaceId);
    const imageIds = Array.isArray(inputs.images) ? (inputs.images as string[]) : [];
    const assets = await resolveInputAssets(imageIds, opts.workspaceId);

    const prompt = Mustache.render(app.prompt_template, {
      ...inputs,
      brand: brand
        ? {
            name: (brand as any).name,
            tone: (brand as any).tone,
            palette: Array.isArray((brand as any).palette)
              ? (brand as any).palette.join(', ') : '',
          }
        : {},
    }).trim();

    // 3. modération avant toute dépense
    const verdict = await moderation.checkPrompt(prompt);
    if (!verdict.allowed) throw Err.blocked(verdict.reason);

    const params = { ...app.default_params, ...(inputs.params as object ?? {}) };
    const key = app.cacheable && config.DEDUP_ENABLED
      ? dedupKey(app.id, app.version, prompt, params, assets.map((a) => a.id))
      : null;

    // 4. cache : une production identique déjà réussie est resservie
    if (key) {
      const hit = await one<{ id: string }>(
        `SELECT id FROM generation_jobs
          WHERE workspace_id=$1 AND dedup_key=$2 AND status='succeeded'
          ORDER BY created_at DESC LIMIT 1`,
        [opts.workspaceId, key],
      );
      if (hit) {
        const copy = await this.cloneFromCache(hit.id, opts);
        return { jobId: copy, status: 'succeeded', creditCost: 0, cached: true };
      }
    }

    const jobId = randomUUID();

    // 5. réservation AVANT la mise en file
    await ledger.reserve({
      workspaceId: opts.workspaceId,
      amount: app.credit_cost,
      refType: 'job',
      refId: jobId,
      ttlSeconds: Math.max(config.HOLD_TTL_SECONDS, app.est_seconds * 8),
    });

    try {
      await query(
        `INSERT INTO generation_jobs
           (id, workspace_id, user_id, app_id, app_version, batch_id, row_index,
            inputs, resolved_prompt, dedup_key, credit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [jobId, opts.workspaceId, opts.userId, app.id, app.version,
         opts.batchId ?? null, opts.rowIndex ?? null,
         JSON.stringify({ ...inputs, _assets: assets.map((a) => a.id) }),
         prompt, key, app.credit_cost],
      );
      await queue.add(jobId);
    } catch (e) {
      await ledger.release('job', jobId); // rien ne reste gelé si l'insertion rate
      throw e;
    }

    return {
      jobId, status: 'queued', creditCost: app.credit_cost,
      estSeconds: app.est_seconds, cached: false,
    };
  },

  /** Recopie un travail déjà réussi : aucun appel fournisseur, aucun crédit. */
  async cloneFromCache(sourceJobId: string, opts: SubmitOpts): Promise<string> {
    const src = await one<any>('SELECT * FROM generation_jobs WHERE id=$1', [sourceJobId]);
    if (!src) throw Err.notFound('Travail source introuvable');

    const newId = randomUUID();
    await query(
      `INSERT INTO generation_jobs
         (id, workspace_id, user_id, app_id, app_version, batch_id, row_index,
          status, inputs, resolved_prompt, dedup_key, served_from_cache,
          provider, provider_model, credit_cost, cost_usd_micros, output_text,
          started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,$9,$10,true,$11,$12,0,0,$13,now(),now())`,
      [newId, opts.workspaceId, opts.userId, src.app_id, src.app_version,
       opts.batchId ?? null, opts.rowIndex ?? null,
       src.inputs, src.resolved_prompt, src.dedup_key,
       src.provider, src.provider_model, src.output_text],
    );

    // Les fichiers sont partagés, pas recopiés : même clé de stockage.
    const sourceAssets = await many<any>(
      'SELECT * FROM assets WHERE job_id=$1', [sourceJobId]);
    for (const a of sourceAssets) {
      await query(
        `INSERT INTO assets
           (workspace_id, job_id, kind, storage_key, mime, bytes, width, height,
            duration_ms, sha256, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [opts.workspaceId, newId, a.kind, a.storage_key, a.mime, a.bytes,
         a.width, a.height, a.duration_ms, a.sha256, a.label],
      );
    }
    return newId;
  },

  /** Exécution d'un travail. Appelée par le worker. */
  async process(jobId: string): Promise<void> {
    const job = await one<any>('SELECT * FROM generation_jobs WHERE id=$1', [jobId]);
    if (!job) return;

    // Travail déjà réussi : on s'assure seulement que le gel a bien été
    // soldé. Sans ce rattrapage, un incident survenu entre l'écriture du
    // statut et le débit laisserait des crédits gelés jusqu'à expiration.
    if (job.status === 'succeeded') {
      await ledger.commit({
        refType: 'job', refId: jobId,
        costUsdMicros: job.cost_usd_micros,
        metadata: { app_id: job.app_id, rattrapage: true },
      }).catch(() => {});
      return;
    }
    if (['cancelled', 'blocked'].includes(job.status)) return;

    const app = await loadApp(job.app_id);

    const route = registry.select(app.routes, app.modality)
      ?? registry.selectAny(app.routes, app.modality);
    if (!route) {
      return this.fail(jobId, 'no_provider',
        'Aucun fournisseur disponible pour cette application');
    }

    await query(
      `UPDATE generation_jobs
          SET status='running', started_at=COALESCE(started_at, now()),
              attempt=attempt+1, provider=$2, provider_model=$3
        WHERE id=$1`,
      [jobId, route.provider, route.model],
    );

    // URL temporaires des images d'entrée, pour que le fournisseur les lise.
    const assetIds: string[] = job.inputs?._assets ?? [];
    const assets = await resolveInputAssets(assetIds, job.workspace_id);
    const images = await Promise.all(
      assets.map((a) => storage.signedUrl(a.storage_key, 7200)),
    );

    const provider = registry.get(route.provider);
    let result: GenerateResult;

    try {
      result = await provider.submit({
        model: route.model,
        modality: app.modality,
        prompt: job.resolved_prompt,
        images,
        params: { ...app.default_params, ...(job.inputs?.params ?? {}) },
        jobId,
      });

      if (result.status === 'running' && provider.poll) {
        result = await this.pollUntilDone(provider, result.providerJobId!, app.est_seconds);
      }
    } catch (e: any) {
      registry.recordFailure(route.provider);
      throw new RetryableError('provider_exception', e.message);
    }

    if (result.status !== 'succeeded') {
      registry.recordFailure(route.provider);
      throw new RetryableError(result.errorCode ?? 'provider_failed', result.errorMessage);
    }

    registry.recordSuccess(route.provider);

    // 7. rapatriement : les URL fournisseur expirent, pas les nôtres
    const stored: string[] = [];
    for (const out of result.outputs ?? []) {
      try {
        const s = out.buffer
          ? await storage.put(
              keyFor(job.workspace_id, 'out', out.mime), out.buffer, out.mime)
          : await ingest(out.url!, job.workspace_id, 'out');

        await query(
          `INSERT INTO assets
             (workspace_id, job_id, kind, storage_key, mime, bytes, sha256, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [job.workspace_id, jobId, out.kind, s.key, s.mime, s.bytes, s.sha256,
           out.durationMs ?? null],
        );
        stored.push(s.key);
      } catch (e: any) {
        throw new RetryableError('ingest_failed', e.message);
      }
    }

    if (!stored.length && !result.text) {
      throw new RetryableError('empty_output', 'aucun fichier produit');
    }

    const costUsd = await costOf(route.provider, route.model, result.usage);

    await query(
      `UPDATE generation_jobs
          SET status='succeeded', finished_at=now(),
              cost_usd_micros=$2, provider_job_id=$3, output_text=$4
        WHERE id=$1`,
      [jobId, costUsd, result.providerJobId ?? null, result.text ?? null],
    );

    // 8. c'est seulement ici que le client paie
    await ledger.commit({
      refType: 'job', refId: jobId,
      costUsdMicros: costUsd,
      metadata: { app_id: job.app_id, provider: route.provider, model: route.model },
    });
  },

  async pollUntilDone(
    provider: any, providerJobId: string, estSeconds: number,
  ): Promise<GenerateResult> {
    const deadline = Date.now() + Math.max(180_000, estSeconds * 8_000);
    let delay = 2500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay));
      const r: GenerateResult = await provider.poll(providerJobId);
      if (r.status !== 'running') return r;
      delay = Math.min(Math.round(delay * 1.4), 15_000);
    }
    return { status: 'failed', errorCode: 'poll_timeout',
             errorMessage: 'le fournisseur a dépassé le délai' };
  },

  /** Échec définitif : on rend le gel. Le client n'est pas débité. */
  async fail(jobId: string, code: string, message?: string) {
    await query(
      `UPDATE generation_jobs
          SET status='failed', finished_at=now(), error_code=$2, error_message=$3
        WHERE id=$1 AND status NOT IN ('succeeded','cancelled')`,
      [jobId, code, message?.slice(0, 1000) ?? null],
    );
    await ledger.release('job', jobId);
  },

  async cancel(jobId: string, workspaceId: string) {
    const job = await one<any>(
      'SELECT status FROM generation_jobs WHERE id=$1 AND workspace_id=$2',
      [jobId, workspaceId]);
    if (!job) throw Err.notFound('Travail introuvable');
    if (job.status === 'succeeded') throw Err.conflict('Travail déjà terminé');

    await query(
      `UPDATE generation_jobs SET status='cancelled', finished_at=now()
        WHERE id=$1 AND status IN ('queued','running')`, [jobId]);
    await ledger.release('job', jobId);
  },

  /** Détail d'un travail, fichiers compris, avec URL temporaires. */
  async get(jobId: string, workspaceId: string) {
    const job = await one<any>(
      `SELECT id, app_id, status, credit_cost, served_from_cache, output_text,
              error_code, error_message, batch_id, row_index,
              created_at, started_at, finished_at, provider
         FROM generation_jobs WHERE id=$1 AND workspace_id=$2`,
      [jobId, workspaceId],
    );
    if (!job) throw Err.notFound('Travail introuvable');

    const assets = await many<any>(
      `SELECT id, kind, storage_key, mime, bytes, duration_ms
         FROM assets WHERE job_id=$1 ORDER BY created_at`, [jobId]);

    job.assets = await Promise.all(assets.map(async (a) => ({
      id: a.id, kind: a.kind, mime: a.mime, bytes: Number(a.bytes ?? 0),
      durationMs: a.duration_ms,
      url: await storage.signedUrl(a.storage_key, 3600),
    })));
    return job;
  },

  async recent(workspaceId: string, limit = 24) {
    const jobs = await many<any>(
      `SELECT j.id, j.app_id, j.status, j.credit_cost, j.served_from_cache,
              j.created_at, j.finished_at, j.error_code,
              a.title AS app_title
         FROM generation_jobs j
         JOIN ai_apps a ON a.id = j.app_id
        WHERE j.workspace_id=$1
        ORDER BY j.created_at DESC LIMIT $2`,
      [workspaceId, limit],
    );

    for (const j of jobs) {
      const asset = await one<any>(
        `SELECT storage_key, kind, mime FROM assets
          WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [j.id]);
      j.preview = asset ? await storage.signedUrl(asset.storage_key, 3600) : null;
      j.previewKind = asset?.kind ?? null;
    }
    return jobs;
  },
};

/** Branché par le worker : relie l'épuisement des tentatives au remboursement. */
export async function onAttemptsExhausted(jobId: string, code: string, msg: string) {
  await generation.fail(jobId, code, msg);
}

export { AppError };
