/**
 * Test de contrat entre l'interface et l'API.
 *
 * Chaque route appelée par le frontend est exercée ici. Le but n'est pas de
 * revalider la logique métier (c'est le rôle de ledger.test.ts) mais
 * d'empêcher qu'une route disparaisse ou change de forme sans que
 * l'interface le sache.
 *
 * Le serveur doit tourner sur BASE (par défaut http://localhost:3000).
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';

const BASE = process.env.TEST_BASE ?? 'http://localhost:3000';

let cookie = '';
let appId = '';
let assetId = '';

async function call(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = { ...(opts.headers as any) };
  if (cookie) headers.cookie = cookie;
  if (opts.body && typeof opts.body === 'string') {
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(`${BASE}${path}`, { ...opts, headers, redirect: 'manual' });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: body as any };
}

const json = (o: unknown) => JSON.stringify(o);

before(async () => {
  const health = await call('/healthz');
  assert.equal(health.status, 200, `le serveur doit tourner sur ${BASE}`);

  // Les compteurs de débit sont persistés : sans remise à zéro, relancer
  // la suite plusieurs fois de suite déclenche la limitation et fait
  // échouer des tests qui portent sur autre chose.
  const { pool } = await import('../src/db');
  await pool.query("DELETE FROM rate_events WHERE bucket IN ('signup','login')");
  await pool.end();
});

describe('authentification', () => {
  test('inscription puis session active', async () => {
    const email = `test-${randomUUID().slice(0, 8)}@atelier.tn`;
    const r = await call('/api/auth/signup', {
      method: 'POST',
      body: json({ email, password: 'motdepasse123', name: 'Testeur',
                   workspaceName: 'Boutique Test' }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, email);
    assert.equal(r.body.user.role, 'owner');
    assert.ok(cookie, 'un cookie de session doit être posé');
  });

  test('/auth/me rend la forme attendue par l’interface', async () => {
    const r = await call('/api/auth/me');
    assert.equal(r.status, 200);
    assert.ok(r.body.user?.id);
    assert.ok(r.body.workspace?.name);
    assert.equal(typeof r.body.balance.spendable, 'number');
    assert.ok(r.body.balance.balance > 0, 'les crédits de bienvenue doivent être là');
  });

  test('mot de passe trop court refusé', async () => {
    const r = await call('/api/auth/signup', {
      method: 'POST',
      body: json({ email: `x-${randomUUID().slice(0, 6)}@t.tn`, password: 'court',
                   name: 'X' }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_input');
  });

  test('adresse déjà utilisée refusée', async () => {
    const email = `dup-${randomUUID().slice(0, 8)}@atelier.tn`;
    const body = json({ email, password: 'motdepasse123', name: 'A' });
    await call('/api/auth/signup', { method: 'POST', body });
    const second = await call('/api/auth/signup', { method: 'POST', body });
    assert.equal(second.status, 409);
  });

  test('mauvais mot de passe : message identique, pas de fuite', async () => {
    const r = await call('/api/auth/login', {
      method: 'POST',
      body: json({ email: 'inexistant@nulle-part.tn', password: 'motdepasse123' }),
    });
    assert.equal(r.status, 401);
    assert.match(r.body.message, /incorrect/i);
  });
});

describe('catalogue', () => {
  test('/apps rend les applications publiées', async () => {
    const r = await call('/api/apps');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.ok(r.body.length >= 8, 'les 8 applications de départ doivent être là');

    const app = r.body[0];
    appId = app.id;
    for (const champ of ['id', 'title', 'category', 'modality',
                         'input_schema', 'credit_cost', 'est_seconds']) {
      assert.ok(champ in app, `le champ ${champ} est attendu par l'interface`);
    }
  });

  test('/apps/:id rend le détail', async () => {
    const r = await call(`/api/apps/${appId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, appId);
  });

  test('application inconnue : 404', async () => {
    const r = await call('/api/apps/nexiste-pas');
    assert.equal(r.status, 404);
  });
});

describe('envoi de fichier et génération', () => {
  test('/uploads accepte une image', async () => {
    const png = readFileSync('/tmp/demo1.png');
    const fd = new FormData();
    fd.append('files', new Blob([png], { type: 'image/png' }), 'produit.png');

    const res = await fetch(`${BASE}/api/uploads`, {
      method: 'POST', headers: { cookie }, body: fd,
    });
    const body: any = await res.json();
    assert.equal(res.status, 201);
    assert.ok(body.assets[0].id);
    assert.ok(body.assets[0].url);
    assetId = body.assets[0].id;
  });

  test('/generate met en file et réserve les crédits', async () => {
    const r = await call('/api/generate', {
      method: 'POST',
      body: json({
        appId: 'product-on-white',
        inputs: { images: [assetId], product_name: `Test ${randomUUID().slice(0, 6)}` },
      }),
    });
    assert.equal(r.status, 202);
    assert.ok(r.body.jobId);
    assert.equal(r.body.creditCost, 4);

    // on attend l'aboutissement
    let job: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 700));
      job = (await call(`/api/jobs/${r.body.jobId}`)).body;
      if (['succeeded', 'failed'].includes(job.status)) break;
    }
    assert.equal(job.status, 'succeeded', `statut final : ${job.status}`);
    assert.ok(job.assets.length >= 1, 'un fichier doit être produit');
    assert.ok(job.assets[0].url.length > 0);
  });

  test('entrée invalide refusée avec un message en français', async () => {
    const r = await call('/api/generate', {
      method: 'POST',
      body: json({ appId: 'product-on-white', inputs: {} }),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /obligatoire/);
  });

  test('un fichier d’un autre espace de travail est refusé', async () => {
    const r = await call('/api/generate', {
      method: 'POST',
      body: json({
        appId: 'product-on-white',
        inputs: { images: [randomUUID()], product_name: 'Vol' },
      }),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /introuvable/);
  });

  test('la modération bloque une demande interdite', async () => {
    const r = await call('/api/generate', {
      method: 'POST',
      body: json({
        appId: 'lifestyle-scene',
        inputs: { images: [assetId], scene: 'nude model naked in lingerie' },
      }),
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'content_blocked');
  });
});

describe('crédits et paiement', () => {
  test('/credits rend le solde', async () => {
    const r = await call('/api/credits');
    assert.equal(r.status, 200);
    for (const k of ['balance', 'held', 'spendable', 'lifetimeIn', 'lifetimeOut']) {
      assert.equal(typeof r.body[k], 'number', `${k} doit être un nombre`);
    }
  });

  test('/credits/history rend les écritures', async () => {
    const r = await call('/api/credits/history');
    assert.equal(r.status, 200);
    assert.ok(r.body.length >= 2, 'bonus de bienvenue + génération');
    const gen = r.body.find((e: any) => e.reason === 'generation');
    assert.ok(gen, 'la génération doit figurer au grand livre');
    assert.ok(Number(gen.amount) < 0);
  });

  test('/packs rend les packs et l’état du rail de paiement', async () => {
    const r = await call('/api/packs');
    assert.equal(r.status, 200);
    assert.ok(r.body.packs.length >= 4);
    assert.equal(typeof r.body.railAvailable, 'boolean');
    for (const champ of ['id', 'label', 'credits', 'bonus_credits', 'price_tnd_mils']) {
      assert.ok(champ in r.body.packs[0], `le champ ${champ} est attendu`);
    }
  });

  test('/payments rend un historique (vide au départ)', async () => {
    const r = await call('/api/payments');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });
});

describe('bibliothèque, marque, lots', () => {
  test('/assets rend les productions', async () => {
    const r = await call('/api/assets');
    assert.equal(r.status, 200);
    assert.ok(r.body.length >= 1);
    assert.ok(r.body[0].url);
  });

  test('cycle complet sur une identité de marque', async () => {
    const created = await call('/api/brands', {
      method: 'POST',
      body: json({ name: 'Zitouna', palette: ['#2E7A63'], tone: 'Sobre',
                   isDefault: true }),
    });
    assert.equal(created.status, 201);

    const list = await call('/api/brands');
    assert.ok(list.body.some((b: any) => b.name === 'Zitouna'));

    const updated = await call(`/api/brands/${created.body.id}`, {
      method: 'PUT', body: json({ tone: 'Artisanal' }),
    });
    assert.equal(updated.body.tone, 'Artisanal');
  });

  test('/batches rend la liste', async () => {
    const r = await call('/api/batches');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  test('/batches/parse lit un CSV', async () => {
    const csv = 'reference,nom\nZT-001,Huile olive\nZT-002,Savon\n';
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'catalogue.csv');

    const res = await fetch(`${BASE}/api/batches/parse`, {
      method: 'POST', headers: { cookie }, body: fd,
    });
    const body: any = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.columns, ['reference', 'nom']);
    assert.equal(body.rowCount, 2);
  });

  test('un lot complet traite toutes ses lignes', async () => {
    const r = await call('/api/batches', {
      method: 'POST',
      body: json({
        appId: 'product-copy',
        label: 'Lot de test',
        rows: [
          { nom: 'Huile olive', detail: 'Bouteille 50 cl, pression à froid' },
          { nom: 'Savon noir', detail: 'Pot 200 g, artisanal' },
        ],
        mapping: { product_name: 'nom', details: 'detail' },
      }),
    });
    assert.equal(r.status, 202);
    assert.equal(r.body.queued, 2);

    let st: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 700));
      st = (await call(`/api/batches/${r.body.batchId}`)).body;
      if (!st.counts.queued && !st.counts.running) break;
    }
    assert.equal(st.counts.succeeded, 2, 'les deux lignes doivent aboutir');
    assert.equal(st.progress, 100);
  });
});

describe('contrôle d’accès', () => {
  test('sans session, les routes protégées renvoient 401', async () => {
    const saved = cookie;
    cookie = '';
    for (const path of ['/api/credits', '/api/jobs', '/api/assets', '/api/brands']) {
      const r = await call(path);
      assert.equal(r.status, 401, `${path} doit exiger une session`);
    }
    cookie = saved;
  });

  test('l’administration est fermée aux comptes ordinaires', async () => {
    const r = await call('/api/admin/margin');
    assert.equal(r.status, 403);
  });

  test('un identifiant malformé est rejeté proprement', async () => {
    const r = await call('/api/jobs/pas-un-uuid');
    assert.equal(r.status, 400);
  });
});
