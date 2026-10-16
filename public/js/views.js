/* =========================================================================
   Vues. Chaque fonction rend une page dans #view et branche ses évènements.
   ====================================================================== */
import {
  api, state, esc, el, $, $$, on, credits, tnd, ago, dateTime, bytes, t,
  toast, ok, err, modal, confirmDialog, go, refreshBalance, nf,
} from './core.js';

const view = () => document.getElementById('view');
const loading = (msg = 'Chargement…') =>
  `<div class="empty"><div class="spin"></div>${esc(msg)}</div>`;

const CATS = {
  ecommerce: 'Photo produit', video: 'Vidéo', agent: 'Rédaction',
};

// ===========================================================================
// Tableau de bord
// ===========================================================================
export async function dashboard() {
  view().innerHTML = loading();
  const [jobs, bal] = await Promise.all([api('/jobs?limit=18'), api('/credits')]);
  state.balance = bal;

  const done = jobs.filter((j) => j.status === 'succeeded');
  const cached = done.filter((j) => j.served_from_cache);
  const failed = jobs.filter((j) => j.status === 'failed');
  const running = jobs.filter((j) => ['queued', 'running'].includes(j.status));

  view().innerHTML = `
    <div class="stats">
      <div class="stat"><small>Solde disponible</small><b class="num">${credits(bal.spendable)}</b>
        <span class="dim" style="font-size:11.5px">${bal.held ? credits(bal.held) + ' réservés' : 'aucune réservation'}</span></div>
      <div class="stat"><small>Productions réussies</small><b class="num">${done.length}</b>
        <span class="dim" style="font-size:11.5px">sur les ${jobs.length} dernières</span></div>
      <div class="stat"><small>Servies depuis le cache</small><b class="num">${cached.length}</b>
        <span class="dim" style="font-size:11.5px">crédits économisés</span></div>
      <div class="stat"><small>Échecs remboursés</small><b class="num">${failed.length}</b>
        <span class="dim" style="font-size:11.5px">jamais facturés</span></div>
    </div>

    ${bal.spendable < 50 ? `
      <div class="alert a-jasmin" style="margin-bottom:20px">
        <span>◇</span>
        <div><b>Votre solde est bas.</b> Il vous reste ${credits(bal.spendable)} crédits,
        de quoi produire environ ${Math.floor(bal.spendable / 5)} visuels.
        <button class="btn btn-s" style="margin-top:9px" data-go="credits">Recharger</button></div>
      </div>` : ''}

    <div class="between" style="margin-bottom:13px">
      <h2>Production récente</h2>
      <div class="row" style="gap:8px">
        ${running.length ? `<span class="chip c-bleu">${running.length} en cours</span>` : ''}
        <button class="btn btn-s" data-go="apps">Nouvelle production</button>
      </div>
    </div>

    ${jobs.length ? `<div class="feed">${jobs.map(tile).join('')}</div>` : `
      <div class="card empty">
        <b>Rien produit pour l'instant</b>
        <p>Choisissez une application et envoyez une photo de produit.</p>
        <button class="btn btn-p" style="margin-top:14px" data-go="apps">Voir les applications</button>
      </div>`}`;

  if (running.length) setTimeout(() => { if (state.route === 'dash') dashboard(); }, 4000);
}

function tile(j) {
  const chips = {
    succeeded: j.served_from_cache
      ? '<span class="chip c-bleu">cache · 0 cr</span>'
      : `<span class="chip c-menthe">${j.credit_cost} cr</span>`,
    failed: '<span class="chip c-grenade">remboursé</span>',
    queued: '<span class="chip c-gris">en file</span>',
    running: '<span class="chip c-bleu">en cours</span>',
    cancelled: '<span class="chip c-gris">annulé</span>',
    blocked: '<span class="chip c-grenade">refusé</span>',
  };
  return `
    <article class="tile" data-job="${esc(j.id)}" style="cursor:pointer">
      ${['queued', 'running'].includes(j.status) ? '<span class="badge-run">en cours</span>' : ''}
      <div class="thumb">${j.preview
        ? `<img src="${esc(j.preview)}" alt="" loading="lazy">`
        : `<span class="ph">${esc(t(j.app_title, j.app_id))}</span>`}</div>
      <div class="tile-f"><span>${ago(j.created_at)}</span>${chips[j.status] ?? ''}</div>
    </article>`;
}

// ===========================================================================
// Catalogue
// ===========================================================================
export async function apps() {
  view().innerHTML = loading();
  if (!state.apps.length) state.apps = await api('/apps');

  const cats = [...new Set(state.apps.map((a) => a.category))];

  view().innerHTML = `
    <div class="head">
      <h1>Applications</h1>
      <p>Chaque application est une recette prête : vos photos en entrée, un rendu
      publiable en sortie. Le coût est fixe et affiché avant de lancer.</p>
    </div>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="true" data-cat="">Toutes</button>
      ${cats.map((c) => `<button role="tab" aria-selected="false" data-cat="${esc(c)}">${esc(CATS[c] ?? c)}</button>`).join('')}
    </div>
    <div class="apps" id="applist">${state.apps.map(appCard).join('')}</div>`;

  on(view(), 'click', '[data-cat]', (e, b) => {
    $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', 'false'));
    b.setAttribute('aria-selected', 'true');
    const cat = b.dataset.cat;
    $('#applist').innerHTML = state.apps
      .filter((a) => !cat || a.category === cat).map(appCard).join('');
  });
}

function appCard(a) {
  // La teinte dit la modalité, partout dans le site : bleu pour l'image,
  // figue pour la vidéo, menthe pour le texte.
  const teinte = { image: 'c-bleu', video: 'c-figue', text: 'c-menthe' }[a.modality];
  const bord = { image: '', video: 'm-video', text: 'm-texte' }[a.modality];
  const label = { image: 'Image', video: 'Vidéo', text: 'Texte' }[a.modality];
  return `
    <button class="app ${bord}" data-app="${esc(a.id)}">
      <div class="corps">
        <div class="between" style="align-items:flex-start">
          <h3>${esc(t(a.title, a.id))}</h3>
          <span class="chip ${teinte}">${label}</span>
        </div>
        <p>${esc(t(a.description, ''))}</p>
        <div class="app-f">
          <span class="chip ${teinte}">${a.credit_cost} crédits</span>
          <span class="dim" style="font-size:13px">environ ${a.est_seconds < 60
            ? a.est_seconds + ' s' : Math.round(a.est_seconds / 60) + ' min'}</span>
        </div>
      </div>
    </button>`;
}

// ===========================================================================
// Générateur
// ===========================================================================
let gen = { app: null, assets: [], brands: [], jobId: null, timer: null };

export async function generator(appId) {
  if (gen.timer) { clearInterval(gen.timer); gen.timer = null; }
  view().innerHTML = loading();

  const [app, brands] = await Promise.all([
    api(`/apps/${encodeURIComponent(appId)}`),
    api('/brands').catch(() => []),
  ]);
  gen = { app, assets: [], brands, jobId: null, timer: null };

  const schema = app.input_schema;
  const fields = Object.entries(schema.properties)
    .map(([key, f]) => fieldHtml(key, f, schema.required?.includes(key)))
    .join('');

  const needsImages = Object.values(schema.properties).some((f) => f.format === 'assets');

  view().innerHTML = `
    <div class="head">
      <div class="between">
        <div>
          <h1>${esc(t(app.title, app.id))}</h1>
          <p>${esc(t(app.description, ''))}</p>
        </div>
        <button class="btn btn-s" data-go="apps">← Applications</button>
      </div>
    </div>

    <div class="gen">
      <form class="card pad" id="genform">
        ${fields}
        ${gen.brands.length ? `
          <div class="fs">
            <label for="brandKit">Identité de marque</label>
            <select class="field" id="brandKit">
              <option value="">Aucune</option>
              ${gen.brands.map((b) => `<option value="${esc(b.id)}" ${b.is_default ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            </select>
          </div>` : ''}

        <div class="bill">
          <div><small>Coût de cette génération</small><b class="num">${app.credit_cost} crédits</b></div>
          <div class="right"><small>Solde après</small>
            <b class="num">${credits(Math.max(0, state.balance.spendable - app.credit_cost))}</b></div>
        </div>

        <button class="btn btn-p btn-blk" type="submit" id="gobtn"
          ${state.balance.spendable < app.credit_cost ? 'disabled' : ''}>
          ${state.balance.spendable < app.credit_cost ? 'Crédits insuffisants' : 'Générer'}
        </button>
        <p class="dim" style="font-size:11.5px;text-align:center;margin-top:8px">
          Les crédits sont réservés, puis débités seulement si le rendu aboutit.</p>
      </form>

      <div class="canvas">
        <div class="canvas-h">
          <h2 style="font-size:14px">Rendu</h2>
          <span id="genstatus" class="chip c-gris">en attente</span>
        </div>
        <div class="out" id="genout">
          <div class="dim" style="text-align:center">
            ${needsImages ? 'Envoyez une photo et lancez la génération'
                          : 'Remplissez le formulaire et lancez la génération'}
          </div>
        </div>
        <div class="canvas-f">
          <span class="dim" style="font-size:12px" id="gentime"></span>
          <div class="row" style="gap:8px" id="genactions"></div>
        </div>
      </div>
    </div>`;

  bindUploads();
  $('#genform').addEventListener('submit', submitGeneration);
}

function fieldHtml(key, f, required) {
  const label = esc(f.title ?? key);
  const req = required ? ' *' : '';

  if (f.format === 'assets') {
    return `
      <div class="fs">
        <label>${label}${req}</label>
        <div class="drop" data-drop>
          <b>Déposez une image ou cliquez</b>
          <small>JPG, PNG ou WebP${f.maxItems ? ` · ${f.maxItems} max` : ''}</small>
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden data-file>
        </div>
        <div class="thumbs" data-thumbs></div>
      </div>`;
  }
  if (f.enum) {
    return `
      <div class="fs">
        <label for="f_${key}">${label}${req}</label>
        <select class="field" id="f_${key}" name="${key}">
          ${f.enum.map((o) => `<option ${o === f.default ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        </select>
      </div>`;
  }
  if (f.format === 'textarea') {
    return `
      <div class="fs">
        <label for="f_${key}">${label}${req}</label>
        <textarea class="field" id="f_${key}" name="${key}"
          ${f.maxLength ? `maxlength="${f.maxLength}"` : ''}>${esc(f.default ?? '')}</textarea>
      </div>`;
  }
  return `
    <div class="fs">
      <label for="f_${key}">${label}${req}</label>
      <input class="field" id="f_${key}" name="${key}" value="${esc(f.default ?? '')}"
        ${f.maxLength ? `maxlength="${f.maxLength}"` : ''}>
    </div>`;
}

function bindUploads() {
  const drop = $('[data-drop]');
  if (!drop) return;
  const input = $('[data-file]', drop);

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    uploadFiles([...e.dataTransfer.files]);
  });
  input.addEventListener('change', () => uploadFiles([...input.files]));
}

async function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  files.slice(0, 5).forEach((f) => fd.append('files', f));

  const drop = $('[data-drop]');
  drop.innerHTML = '<div class="spin"></div><small>Envoi en cours…</small>';

  try {
    const out = await api('/uploads', { method: 'POST', body: fd });
    gen.assets.push(...out.assets);
    renderThumbs();
  } catch (e) {
    err(e);
  } finally {
    drop.innerHTML = `<b>Déposez une image ou cliquez</b>
      <small>JPG, PNG ou WebP</small>
      <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden data-file>`;
    bindUploads();
  }
}

function renderThumbs() {
  const box = $('[data-thumbs]');
  if (!box) return;
  box.innerHTML = gen.assets.map((a, i) => `
    <div class="mini">
      <img src="${esc(a.url)}" alt="">
      <button type="button" data-rm="${i}" title="Retirer">×</button>
    </div>`).join('');

  $$('[data-rm]', box).forEach((b) => b.onclick = () => {
    gen.assets.splice(Number(b.dataset.rm), 1);
    renderThumbs();
  });
}

async function submitGeneration(e) {
  e.preventDefault();
  const btn = $('#gobtn');
  btn.disabled = true; btn.textContent = 'Envoi…';

  const inputs = {};
  $$('#genform [name]').forEach((f) => { if (f.value) inputs[f.name] = f.value; });
  if (gen.assets.length) inputs.images = gen.assets.map((a) => a.id);

  try {
    const out = await api('/generate', {
      method: 'POST',
      body: {
        appId: gen.app.id, inputs,
        brandKitId: $('#brandKit')?.value || undefined,
      },
    });
    gen.jobId = out.jobId;

    if (out.cached) {
      ok('Déjà produit — resservi sans débit');
    } else {
      toast(`${out.creditCost} crédits réservés`);
    }
    pollJob(out.jobId, Date.now());
  } catch (e2) {
    err(e2);
    btn.disabled = false; btn.textContent = 'Générer';
    if (e2.code === 'insufficient_credits') go('credits');
  }
}

function pollJob(jobId, startedAt) {
  const out = $('#genout'), status = $('#genstatus'), time = $('#gentime');
  out.innerHTML = '<div style="text-align:center"><div class="spin"></div>'
                + '<div class="dim">Génération en cours…</div></div>';
  status.className = 'chip c-bleu'; status.textContent = 'en cours';

  if (gen.timer) clearInterval(gen.timer);
  gen.timer = setInterval(async () => {
    try {
      const j = await api(`/jobs/${jobId}`);
      const secs = Math.round((Date.now() - startedAt) / 1000);
      time.textContent = `${secs} s écoulées`;

      if (j.status === 'succeeded') {
        clearInterval(gen.timer); gen.timer = null;
        status.className = 'chip c-menthe'; status.textContent = 'terminé';

        if (j.output_text) {
          out.innerHTML = `<pre class="result">${esc(formatText(j.output_text))}</pre>`;
        } else if (j.assets?.length) {
          out.innerHTML = j.assets.map((a) => a.kind === 'video'
            ? `<video src="${esc(a.url)}" controls style="max-height:520px;border-radius:6px"></video>`
            : `<img src="${esc(a.url)}" alt="Rendu">`).join('');
        }

        $('#genactions').innerHTML = j.assets?.length
          ? `<a class="btn btn-s" href="${esc(j.assets[0].url)}" download>Télécharger</a>
             <button class="btn btn-s" data-again>Relancer</button>`
          : '<button class="btn btn-s" data-again>Relancer</button>';

        $('[data-again]').onclick = () => generator(gen.app.id);
        const btn = $('#gobtn');
        btn.disabled = false; btn.textContent = 'Générer à nouveau';
        refreshBalance();

      } else if (['failed', 'cancelled', 'blocked'].includes(j.status)) {
        clearInterval(gen.timer); gen.timer = null;
        status.className = 'chip c-grenade'; status.textContent = 'échec';
        out.innerHTML = `<div class="alert a-grenade" style="max-width:420px">
          <span>◇</span><div><b>La génération n'a pas abouti.</b><br>
          ${esc(j.error_message ?? j.error_code ?? 'Erreur inconnue')}<br>
          <span class="dim">Vos crédits ont été rendus.</span></div></div>`;
        const btn = $('#gobtn');
        btn.disabled = false; btn.textContent = 'Réessayer';
        refreshBalance();
      }
    } catch (e) {
      clearInterval(gen.timer); gen.timer = null; err(e);
    }
  }, 2000);
}

/** Les agents rendent du JSON : on l'affiche lisible plutôt que brut. */
function formatText(raw) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); }
  catch { return raw; }
}

// ===========================================================================
// Bibliothèque
// ===========================================================================
export async function library() {
  view().innerHTML = loading();
  const assets = await api('/assets?limit=60');

  view().innerHTML = `
    <div class="head">
      <h1>Bibliothèque</h1>
      <p>Tout ce que vous avez produit, hébergé chez nous. Les fichiers restent
      accessibles même si nous changeons de fournisseur.</p>
    </div>
    ${assets.length ? `<div class="lib">${assets.map((a) => `
      <div class="lib-i" data-asset="${esc(a.id)}" data-url="${esc(a.url)}" style="cursor:pointer">
        ${a.kind === 'video'
          ? `<video src="${esc(a.url)}" muted></video>`
          : `<img src="${esc(a.url)}" alt="" loading="lazy">`}
        <span>${esc(a.appId ?? a.kind)} · ${bytes(a.bytes)}</span>
      </div>`).join('')}</div>`
    : `<div class="card empty"><b>Bibliothèque vide</b>
        <p>Vos productions apparaîtront ici.</p>
        <button class="btn btn-p" style="margin-top:14px" data-go="apps">Produire un visuel</button>
      </div>`}`;

  on(view(), 'click', '[data-asset]', (e, node) => {
    const url = node.dataset.url;
    modal('Aperçu', `
      <img src="${esc(url)}" alt="" style="width:100%;border-radius:6px">
      <div class="row" style="margin-top:16px;justify-content:flex-end;gap:8px">
        <button class="btn btn-d" data-del="${esc(node.dataset.asset)}">Supprimer</button>
        <a class="btn btn-p" href="${esc(url)}" download>Télécharger</a>
      </div>`, (bg, close) => {
      bg.querySelector('[data-del]').onclick = async () => {
        if (!(await confirmDialog('Supprimer ce fichier ?', 'Cette action est définitive.'))) return;
        await api(`/assets/${node.dataset.asset}`, { method: 'DELETE' });
        close(); ok('Fichier supprimé'); library();
      };
    });
  });
}

// ===========================================================================
// Identité de marque
// ===========================================================================
export async function brands() {
  view().innerHTML = loading();
  const list = await api('/brands');

  view().innerHTML = `
    <div class="head">
      <div class="between">
        <div>
          <h1>Identité de marque</h1>
          <p>Renseignée une fois, appliquée à chaque génération : couleurs et ton
          passent dans toutes les applications sans les ressaisir.</p>
        </div>
        <button class="btn btn-p" data-new>Nouvelle identité</button>
      </div>
    </div>
    ${list.length ? `<div class="split">${list.map((b) => `
      <div class="card pad">
        <div class="between" style="margin-bottom:12px">
          <h2>${esc(b.name)}</h2>
          ${b.is_default ? '<span class="chip c-menthe">par défaut</span>' : ''}
        </div>
        <div class="pal" style="margin-bottom:12px">
          ${(b.palette ?? []).map((c) => `<div class="sw" style="background:${esc(c)}"></div>`).join('')
            || '<span class="dim" style="font-size:12.5px">aucune couleur</span>'}
        </div>
        <p class="mute" style="font-size:12.5px;min-height:38px">${esc(b.tone ?? 'Aucun ton défini')}</p>
        <div class="row" style="gap:8px;margin-top:12px">
          <button class="btn btn-s" data-edit="${esc(b.id)}">Modifier</button>
          ${b.is_default ? '' : `<button class="btn btn-s" data-default="${esc(b.id)}">Définir par défaut</button>`}
        </div>
      </div>`).join('')}</div>`
    : `<div class="card empty"><b>Aucune identité enregistrée</b>
        <p>Une identité renseignée réduit les reprises, donc les crédits dépensés.</p>
        <button class="btn btn-p" style="margin-top:14px" data-new>Créer une identité</button>
      </div>`}`;

  on(view(), 'click', '[data-new]', () => brandForm(null));
  on(view(), 'click', '[data-edit]', (e, b) =>
    brandForm(list.find((x) => x.id === b.dataset.edit)));
  on(view(), 'click', '[data-default]', async (e, b) => {
    await api(`/brands/${b.dataset.default}`, { method: 'PUT', body: { isDefault: true } });
    ok('Identité par défaut mise à jour'); brands();
  });
}

function brandForm(existing) {
  const palette = existing?.palette ?? ['#2E7A63', '#B9761F'];

  modal(existing ? 'Modifier l\'identité' : 'Nouvelle identité', `
    <div class="fs"><label for="bn">Nom</label>
      <input class="field" id="bn" value="${esc(existing?.name ?? '')}" placeholder="Zitouna"></div>
    <div class="fs"><label>Palette</label>
      <div class="pal" id="pal"></div>
      <div class="row" style="margin-top:9px;gap:8px">
        <input type="color" id="newcol" value="#1D5B8F" style="width:44px;height:34px;padding:2px;border:1px solid var(--line-2);border-radius:5px">
        <button class="btn btn-s" id="addcol" type="button">Ajouter la couleur</button>
      </div></div>
    <div class="fs"><label for="bt">Ton de la marque</label>
      <textarea class="field" id="bt" placeholder="Artisanal et sobre. Vocabulaire simple, pas de superlatifs.">${esc(existing?.tone ?? '')}</textarea></div>
    <label class="row" style="gap:8px;font-weight:400">
      <input type="checkbox" id="bd" ${existing?.is_default ? 'checked' : ''}>
      <span>Utiliser par défaut</span></label>
    <div class="row" style="margin-top:20px;justify-content:flex-end;gap:8px">
      <button class="btn" data-close>Annuler</button>
      <button class="btn btn-p" id="save">Enregistrer</button>
    </div>`, (bg, close) => {

    const draw = () => {
      bg.querySelector('#pal').innerHTML = palette.map((c, i) => `
        <div class="sw" style="background:${esc(c)}">
          <button type="button" data-rmc="${i}">×</button></div>`).join('')
        || '<span class="dim" style="font-size:12.5px">aucune couleur</span>';
      bg.querySelectorAll('[data-rmc]').forEach((b) => b.onclick = () => {
        palette.splice(Number(b.dataset.rmc), 1); draw();
      });
    };
    draw();

    bg.querySelector('#addcol').onclick = () => {
      if (palette.length >= 8) return err('Huit couleurs au maximum');
      palette.push(bg.querySelector('#newcol').value); draw();
    };

    bg.querySelector('#save').onclick = async () => {
      const body = {
        name: bg.querySelector('#bn').value.trim(),
        palette, tone: bg.querySelector('#bt').value.trim(),
        isDefault: bg.querySelector('#bd').checked,
      };
      if (!body.name) return err('Le nom est obligatoire');
      try {
        if (existing) await api(`/brands/${existing.id}`, { method: 'PUT', body });
        else await api('/brands', { method: 'POST', body });
        close(); ok('Identité enregistrée'); brands();
      } catch (e) { err(e); }
    };
  });
}

// ===========================================================================
// Crédits
// ===========================================================================
export async function creditsPage() {
  view().innerHTML = loading();
  const [{ packs, railAvailable }, bal, pays] = await Promise.all([
    api('/packs'), api('/credits'), api('/payments').catch(() => []),
  ]);
  state.balance = bal;
  let selected = packs[1]?.id ?? packs[0]?.id;

  view().innerHTML = `
    <div class="head">
      <h1>Crédits</h1>
      <p>Un crédit vaut la même chose dans toutes les applications. Le paiement se
      fait par carte bancaire, en dinars.</p>
    </div>

    <div class="card pad" style="margin-bottom:24px">
      <div class="between">
        <div><small class="mute">Solde disponible</small>
          <div style="font-size:26px;font-weight:600;letter-spacing:-.02em" class="num">${credits(bal.spendable)}</div></div>
        <div class="right">
          <small class="mute">Reçus au total</small>
          <div class="num" style="font-size:15px">${credits(bal.lifetimeIn)}</div>
          <small class="mute">Consommés</small>
          <div class="num" style="font-size:15px">${credits(bal.lifetimeOut)}</div>
        </div>
      </div>
    </div>

    ${!railAvailable ? `
      <div class="alert a-jasmin" style="margin-bottom:20px">
        <span>◇</span>
        <div><b>Le paiement par carte n'est pas encore activé sur cette installation.</b>
        Renseignez KONNECT_API_KEY et KONNECT_WALLET_ID pour ouvrir la vente.</div>
      </div>` : ''}

    <h2 style="margin-bottom:12px">Choisir un pack</h2>
    <div class="packs" id="packs">
      ${packs.map((p) => {
        const total = p.credits + p.bonus_credits;
        return `<button class="pack" data-pack="${esc(p.id)}" aria-pressed="${p.id === selected}">
          ${p.bonus_credits ? `<span class="tag">+${nf.format(p.bonus_credits)} offerts</span>` : ''}
          <b class="num">${nf.format(total)}</b>
          <span class="mute" style="font-size:13px">crédits · ${esc(p.label)}</span>
          <div style="margin-top:9px;font-weight:500">${tnd(p.price_tnd_mils)}</div>
          <div class="dim" style="font-size:11.5px;margin-top:3px">
            ${(p.price_tnd_mils / total).toFixed(1)} millimes le crédit</div>
        </button>`;
      }).join('')}
    </div>

    <div style="max-width:430px;margin-top:22px">
      <button class="btn btn-p btn-blk" id="pay" ${railAvailable ? '' : 'disabled'}>
        Payer par carte bancaire</button>
      <p class="dim" style="font-size:11.5px;text-align:center;margin-top:8px">
        Paiement sécurisé par Konnect — carte tunisienne, internationale ou e-DINAR.</p>
    </div>

    ${pays.length ? `
      <h2 style="margin:30px 0 12px">Paiements</h2>
      <div class="card"><table>
        <thead><tr><th>Date</th><th>Pack</th><th class="right">Crédits</th>
        <th class="right">Montant</th><th class="right">État</th></tr></thead>
        <tbody>${pays.map((p) => `<tr>
          <td class="mute">${dateTime(p.created_at)}</td>
          <td>${esc(p.pack_label ?? '—')}</td>
          <td class="right num">${credits(p.credits)}</td>
          <td class="right num">${tnd(p.amount_minor)}</td>
          <td class="right">${payChip(p.status)}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : ''}`;

  on(view(), 'click', '[data-pack]', (e, b) => {
    $$('.pack').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    selected = b.dataset.pack;
  });

  $('#pay').onclick = async () => {
    const btn = $('#pay');
    btn.disabled = true; btn.textContent = 'Préparation du paiement…';
    try {
      const out = await api('/credits/topup', { method: 'POST', body: { packId: selected } });
      location.href = out.redirectUrl;
    } catch (e) {
      err(e);
      btn.disabled = false; btn.textContent = 'Payer par carte bancaire';
    }
  };
}

function payChip(s) {
  const m = {
    paid: '<span class="chip c-menthe">payé</span>',
    pending: '<span class="chip c-jasmin">en attente</span>',
    failed: '<span class="chip c-grenade">échoué</span>',
    expired: '<span class="chip c-gris">expiré</span>',
    refunded: '<span class="chip c-gris">remboursé</span>',
  };
  return m[s] ?? esc(s);
}

// ===========================================================================
// Historique comptable
// ===========================================================================
export async function history() {
  view().innerHTML = loading();
  const rows = await api('/credits/history');

  const labels = {
    topup_card: 'Recharge par carte', topup_code: 'Carte à gratter',
    topup_manual: 'Recharge manuelle', signup_bonus: 'Crédits de bienvenue',
    referral: 'Parrainage', generation: 'Génération', refund: 'Remboursement',
    expiry: 'Expiration', adjustment: 'Ajustement',
  };

  view().innerHTML = `
    <div class="head">
      <h1>Historique</h1>
      <p>Chaque mouvement est inscrit une fois et ne peut plus être modifié.
      Une correction ajoute une ligne, elle n'en efface aucune.</p>
    </div>
    ${rows.length ? `<div class="card"><table>
      <thead><tr><th>Date</th><th>Mouvement</th><th>Référence</th>
      <th class="right">Crédits</th><th class="right">Solde</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="mute">${dateTime(r.created_at)}</td>
        <td>${esc(labels[r.reason] ?? r.reason)}
          ${r.metadata?.note ? `<br><small class="dim">${esc(r.metadata.note)}</small>` : ''}</td>
        <td class="mono dim">${esc(String(r.ref_id ?? '').slice(0, 8))}</td>
        <td class="right num" style="${Number(r.amount) > 0 ? 'color:var(--green);font-weight:500' : ''}">
          ${Number(r.amount) > 0 ? '+' : ''}${credits(r.amount)}</td>
        <td class="right num mute">${credits(r.balance_after)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<div class="card empty"><b>Aucun mouvement</b></div>'}`;
}
