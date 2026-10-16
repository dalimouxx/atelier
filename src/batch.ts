/**
 * Production en lot.
 *
 * Un fichier CSV, une ligne par référence. Chaque ligne devient une
 * génération indépendante : si une ligne échoue, elle est remboursée seule
 * et les autres continuent.
 *
 * Le lot s'arrête de lui-même quand le solde ne suffit plus, au lieu de
 * creuser un découvert ou de multiplier les erreurs.
 */
import { parse } from 'csv-parse/sync';
import { query, one, many } from './db';
import { config } from './config';
import { generation } from './generation';
import { ledger } from './ledger';
import { storage } from './storage';
import { Err, AppError } from './lib/errors';

export interface BatchRow { [column: string]: string }

export const batch = {
  /** Lit un CSV et rend ses colonnes, pour que l'interface propose la correspondance. */
  parseCsv(buffer: Buffer): { columns: string[]; rows: BatchRow[] } {
    let rows: BatchRow[];
    try {
      rows = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
      });
    } catch (e: any) {
      throw Err.badInput(`Fichier CSV illisible : ${e.message}`);
    }

    if (!rows.length) throw Err.badInput('Le fichier ne contient aucune ligne');
    if (rows.length > config.MAX_BATCH_ROWS) {
      throw Err.badInput(
        `Le fichier contient ${rows.length} lignes, le maximum est ${config.MAX_BATCH_ROWS}`);
    }
    return { columns: Object.keys(rows[0]), rows };
  },

  /**
   * Lance un lot. `mapping` relie un champ de l'application à une colonne
   * du fichier ; `fixed` applique la même valeur à toutes les lignes.
   */
  async start(opts: {
    workspaceId: string; userId: string; appId: string; label: string;
    rows: BatchRow[];
    mapping: Record<string, string>;
    fixed?: Record<string, unknown>;
    brandKitId?: string;
  }) {
    const app = await one<any>(
      `SELECT id, credit_cost FROM ai_apps WHERE id=$1 AND status='live'`, [opts.appId]);
    if (!app) throw Err.notFound('Application indisponible');

    // Estimation annoncée avant de commencer : pas de surprise de facturation.
    const estimate = app.credit_cost * opts.rows.length;
    const balance = await ledger.getBalance(opts.workspaceId);

    const b = await one<{ id: string }>(
      `INSERT INTO batches (workspace_id, app_id, label, total_rows)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [opts.workspaceId, opts.appId, opts.label, opts.rows.length],
    );
    const batchId = b!.id;

    const results: { index: number; jobId?: string; error?: string }[] = [];
    let stoppedForCredits = false;

    for (const [index, row] of opts.rows.entries()) {
      const inputs: Record<string, unknown> = { ...opts.fixed };
      for (const [field, column] of Object.entries(opts.mapping)) {
        if (column && row[column] !== undefined) inputs[field] = row[column];
      }

      try {
        const r = await generation.submit({
          workspaceId: opts.workspaceId,
          userId: opts.userId,
          appId: opts.appId,
          inputs,
          brandKitId: opts.brandKitId,
          batchId,
          rowIndex: index,
        });
        results.push({ index, jobId: r.jobId });
      } catch (e: any) {
        if (e instanceof AppError && e.code === 'insufficient_credits') {
          stoppedForCredits = true;
          results.push({ index, error: 'crédits épuisés' });
          break;
        }
        results.push({ index, error: e.message });
      }
    }

    if (stoppedForCredits) {
      await query("UPDATE batches SET status='paused' WHERE id=$1", [batchId]);
    }

    return {
      batchId,
      estimate,
      balanceBefore: balance.spendable,
      queued: results.filter((r) => r.jobId).length,
      rejected: results.filter((r) => r.error).length,
      stoppedForCredits,
      results,
    };
  },

  async status(batchId: string, workspaceId: string) {
    const b = await one<any>(
      'SELECT * FROM batches WHERE id=$1 AND workspace_id=$2', [batchId, workspaceId]);
    if (!b) throw Err.notFound('Lot introuvable');

    const counts = await many<any>(
      `SELECT status, count(*)::int AS n FROM generation_jobs
        WHERE batch_id=$1 GROUP BY status`, [batchId]);

    const money = await one<any>(
      `SELECT COALESCE(SUM(credit_cost) FILTER (WHERE status='succeeded'),0)::int AS debite,
              COALESCE(SUM(credit_cost) FILTER (WHERE status IN ('queued','running')),0)::int AS reserve,
              COALESCE(SUM(credit_cost) FILTER (WHERE status='failed'),0)::int AS rendu,
              COALESCE(SUM(CASE WHEN served_from_cache THEN credit_cost ELSE 0 END),0)::int AS economise
         FROM generation_jobs WHERE batch_id=$1`, [batchId]);

    const failures = await many<any>(
      `SELECT row_index, error_code, error_message FROM generation_jobs
        WHERE batch_id=$1 AND status='failed'
        ORDER BY row_index LIMIT 50`, [batchId]);

    const byStatus: Record<string, number> = {};
    for (const c of counts) byStatus[c.status] = c.n;

    const done = (byStatus.succeeded ?? 0) + (byStatus.failed ?? 0) + (byStatus.cancelled ?? 0);
    const progress = b.total_rows ? Math.round((done / b.total_rows) * 100) : 0;

    // Le lot se clôt tout seul quand plus rien n'est en vol.
    if (b.status === 'running' && !byStatus.queued && !byStatus.running && done > 0) {
      await query("UPDATE batches SET status='done' WHERE id=$1", [batchId]);
      b.status = 'done';
    }

    return {
      id: b.id, label: b.label, appId: b.app_id, status: b.status,
      totalRows: b.total_rows, counts: byStatus, progress,
      credits: money, failures, createdAt: b.created_at,
    };
  },

  async list(workspaceId: string, limit = 20) {
    return many(
      `SELECT b.id, b.label, b.app_id, b.status, b.total_rows, b.created_at,
              count(j.id) FILTER (WHERE j.status='succeeded')::int AS reussies,
              count(j.id) FILTER (WHERE j.status='failed')::int    AS echouees
         FROM batches b
         LEFT JOIN generation_jobs j ON j.batch_id = b.id
        WHERE b.workspace_id=$1
        GROUP BY b.id ORDER BY b.created_at DESC LIMIT $2`,
      [workspaceId, limit],
    );
  },

  /** Relance uniquement les lignes en échec, sans refacturer les réussites. */
  async retryFailed(batchId: string, workspaceId: string, userId: string) {
    const b = await one<any>(
      'SELECT * FROM batches WHERE id=$1 AND workspace_id=$2', [batchId, workspaceId]);
    if (!b) throw Err.notFound('Lot introuvable');

    const failed = await many<any>(
      `SELECT id, inputs, row_index FROM generation_jobs
        WHERE batch_id=$1 AND status='failed'`, [batchId]);

    let relaunched = 0;
    for (const f of failed) {
      const inputs = { ...f.inputs };
      delete inputs._assets;
      try {
        await generation.submit({
          workspaceId, userId, appId: b.app_id, inputs,
          batchId, rowIndex: f.row_index,
        });
        relaunched++;
      } catch { /* la ligne reste en échec */ }
    }

    if (relaunched) {
      await query("UPDATE batches SET status='running' WHERE id=$1", [batchId]);
    }
    return { relaunched, total: failed.length };
  },

  /** Reprend un lot interrompu faute de crédits. */
  async resume(batchId: string, workspaceId: string) {
    await query(
      "UPDATE batches SET status='running' WHERE id=$1 AND workspace_id=$2 AND status='paused'",
      [batchId, workspaceId]);
    return this.status(batchId, workspaceId);
  },

  async cancel(batchId: string, workspaceId: string) {
    const jobs = await many<any>(
      `SELECT id FROM generation_jobs
        WHERE batch_id=$1 AND status IN ('queued','running')`, [batchId]);
    for (const j of jobs) {
      await generation.cancel(j.id, workspaceId).catch(() => {});
    }
    await query("UPDATE batches SET status='cancelled' WHERE id=$1 AND workspace_id=$2",
      [batchId, workspaceId]);
    return { cancelled: jobs.length };
  },

  /** Liste des fichiers produits par un lot, pour l'export. */
  async outputs(batchId: string, workspaceId: string) {
    const rows = await many<any>(
      `SELECT a.storage_key, a.mime, a.kind, j.row_index, j.output_text
         FROM assets a
         JOIN generation_jobs j ON j.id = a.job_id
        WHERE j.batch_id=$1 AND j.workspace_id=$2 AND j.status='succeeded'
        ORDER BY j.row_index`,
      [batchId, workspaceId],
    );
    return rows;
  },
};
