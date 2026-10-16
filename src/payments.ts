/**
 * Paiement par carte bancaire — Konnect.
 *
 * Konnect traite les cartes tunisiennes, les cartes internationales et
 * l'e-DINAR. C'est le rail principal : Stripe n'accepte pas les marchands
 * tunisiens, donc « carte bancaire » signifie Konnect ici.
 *
 * Règle de sécurité centrale : on ne croit JAMAIS le corps du webhook. À
 * chaque notification, on réinterroge Konnect pour connaître le vrai statut.
 * Un webhook falsifié ne peut donc pas créditer un compte.
 */
import { query, one, many, tx } from './db';
import { config, enabled } from './config';
import { ledger } from './ledger';
import { Err } from './lib/errors';
import { audit } from './auth';

export interface Pack {
  id: string; label: string; credits: number; bonus_credits: number;
  price_tnd_mils: number;
}

interface CheckoutResult { redirectUrl: string; providerRef: string }

// ---------------------------------------------------------------------------
// Adaptateur Konnect
// ---------------------------------------------------------------------------
class KonnectRail {
  readonly name = 'konnect' as const;
  readonly currency = 'TND';

  get configured() { return enabled.konnect; }

  async createCheckout(o: {
    paymentId: string; amountMinor: number; description: string;
    buyer?: { email?: string; phone?: string; firstName?: string; lastName?: string };
  }): Promise<CheckoutResult> {
    const res = await fetch(`${config.KONNECT_BASE_URL}/payments/init-payment`, {
      method: 'POST',
      headers: {
        'x-api-key': config.KONNECT_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receiverWalletId: config.KONNECT_WALLET_ID,
        token: 'TND',
        amount: o.amountMinor,                 // en millimes
        type: 'immediate',
        description: o.description,
        acceptedPaymentMethods: ['wallet', 'bank_card', 'e-DINAR'],
        lifespan: 30,                          // minutes
        checkoutForm: false,
        addPaymentFeesToAmount: false,
        successUrl: `${config.PUBLIC_BASE_URL}/#/billing/success?p=${o.paymentId}`,
        failUrl: `${config.PUBLIC_BASE_URL}/#/billing/failed?p=${o.paymentId}`,
        webhook: `${config.PUBLIC_BASE_URL}/api/webhooks/konnect`,
        orderId: o.paymentId,
        firstName: o.buyer?.firstName,
        lastName: o.buyer?.lastName,
        phoneNumber: o.buyer?.phone,
        email: o.buyer?.email,
        silentWebhook: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      throw Err.internal(`Konnect a refusé la demande (${res.status})`);
    }
    const d: any = await res.json();
    if (!d.payUrl || !d.paymentRef) {
      throw Err.internal('Réponse Konnect inattendue');
    }
    return { redirectUrl: d.payUrl, providerRef: d.paymentRef };
  }

  /** Source de vérité : l'état lu chez Konnect, jamais le corps du webhook. */
  async verify(providerRef: string): Promise<{ paid: boolean; amountMinor?: number }> {
    const res = await fetch(`${config.KONNECT_BASE_URL}/payments/${providerRef}`, {
      headers: { 'x-api-key': config.KONNECT_API_KEY! },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { paid: false };

    const d: any = await res.json();
    const p = d.payment ?? d;
    return {
      paid: p?.status === 'completed',
      amountMinor: Number(p?.amount ?? 0),
    };
  }
}

const konnect = new KonnectRail();

// ---------------------------------------------------------------------------
export const payments = {
  async packs(): Promise<Pack[]> {
    return many<Pack>(
      `SELECT id, label, credits, bonus_credits, price_tnd_mils
         FROM credit_packs WHERE active ORDER BY sort_order`,
    );
  },

  get railAvailable() { return konnect.configured; },

  /**
   * Démarre un achat. Rend l'URL de la page de paiement Konnect.
   * Le montant vient TOUJOURS de la base, jamais du client : sinon
   * n'importe qui achèterait 25 000 crédits pour un dinar.
   */
  async startTopup(o: {
    workspaceId: string; userId: string; packId: string;
    buyer?: { email?: string; phone?: string; name?: string };
    ip?: string;
  }) {
    if (!konnect.configured) {
      throw Err.internal(
        "Le paiement par carte n'est pas encore configuré sur cette installation");
    }

    const pack = await one<Pack>(
      'SELECT * FROM credit_packs WHERE id=$1 AND active', [o.packId]);
    if (!pack) throw Err.notFound('Pack introuvable');

    const credits = pack.credits + pack.bonus_credits;

    const p = await one<{ id: string }>(
      `INSERT INTO payments
         (workspace_id, user_id, rail, pack_id, credits, amount_minor, currency)
       VALUES ($1,$2,'konnect',$3,$4,$5,'TND') RETURNING id`,
      [o.workspaceId, o.userId, pack.id, credits, pack.price_tnd_mils],
    );
    const paymentId = p!.id;

    const [firstName, ...rest] = (o.buyer?.name ?? '').split(' ');

    let checkout: CheckoutResult;
    try {
      checkout = await konnect.createCheckout({
        paymentId,
        amountMinor: pack.price_tnd_mils,
        description: `${credits} crédits — ${pack.label}`,
        buyer: {
          email: o.buyer?.email,
          phone: o.buyer?.phone,
          firstName: firstName || undefined,
          lastName: rest.join(' ') || undefined,
        },
      });
    } catch (e) {
      await query("UPDATE payments SET status='failed' WHERE id=$1", [paymentId]);
      throw e;
    }

    await query(
      'UPDATE payments SET provider_ref=$2, checkout_url=$3 WHERE id=$1',
      [paymentId, checkout.providerRef, checkout.redirectUrl],
    );
    await audit(o.workspaceId, o.userId, 'topup_start', paymentId,
      { pack: pack.id, credits }, o.ip);

    return { paymentId, redirectUrl: checkout.redirectUrl, credits,
             amountTnd: pack.price_tnd_mils / 1000 };
  },

  /**
   * Règlement d'un paiement. Appelé par le webhook ET par la page de retour :
   * si le webhook se perd, le client qui revient sur le site déclenche la
   * même vérification. Idempotent des deux côtés.
   */
  async settle(providerRef: string): Promise<{ ok: boolean; reason: string }> {
    const p = await one<any>(
      "SELECT * FROM payments WHERE rail='konnect' AND provider_ref=$1", [providerRef]);
    if (!p) return { ok: false, reason: 'paiement_inconnu' };
    if (p.status === 'paid') return { ok: true, reason: 'deja_regle' };

    const check = await konnect.verify(providerRef);

    if (!check.paid) {
      await query(
        "UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'", [p.id]);
      return { ok: false, reason: 'non_paye' };
    }

    // Garde-fou : le montant réellement encaissé doit couvrir le pack.
    if (check.amountMinor && check.amountMinor < Number(p.amount_minor)) {
      await audit(p.workspace_id, null, 'payment_amount_mismatch', p.id,
        { attendu: p.amount_minor, recu: check.amountMinor });
      return { ok: false, reason: 'montant_incoherent' };
    }

    await query(
      "UPDATE payments SET status='paid', paid_at=now() WHERE id=$1", [p.id]);

    const credited = await ledger.credit({
      workspaceId: p.workspace_id,
      amount: p.credits,
      reason: 'topup_card',
      refType: 'payment',
      refId: p.id,
      metadata: { rail: 'konnect', pack: p.pack_id, ref: providerRef },
    });

    await audit(p.workspace_id, p.user_id, 'topup_settled', p.id,
      { credits: p.credits, nouveau: credited });

    return { ok: true, reason: credited ? 'credite' : 'deja_credite' };
  },

  /** Consultation par le client au retour de la page de paiement. */
  async refresh(paymentId: string, workspaceId: string) {
    const p = await one<any>(
      'SELECT * FROM payments WHERE id=$1 AND workspace_id=$2', [paymentId, workspaceId]);
    if (!p) throw Err.notFound('Paiement introuvable');

    if (p.status === 'pending' && p.provider_ref) {
      await this.settle(p.provider_ref).catch(() => {});
      return one('SELECT id, status, credits, amount_minor, created_at, paid_at '
               + 'FROM payments WHERE id=$1', [paymentId]);
    }
    return {
      id: p.id, status: p.status, credits: p.credits,
      amount_minor: p.amount_minor, created_at: p.created_at, paid_at: p.paid_at,
    };
  },

  async history(workspaceId: string, limit = 30) {
    return many(
      `SELECT p.id, p.status, p.credits, p.amount_minor, p.currency,
              p.created_at, p.paid_at, k.label AS pack_label
         FROM payments p
         LEFT JOIN credit_packs k ON k.id = p.pack_id
        WHERE p.workspace_id=$1
        ORDER BY p.created_at DESC LIMIT $2`,
      [workspaceId, limit],
    );
  },

  /**
   * Rattrapage des paiements en attente. Un webhook peut se perdre ; cette
   * tâche relit l'état chez Konnect pour les paiements récents non réglés.
   */
  async reconcilePending(): Promise<number> {
    if (!konnect.configured) return 0;
    const rows = await many<any>(
      `SELECT provider_ref FROM payments
        WHERE status='pending' AND provider_ref IS NOT NULL
          AND created_at > now() - interval '48 hours'
          AND created_at < now() - interval '2 minutes'
        LIMIT 50`,
    );
    let settled = 0;
    for (const r of rows) {
      const out = await this.settle(r.provider_ref).catch(() => ({ ok: false }));
      if (out.ok) settled++;
    }
    return settled;
  },
};
