/**
 * Grand livre de crédits — le cœur financier de la plateforme.
 *
 * Toute circulation de crédits passe par ici. Aucun autre module n'écrit
 * dans credit_accounts ni credit_entries.
 *
 * Cycle d'une génération :
 *   reserve()  → le montant est gelé (held += n), le solde ne bouge pas
 *   commit()   → le gel devient débit réel, une écriture est inscrite
 *   release()  → le gel est annulé, rien n'a bougé, rien n'est facturé
 *
 * Le client n'est jamais débité d'un rendu qu'il n'a pas reçu.
 */
import { PoolClient } from 'pg';
import { pool, tx, query, one } from './db';
import { Err } from './lib/errors';
import { config } from './config';

export type Reason =
  | 'topup_card' | 'topup_code' | 'topup_manual' | 'signup_bonus'
  | 'referral' | 'generation' | 'refund' | 'expiry' | 'adjustment';

export interface Balance {
  balance: number;
  held: number;
  spendable: number;
  lifetimeIn: number;
  lifetimeOut: number;
}

class DuplicateEntry extends Error {}

export class Ledger {
  async ensureAccount(workspaceId: string) {
    await query(
      `INSERT INTO credit_accounts (workspace_id) VALUES ($1)
       ON CONFLICT (workspace_id) DO NOTHING`, [workspaceId],
    );
  }

  async getBalance(workspaceId: string): Promise<Balance> {
    const r = await one<any>(
      `SELECT balance, held, lifetime_in, lifetime_out
         FROM credit_accounts WHERE workspace_id=$1`, [workspaceId],
    );
    if (!r) return { balance: 0, held: 0, spendable: 0, lifetimeIn: 0, lifetimeOut: 0 };
    return {
      balance: Number(r.balance),
      held: Number(r.held),
      spendable: Number(r.balance) - Number(r.held),
      lifetimeIn: Number(r.lifetime_in),
      lifetimeOut: Number(r.lifetime_out),
    };
  }

  /**
   * Gèle des crédits pour un travail en cours.
   * Idempotent sur (refType, refId) : un second appel rend le gel existant.
   */
  async reserve(opts: {
    workspaceId: string; amount: number;
    refType: string; refId: string; ttlSeconds?: number;
  }): Promise<string> {
    const ttl = opts.ttlSeconds ?? config.HOLD_TTL_SECONDS;

    return tx(async (c) => {
      const existing = await c.query(
        'SELECT id FROM credit_holds WHERE ref_type=$1 AND ref_id=$2',
        [opts.refType, opts.refId],
      );
      if (existing.rowCount) return existing.rows[0].id as string;

      // FOR UPDATE sérialise les réservations concurrentes sur ce compte :
      // deux générations lancées en même temps sur le dernier crédit ne
      // peuvent pas passer toutes les deux.
      const acct = await c.query(
        'SELECT balance, held FROM credit_accounts WHERE workspace_id=$1 FOR UPDATE',
        [opts.workspaceId],
      );
      if (!acct.rowCount) throw Err.notFound('Compte de crédits introuvable');

      const spendable = Number(acct.rows[0].balance) - Number(acct.rows[0].held);
      if (spendable < opts.amount) {
        throw Err.insufficientCredits(opts.amount, spendable);
      }

      await c.query(
        'UPDATE credit_accounts SET held = held + $2, updated_at=now() WHERE workspace_id=$1',
        [opts.workspaceId, opts.amount],
      );

      const h = await c.query(
        `INSERT INTO credit_holds (workspace_id, amount, ref_type, ref_id, expires_at)
         VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval) RETURNING id`,
        [opts.workspaceId, opts.amount, opts.refType, opts.refId, String(ttl)],
      );
      return h.rows[0].id as string;
    });
  }

  /** Le travail a abouti : le gel devient un débit définitif. */
  async commit(opts: {
    refType: string; refId: string;
    costUsdMicros?: number | null;
    amountOverride?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await tx(async (c) => {
      const h = await c.query(
        'SELECT * FROM credit_holds WHERE ref_type=$1 AND ref_id=$2 FOR UPDATE',
        [opts.refType, opts.refId],
      );
      if (!h.rowCount) throw Err.notFound('Réservation introuvable');
      const hold = h.rows[0];
      if (hold.status !== 'open') return; // déjà résolu — idempotent

      const held = Number(hold.amount);
      const charge = opts.amountOverride ?? held;

      const acct = await c.query(
        `UPDATE credit_accounts
            SET balance = balance - $2,
                held    = held    - $3,
                lifetime_out = lifetime_out + $2,
                updated_at = now()
          WHERE workspace_id = $1
        RETURNING balance`,
        [hold.workspace_id, charge, held],
      );

      await c.query(
        `INSERT INTO credit_entries
           (workspace_id, amount, reason, ref_type, ref_id,
            balance_after, cost_usd_micros, metadata)
         VALUES ($1,$2,'generation',$3,$4,$5,$6,$7)
         ON CONFLICT (ref_type, ref_id, reason) WHERE ref_id IS NOT NULL
         DO NOTHING`,
        [hold.workspace_id, -charge, opts.refType, opts.refId,
         acct.rows[0].balance, opts.costUsdMicros ?? null,
         JSON.stringify(opts.metadata ?? {})],
      );

      await c.query(
        "UPDATE credit_holds SET status='committed', resolved_at=now() WHERE id=$1",
        [hold.id],
      );
    });
  }

  /** Le travail a échoué : le gel est rendu. Aucune écriture, rien n'a bougé. */
  async release(refType: string, refId: string): Promise<void> {
    await tx(async (c) => {
      const h = await c.query(
        'SELECT * FROM credit_holds WHERE ref_type=$1 AND ref_id=$2 FOR UPDATE',
        [refType, refId],
      );
      if (!h.rowCount || h.rows[0].status !== 'open') return;
      const hold = h.rows[0];

      await c.query(
        'UPDATE credit_accounts SET held = held - $2, updated_at=now() WHERE workspace_id=$1',
        [hold.workspace_id, hold.amount],
      );
      await c.query(
        "UPDATE credit_holds SET status='released', resolved_at=now() WHERE id=$1",
        [hold.id],
      );
    });
  }

  /**
   * Approvisionnement. Idempotent sur (refType, refId, reason) : un webhook
   * rejoué ne crédite pas deux fois.
   * Rend true si l'opération a effectivement crédité, false si déjà faite.
   */
  async credit(opts: {
    workspaceId: string; amount: number; reason: Reason;
    refType: string; refId: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    try {
      await tx(async (c) => {
        await c.query(
          'INSERT INTO credit_accounts (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [opts.workspaceId],
        );
        await c.query(
          'SELECT 1 FROM credit_accounts WHERE workspace_id=$1 FOR UPDATE',
          [opts.workspaceId],
        );

        const dup = await c.query(
          `SELECT 1 FROM credit_entries
            WHERE ref_type=$1 AND ref_id=$2 AND reason=$3`,
          [opts.refType, opts.refId, opts.reason],
        );
        if (dup.rowCount) throw new DuplicateEntry();

        const acct = await c.query(
          `UPDATE credit_accounts
              SET balance = balance + $2,
                  lifetime_in = lifetime_in + $2,
                  updated_at = now()
            WHERE workspace_id = $1
          RETURNING balance`,
          [opts.workspaceId, opts.amount],
        );

        await c.query(
          `INSERT INTO credit_entries
             (workspace_id, amount, reason, ref_type, ref_id, balance_after, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [opts.workspaceId, opts.amount, opts.reason, opts.refType, opts.refId,
           acct.rows[0].balance, JSON.stringify(opts.metadata ?? {})],
        );
      });
      return true;
    } catch (e) {
      if (e instanceof DuplicateEntry) return false;
      throw e;
    }
  }

  /** Correction manuelle (geste commercial, litige). Trace obligatoire. */
  async adjust(opts: {
    workspaceId: string; amount: number; note: string; by: string;
  }): Promise<void> {
    if (opts.amount === 0) throw Err.badInput('Le montant ne peut pas être nul');
    const ref = `adj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await tx(async (c) => {
      await c.query(
        'SELECT 1 FROM credit_accounts WHERE workspace_id=$1 FOR UPDATE',
        [opts.workspaceId],
      );
      const acct = await c.query(
        `UPDATE credit_accounts
            SET balance = balance + $2,
                lifetime_in  = lifetime_in  + GREATEST($2, 0),
                lifetime_out = lifetime_out + GREATEST(-$2, 0),
                updated_at = now()
          WHERE workspace_id=$1
        RETURNING balance`,
        [opts.workspaceId, opts.amount],
      );
      await c.query(
        `INSERT INTO credit_entries
           (workspace_id, amount, reason, ref_type, ref_id, balance_after, metadata)
         VALUES ($1,$2,'adjustment','manual',$3,$4,$5)`,
        [opts.workspaceId, opts.amount, ref, acct.rows[0].balance,
         JSON.stringify({ note: opts.note, by: opts.by })],
      );
    });
  }

  async history(workspaceId: string, limit = 50, before?: number) {
    return (await pool.query(
      `SELECT id, amount, reason, ref_type, ref_id, balance_after,
              cost_usd_micros, metadata, created_at
         FROM credit_entries
        WHERE workspace_id=$1 ${before ? 'AND id < $3' : ''}
        ORDER BY id DESC LIMIT $2`,
      before ? [workspaceId, limit, before] : [workspaceId, limit],
    )).rows;
  }

  /** Libère les gels expirés. Appelé par la tâche planifiée. */
  async expireStaleHolds(): Promise<number> {
    const { rows } = await query(
      `SELECT ref_type, ref_id FROM credit_holds
        WHERE status='open' AND expires_at < now() LIMIT 500`,
    );
    for (const r of rows) await this.release(r.ref_type, r.ref_id);
    return rows.length;
  }

  /**
   * Réconciliation : le solde stocké doit égaler la somme des écritures.
   * Un écart signifie un bug ou une écriture hors circuit — à alerter.
   */
  async audit(workspaceId: string) {
    const r = await one<any>(
      `SELECT a.balance AS stored,
              COALESCE((SELECT SUM(amount) FROM credit_entries e
                         WHERE e.workspace_id=a.workspace_id), 0) AS derived
         FROM credit_accounts a WHERE a.workspace_id=$1`,
      [workspaceId],
    );
    if (!r) return { stored: 0, derived: 0, ok: true };
    const stored = Number(r.stored), derived = Number(r.derived);
    return { stored, derived, ok: stored === derived, gap: stored - derived };
  }

  /** Réconciliation globale — renvoie seulement les comptes en écart. */
  async auditAll() {
    const { rows } = await query(
      `SELECT a.workspace_id, w.name, a.balance AS stored,
              COALESCE(SUM(e.amount), 0) AS derived
         FROM credit_accounts a
         JOIN workspaces w ON w.id = a.workspace_id
         LEFT JOIN credit_entries e ON e.workspace_id = a.workspace_id
        GROUP BY a.workspace_id, w.name, a.balance
       HAVING a.balance <> COALESCE(SUM(e.amount), 0)`,
    );
    return rows;
  }
}

export const ledger = new Ledger();
