/* =========================================================================
   Point d'entrée de l'interface : authentification, coquille, routage.
   ====================================================================== */
import {
  api, state, esc, $, $$, on, credits, toast, ok, err,
  go, readRoute, onRoute, refreshBalance,
} from './core.js';
import {
  dashboard, apps, generator, library, brands, creditsPage, history,
} from './views.js';
import { batchPage, adminMargin } from './batch-admin.js';
import { landing } from './landing.js';

const root = () => document.getElementById('root');

const NAV = [
  { group: 'Créer' },
  { id: 'dash', ic: '▤', label: 'Tableau de bord' },
  { id: 'apps', ic: '✦', label: 'Applications' },
  { id: 'batch', ic: '≡', label: 'Production en lot' },
  { group: 'Gérer' },
  { id: 'library', ic: '▦', label: 'Bibliothèque' },
  { id: 'brands', ic: '◈', label: 'Identité de marque' },
  { group: 'Compte' },
  { id: 'credits', ic: '◉', label: 'Crédits' },
  { id: 'history', ic: '↕', label: 'Historique' },
];

const TITLES = {
  dash: 'Tableau de bord', apps: 'Applications', gen: 'Générateur',
  batch: 'Production en lot', library: 'Bibliothèque',
  brands: 'Identité de marque', credits: 'Crédits', history: 'Historique',
  admin: 'Marges',
};

// ---------------------------------------------------------------------------
// Écran de connexion
// ---------------------------------------------------------------------------
function gate(mode = 'login') {
  const isSignup = mode === 'signup';

  root().innerHTML = `
    <div class="gate"><div class="gate-box">
      <button class="gate-brand" data-accueil style="width:100%">
        <span class="mark">A</span> Atelier
      </button>

      <div class="gate-card">
        <h1>${isSignup ? 'Créer un compte' : 'Connexion'}</h1>
        <p>${isSignup
          ? 'Vos premiers crédits sont offerts, de quoi tester sans rien payer.'
          : 'Accédez à votre espace de production.'}</p>

        <form id="gateform">
          ${isSignup ? `
            <div class="fs"><label for="g_name">Votre nom</label>
              <input class="field" id="g_name" required autocomplete="name"></div>
            <div class="fs"><label for="g_ws">Nom de la boutique ou de l'agence</label>
              <input class="field" id="g_ws" placeholder="Boutique Zitouna"></div>
            <div class="fs"><label for="g_kind">Vous êtes</label>
              <select class="field" id="g_kind">
                <option value="seller">Vendeur e-commerce</option>
                <option value="agency">Agence</option>
              </select></div>` : ''}

          <div class="fs"><label for="g_email">Adresse e-mail</label>
            <input class="field" id="g_email" type="email" required autocomplete="email"></div>
          <div class="fs"><label for="g_pass">Mot de passe</label>
            <input class="field" id="g_pass" type="password" required minlength="8"
              autocomplete="${isSignup ? 'new-password' : 'current-password'}">
            ${isSignup ? '<small class="dim" style="font-size:11.5px">Huit caractères minimum</small>' : ''}</div>

          <button class="btn btn-p btn-blk" type="submit" id="gatebtn">
            ${isSignup ? 'Créer mon compte' : 'Se connecter'}</button>
        </form>
      </div>

      <p class="gate-switch">
        ${isSignup
          ? 'Vous avez déjà un compte ? <a href="#" data-mode="login">Se connecter</a>'
          : 'Pas encore de compte ? <a href="#" data-mode="signup">En créer un</a>'}
      </p>
      <p class="gate-switch"><a href="#" data-accueil>Retour à l'accueil</a></p>
    </div></div>`;

  $('[data-mode]').onclick = (e) => { e.preventDefault(); gate(e.target.dataset.mode); };
  $$('[data-accueil]').forEach((b) => b.onclick = (e) => {
    e.preventDefault(); location.hash = ''; showLanding();
  });

  $('#gateform').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#gatebtn');
    btn.disabled = true; btn.textContent = 'Un instant…';

    try {
      const body = {
        email: $('#g_email').value.trim(),
        password: $('#g_pass').value,
      };
      if (isSignup) {
        body.name = $('#g_name').value.trim();
        body.workspaceName = $('#g_ws').value.trim() || body.name;
        body.kind = $('#g_kind').value;
      }
      await api(isSignup ? '/auth/signup' : '/auth/login', { method: 'POST', body });
      await boot();
      if (isSignup) ok('Bienvenue — vos crédits de bienvenue sont disponibles');
    } catch (e2) {
      err(e2);
      btn.disabled = false;
      btn.textContent = isSignup ? 'Créer mon compte' : 'Se connecter';
    }
  };
}

// ---------------------------------------------------------------------------
// Coquille de l'application
// ---------------------------------------------------------------------------
function shell() {
  const initials = (state.user.name ?? '?')
    .split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  root().innerHTML = `
    <div class="shell">
      <aside class="rail">
        <div class="brand">
          <div class="mark">A</div>
          <div><b>Atelier</b><span>${esc(state.workspace?.name ?? '')}</span></div>
        </div>
        <nav class="nav">
          ${NAV.map((n) => n.group
            ? `<p class="nav-group">${esc(n.group)}</p>`
            : `<button data-go="${n.id}"><span class="ic">${n.ic}</span> ${esc(n.label)}</button>`).join('')}
          ${state.user.isPlatformAdmin ? `
            <p class="nav-group">Administration</p>
            <button data-go="admin"><span class="ic">◇</span> Marges</button>` : ''}
        </nav>
        <div class="who">
          <div class="av">${esc(initials)}</div>
          <div><p>${esc(state.user.name)}</p><small>${esc(roleLabel(state.user.role))}</small></div>
          <button data-logout title="Se déconnecter">sortir</button>
        </div>
      </aside>

      <div class="main">
        <header class="top">
          <h1 id="crumb">Tableau de bord</h1>
          <div class="wallet">
            <span class="sol">
              <b id="bal" class="num">${credits(state.balance.spendable)}</b>
              <small>crédits</small>
            </span>
            <button class="btn btn-s btn-p" data-go="credits">Recharger</button>
          </div>
        </header>
        <div id="view" class="page"></div>
      </div>
    </div>`;

  on(root(), 'click', '[data-go]', (e, b) => {
    e.preventDefault();
    go(b.dataset.go);
  });
  on(root(), 'click', '[data-app]', (e, b) => go('gen', { app: b.dataset.app }));
  on(root(), 'click', '[data-job]', (e, b) => go('job', { id: b.dataset.job }));

  $('[data-logout]').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    state.user = null;
    location.hash = '';
    gate('login');
  };

  refreshBalance();
}

function roleLabel(r) {
  return { owner: 'propriétaire', admin: 'administrateur',
           member: 'membre', viewer: 'lecture seule' }[r] ?? r;
}

// ---------------------------------------------------------------------------
// Routage
// ---------------------------------------------------------------------------
async function render() {
  const { route, params } = readRoute();
  state.route = route; state.params = params;

  const crumb = document.getElementById('crumb');
  if (crumb) crumb.textContent = TITLES[route] ?? '';

  $$('.nav button[data-go]').forEach((b) =>
    b.setAttribute('aria-current', String(b.dataset.go === route)));

  try {
    switch (route) {
      case 'dash': return await dashboard();
      case 'apps': return await apps();
      case 'gen': return params.app ? await generator(params.app) : go('apps');
      case 'batch': return await batchPage(params.id);
      case 'library': return await library();
      case 'brands': return await brands();
      case 'credits': return await creditsPage();
      case 'history': return await history();
      case 'admin': return await adminMargin();
      case 'job': return await jobView(params.id);
      case 'billing': return await billingReturn(params);
      default: return go('dash');
    }
  } catch (e) {
    if (e.status === 401) { state.user = null; return gate('login'); }
    document.getElementById('view').innerHTML =
      `<div class="card empty"><b>Impossible d'afficher cette page</b>
       <p>${esc(e.message)}</p>
       <button class="btn" style="margin-top:14px" data-go="dash">Retour au tableau de bord</button></div>`;
  }
}

async function jobView(id) {
  const v = document.getElementById('view');
  v.innerHTML = '<div class="empty"><div class="spin"></div>Chargement…</div>';
  const j = await api(`/jobs/${id}`);

  v.innerHTML = `
    <div class="head"><div class="between">
      <div><h1>${esc(j.app_id)}</h1>
        <p>${j.status === 'succeeded' ? 'Production terminée' : 'État : ' + esc(j.status)}
        ${j.served_from_cache ? ' · servi depuis le cache, sans débit' : ''}</p></div>
      <button class="btn btn-s" data-go="dash">← Tableau de bord</button>
    </div></div>

    <div class="card" style="overflow:hidden">
      <div class="out">${j.assets?.length
        ? j.assets.map((a) => a.kind === 'video'
            ? `<video src="${esc(a.url)}" controls style="max-height:520px;border-radius:6px"></video>`
            : `<img src="${esc(a.url)}" alt="">`).join('')
        : j.output_text
          ? `<pre class="result">${esc(pretty(j.output_text))}</pre>`
          : `<div class="dim">${esc(j.error_message ?? 'Aucun rendu')}</div>`}</div>
      <div class="canvas-f">
        <span class="dim" style="font-size:12px">
          ${j.served_from_cache ? '0 crédit' : j.credit_cost + ' crédits'}
          ${j.provider ? ' · ' + esc(j.provider) : ''}</span>
        ${j.assets?.length
          ? `<a class="btn btn-s" href="${esc(j.assets[0].url)}" download>Télécharger</a>` : ''}
      </div>
    </div>`;
}

function pretty(raw) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

/** Retour depuis la page de paiement Konnect. */
async function billingReturn(params) {
  const v = document.getElementById('view');
  v.innerHTML = '<div class="empty"><div class="spin"></div>Vérification du paiement…</div>';

  if (!params.p) return go('credits');

  // On interroge quelques fois : le webhook et le retour client peuvent
  // arriver dans n'importe quel ordre.
  for (let i = 0; i < 5; i++) {
    const p = await api(`/payments/${params.p}`).catch(() => null);
    if (p?.status === 'paid') {
      await refreshBalance();
      v.innerHTML = `<div class="card empty">
        <b>Paiement confirmé</b>
        <p>${credits(p.credits)} crédits ont été ajoutés à votre solde.</p>
        <button class="btn btn-p" style="margin-top:14px" data-go="apps">Produire un visuel</button>
      </div>`;
      return;
    }
    if (p?.status === 'failed' || p?.status === 'expired') {
      v.innerHTML = `<div class="card empty">
        <b>Le paiement n'a pas abouti</b>
        <p>Aucun crédit n'a été débité de votre carte.</p>
        <button class="btn btn-p" style="margin-top:14px" data-go="credits">Réessayer</button>
      </div>`;
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  v.innerHTML = `<div class="card empty">
    <b>Paiement en cours de validation</b>
    <p>Votre banque n'a pas encore confirmé. Les crédits apparaîtront
    automatiquement, sans action de votre part.</p>
    <button class="btn" style="margin-top:14px" data-go="credits">Voir mes crédits</button>
  </div>`;
}

// ---------------------------------------------------------------------------
/** Page publique : vitrine, puis inscription ou connexion à la demande. */
async function showLanding() {
  await landing(root());
  root().querySelectorAll('[data-auth]').forEach((b) => {
    b.onclick = () => gate(b.dataset.auth);
  });
}

async function boot() {
  try {
    const me = await api('/auth/me');
    state.user = me.user;
    state.workspace = me.workspace;
    state.balance = me.balance;
    shell();
    await render();
  } catch (e) {
    if (e.status === 401) {
      // Un lien direct vers une page de l'outil mène à la connexion ;
      // une arrivée sur la racine mène à la vitrine.
      const r = readRoute();
      if (location.hash && r.route !== 'dash') gate('login');
      else await showLanding();
    } else {
      root().innerHTML = `<div class="gate"><div class="gate-box">
        <div class="card pad empty"><b>Service indisponible</b>
        <p>${esc(e.message)}</p></div></div></div>`;
    }
  }
}

onRoute(() => { if (state.user) render(); });
boot();
