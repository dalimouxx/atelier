/**
 * Tests du grand livre.
 *
 * On ne teste pas « est-ce que ça marche », mais les scénarios qui coûtent
 * de l'argent réel : double crédit, course sur le dernier crédit,
 * remboursement d'un échec, immuabilité des écritures.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { pool, query } from '../src/db';
import { ledger } from '../src/ledger';
import { AppError } from '../src/lib/errors';

let ws: string;

async function freshWorkspace(credits = 0): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO workspaces (id, name, slug) VALUES ($1,$2,$3)`,
    [id, 'Test', `test-${id.slice(0, 8)}`],
  );
  await ledger.ensureAccount(id);
  if (credits) {
    await ledger.credit({
      workspaceId: id, amount: credits, reason: 'topup_manual',
      refType: 'seed', refId: randomUUID(),
    });
  }
  return id;
}

before(async () => { ws = await freshWorkspace(); });
after(async () => { await pool.end(); });

describe('cycle réserver / débiter / libérer', () => {
  test('une réservation gèle sans débiter', async () => {
    const w = await freshWorkspace(100);
    await ledger.reserve({ workspaceId: w, amount: 30, refType: 'job', refId: randomUUID() });

    const b = await ledger.getBalance(w);
    assert.equal(b.balance, 100, 'le solde ne doit pas bouger à la réservation');
    assert.equal(b.held, 30);
    assert.equal(b.spendable, 70);
  });

  test('le débit retire le montant et inscrit une écriture', async () => {
    const w = await freshWorkspace(100);
    const ref = randomUUID();
    await ledger.reserve({ workspaceId: w, amount: 30, refType: 'job', refId: ref });
    await ledger.commit({ refType: 'job', refId: ref, costUsdMicros: 12345 });

    const b = await ledger.getBalance(w);
    assert.equal(b.balance, 70);
    assert.equal(b.held, 0);

    const h = await ledger.history(w);
    const entry = h.find((e: any) => e.ref_id === ref);
    assert.ok(entry, 'une écriture doit exister');
    assert.equal(Number(entry.amount), -30);
    assert.equal(Number(entry.cost_usd_micros), 12345);
  });

  test("un échec rend les crédits : rien n'est facturé", async () => {
    const w = await freshWorkspace(100);
    const ref = randomUUID();
    await ledger.reserve({ workspaceId: w, amount: 40, refType: 'job', refId: ref });
    await ledger.release('job', ref);

    const b = await ledger.getBalance(w);
    assert.equal(b.balance, 100, 'le solde doit être intact');
    assert.equal(b.held, 0);

    const h = await ledger.history(w);
    assert.equal(h.filter((e: any) => e.ref_id === ref).length, 0,
      'aucune écriture ne doit exister pour un travail échoué');
  });

  test('débiter deux fois le même travail ne débite qu’une fois', async () => {
    const w = await freshWorkspace(100);
    const ref = randomUUID();
    await ledger.reserve({ workspaceId: w, amount: 25, refType: 'job', refId: ref });
    await ledger.commit({ refType: 'job', refId: ref });
    await ledger.commit({ refType: 'job', refId: ref });
    await ledger.commit({ refType: 'job', refId: ref });

    assert.equal((await ledger.getBalance(w)).balance, 75);
  });

  test('libérer après un débit ne rend rien', async () => {
    const w = await freshWorkspace(100);
    const ref = randomUUID();
    await ledger.reserve({ workspaceId: w, amount: 25, refType: 'job', refId: ref });
    await ledger.commit({ refType: 'job', refId: ref });
    await ledger.release('job', ref);

    const b = await ledger.getBalance(w);
    assert.equal(b.balance, 75, 'un travail payé ne doit pas être remboursé');
    assert.equal(b.held, 0);
  });
});

describe('concurrence — le cas qui coûte de l’argent', () => {
  test('deux générations sur le dernier crédit : une seule passe', async () => {
    const w = await freshWorkspace(10);

    const results = await Promise.allSettled([
      ledger.reserve({ workspaceId: w, amount: 10, refType: 'job', refId: randomUUID() }),
      ledger.reserve({ workspaceId: w, amount: 10, refType: 'job', refId: randomUUID() }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 1, 'exactement une réservation doit aboutir');

    const b = await ledger.getBalance(w);
    assert.equal(b.held, 10);
    assert.equal(b.spendable, 0);
  });

  test('dix réservations simultanées ne dépassent jamais le solde', async () => {
    const w = await freshWorkspace(50);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        ledger.reserve({ workspaceId: w, amount: 10, refType: 'job', refId: randomUUID() })),
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 5, 'cinq réservations de 10 sur un solde de 50');

    const b = await ledger.getBalance(w);
    assert.equal(b.held, 50);
    assert.equal(b.spendable, 0);
  });

  test('le solde ne peut jamais devenir négatif', async () => {
    const w = await freshWorkspace(5);
    await assert.rejects(
      () => ledger.reserve({ workspaceId: w, amount: 6, refType: 'job', refId: randomUUID() }),
      (e: any) => e instanceof AppError && e.code === 'insufficient_credits',
    );
    assert.equal((await ledger.getBalance(w)).balance, 5);
  });
});

describe('approvisionnement', () => {
  test('un webhook rejoué ne crédite pas deux fois', async () => {
    const w = await freshWorkspace();
    const paymentId = randomUUID();

    const first = await ledger.credit({
      workspaceId: w, amount: 1000, reason: 'topup_card',
      refType: 'payment', refId: paymentId,
    });
    const second = await ledger.credit({
      workspaceId: w, amount: 1000, reason: 'topup_card',
      refType: 'payment', refId: paymentId,
    });

    assert.equal(first, true, 'le premier appel crédite');
    assert.equal(second, false, 'le second est ignoré');
    assert.equal((await ledger.getBalance(w)).balance, 1000);
  });

  test('cinq webhooks simultanés ne créditent qu’une fois', async () => {
    const w = await freshWorkspace();
    const paymentId = randomUUID();

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ledger.credit({
        workspaceId: w, amount: 500, reason: 'topup_card',
        refType: 'payment', refId: paymentId,
      })),
    );

    const credited = results.filter(
      (r) => r.status === 'fulfilled' && r.value === true).length;
    assert.equal(credited, 1, 'un seul appel doit créditer');
    assert.equal((await ledger.getBalance(w)).balance, 500);
  });

  test('deux paiements distincts créditent bien deux fois', async () => {
    const w = await freshWorkspace();
    await ledger.credit({ workspaceId: w, amount: 300, reason: 'topup_card',
      refType: 'payment', refId: randomUUID() });
    await ledger.credit({ workspaceId: w, amount: 700, reason: 'topup_card',
      refType: 'payment', refId: randomUUID() });
    assert.equal((await ledger.getBalance(w)).balance, 1000);
  });
});

describe('intégrité comptable', () => {
  test('le solde stocké égale toujours la somme des écritures', async () => {
    const w = await freshWorkspace(500);

    for (let i = 0; i < 8; i++) {
      const ref = randomUUID();
      await ledger.reserve({ workspaceId: w, amount: 20, refType: 'job', refId: ref });
      if (i % 3 === 0) await ledger.release('job', ref);
      else await ledger.commit({ refType: 'job', refId: ref });
    }
    await ledger.credit({ workspaceId: w, amount: 200, reason: 'topup_card',
      refType: 'payment', refId: randomUUID() });

    const a = await ledger.audit(w);
    assert.equal(a.ok, true, `écart détecté : stocké ${a.stored}, dérivé ${a.derived}`);
  });

  test('une écriture ne peut être ni modifiée ni supprimée', async () => {
    const w = await freshWorkspace(100);
    const h = await ledger.history(w);
    const id = h[0].id;

    await assert.rejects(
      () => query('UPDATE credit_entries SET amount=9999 WHERE id=$1', [id]),
      /ajout seul/,
    );
    await assert.rejects(
      () => query('DELETE FROM credit_entries WHERE id=$1', [id]),
      /ajout seul/,
    );
  });

  test('un ajustement manuel laisse une trace', async () => {
    const w = await freshWorkspace(100);
    await ledger.adjust({ workspaceId: w, amount: -30, note: 'litige', by: 'admin@test' });

    assert.equal((await ledger.getBalance(w)).balance, 70);
    const h = await ledger.history(w);
    const adj = h.find((e: any) => e.reason === 'adjustment');
    assert.ok(adj);
    assert.equal(adj.metadata.note, 'litige');
    assert.equal((await ledger.audit(w)).ok, true);
  });
});

describe('expiration des réservations', () => {
  test('un gel périmé est rendu au client', async () => {
    const w = await freshWorkspace(100);
    const ref = randomUUID();
    await ledger.reserve({
      workspaceId: w, amount: 40, refType: 'job', refId: ref, ttlSeconds: 1,
    });

    await query(
      "UPDATE credit_holds SET expires_at = now() - interval '1 minute' WHERE ref_id=$1",
      [ref]);

    const freed = await ledger.expireStaleHolds();
    assert.ok(freed >= 1);

    const b = await ledger.getBalance(w);
    assert.equal(b.held, 0, 'le gel doit être libéré');
    assert.equal(b.balance, 100, 'rien ne doit avoir été facturé');
  });
});
