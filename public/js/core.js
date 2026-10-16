/* =========================================================================
   Noyau de l'interface : appels API, état, rendu, notifications.
   Pas de framework — l'application est petite et le rendu reste explicite,
   ce qui évite une chaîne de compilation côté client.
   ====================================================================== */

export const state = {
  user: null, workspace: null, balance: { balance: 0, held: 0, spendable: 0 },
  apps: [], route: 'dash', params: {},
};

// ---------------------------------------------------------------------------
// Appels API
// ---------------------------------------------------------------------------
export async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', headers: {}, ...opts };

  if (init.body && !(init.body instanceof FormData)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }

  const res = await fetch(`/api${path}`, init);

  if (res.status === 204) return null;

  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    if (!res.ok) throw Object.assign(new Error('Erreur réseau'), { status: res.status });
    return res;
  }

  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.message ?? 'Erreur'), {
      status: res.status, code: data.error, detail: data,
    });
  }
  return data;
}

// ---------------------------------------------------------------------------
// Rendu : fonctions utilitaires plutôt qu'un moteur de template
// ---------------------------------------------------------------------------

/** Échappement obligatoire sur toute donnée venant du serveur. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function mount(target, html) {
  const node = typeof target === 'string' ? document.querySelector(target) : target;
  node.innerHTML = html;
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Délégation d'évènements : survit au remplacement du contenu. */
export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const match = e.target.closest(selector);
    if (match && root.contains(match)) handler(e, match);
  });
}

// ---------------------------------------------------------------------------
// Mise en forme
// ---------------------------------------------------------------------------
export const nf = new Intl.NumberFormat('fr-FR');

export function credits(n) { return nf.format(Number(n ?? 0)); }

/** Les prix sont en millimes : 60000 → « 60,000 TND ». */
export function tnd(millimes) {
  const n = Number(millimes ?? 0) / 1000;
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' TND';
}

export function ago(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 604800) return `il y a ${Math.floor(s / 86400)} j`;
  return new Date(iso).toLocaleDateString('fr-FR');
}

export function dateTime(iso) {
  return new Date(iso).toLocaleString('fr-FR',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function bytes(n) {
  n = Number(n ?? 0);
  if (n < 1024) return `${n} o`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1048576).toFixed(1)} Mo`;
}

/** Les titres du catalogue sont multilingues ; on retombe sur ce qui existe. */
export function t(obj, fallback = '') {
  if (!obj) return fallback;
  if (typeof obj === 'string') return obj;
  return obj.fr ?? obj.en ?? obj.ar ?? fallback;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const node = el(`<div class="toast ${kind}">${esc(message)}</div>`);
  box.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 250);
  }, kind === 'err' ? 6000 : 3600);
}

export const ok = (m) => toast(m, 'ok');
export const err = (e) => toast(typeof e === 'string' ? e : (e?.message ?? 'Erreur'), 'err');

// ---------------------------------------------------------------------------
// Fenêtre modale
// ---------------------------------------------------------------------------
export function modal(title, bodyHtml, onMount) {
  const bg = el(`
    <div class="modal-bg">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-h">
          <h2>${esc(title)}</h2>
          <button class="btn btn-s" data-close>Fermer</button>
        </div>
        <div class="modal-b">${bodyHtml}</div>
      </div>
    </div>`);

  const close = () => bg.remove();
  bg.addEventListener('click', (e) => {
    if (e.target === bg || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', function esc_(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_); }
  });

  document.body.appendChild(bg);
  onMount?.(bg, close);
  return close;
}

export function confirmDialog(question, detail = '') {
  return new Promise((resolve) => {
    const close = modal('Confirmation', `
      <p style="margin-bottom:6px">${esc(question)}</p>
      ${detail ? `<p class="mute" style="font-size:13px">${esc(detail)}</p>` : ''}
      <div class="row" style="margin-top:20px;justify-content:flex-end">
        <button class="btn" data-no>Annuler</button>
        <button class="btn btn-p" data-yes>Confirmer</button>
      </div>`, (bg, done) => {
      bg.querySelector('[data-yes]').onclick = () => { done(); resolve(true); };
      bg.querySelector('[data-no]').onclick = () => { done(); resolve(false); };
    });
    void close;
  });
}

// ---------------------------------------------------------------------------
// Navigation : routage par fragment, pour que le rechargement fonctionne
// ---------------------------------------------------------------------------
const listeners = [];
export function onRoute(fn) { listeners.push(fn); }

export function go(route, params = {}) {
  const q = new URLSearchParams(params).toString();
  location.hash = `#/${route}${q ? '?' + q : ''}`;
}

export function readRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dash';
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return {
    route: parts[0] || 'dash',
    sub: parts[1] ?? null,
    params: Object.fromEntries(new URLSearchParams(qs ?? '')),
  };
}

window.addEventListener('hashchange', () => {
  const r = readRoute();
  state.route = r.route; state.params = r.params;
  listeners.forEach((fn) => fn(r));
});

export async function refreshBalance() {
  try {
    state.balance = await api('/credits');
    const b = document.getElementById('bal');
    if (b) b.textContent = credits(state.balance.spendable);
    const g = document.getElementById('gauge');
    if (g) {
      const pct = state.balance.lifetimeIn
        ? Math.max(3, Math.min(100, (state.balance.spendable / state.balance.lifetimeIn) * 100))
        : 0;
      g.style.width = pct + '%';
      g.style.background = state.balance.spendable < 50 ? 'var(--ocre)' : 'var(--green)';
    }
  } catch { /* silencieux : l'affichage du solde n'est pas critique */ }
}
