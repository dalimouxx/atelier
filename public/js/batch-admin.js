/* =========================================================================
   Production en lot et administration.
   ====================================================================== */
import {
  api, state, esc, $, $$, on, credits, tnd, dateTime, nf, t,
  toast, ok, err, confirmDialog, go, refreshBalance,
} from './core.js';

const view = () => document.getElementById('view');
const loading = (m = 'Chargement…') => `<div class="empty"><div class="spin"></div>${esc(m)}</div>`;

// ===========================================================================
// Production en lot
// ===========================================================================
let lot = { file: null, columns: [], rows: [], app: null, batchId: null, timer: null };

export async function batchPage(batchId) {
  if (lot.timer) { clearInterval(lot.timer); lot.timer = null; }
  if (batchId) return batchDetail(batchId);

  view().innerHTML = loading();
  if (!state.apps.length) state.apps = await api('/apps');
  const list = await api('/batches');

  view().innerHTML = `
    <div class="head">
      <h1>Production en lot</h1>
      <p>Un catalogue entier en une opération. Chaque ligne du fichier devient une
      génération indépendante ; une ligne qui échoue n'est pas facturée.</p>
    </div>

    <div class="card pad" style="margin-bottom:26px">
      <h2 style="margin-bottom:14px">Nouveau lot</h2>
      <div class="split">
        <div>
          <div class="fs">
            <label for="bapp">Application</label>
            <select class="field" id="bapp">
              ${state.apps.map((a) => `<option value="${esc(a.id)}">${esc(t(a.title, a.id))} — ${a.credit_cost} cr</option>`).join('')}
            </select>
          </div>
          <div class="fs">
            <label for="blabel">Nom du lot</label>
            <input class="field" id="blabel" placeholder="Catalogue octobre">
          </div>
        </div>
        <div>
          <label>Fichier CSV</label>
          <div class="drop" id="csvdrop">
            <b>Déposez un fichier CSV ou cliquez</b>
            <small>Une ligne par référence, en-têtes sur la première ligne</small>
            <input type="file" accept=".csv,text/csv" hidden id="csvfile">
          </div>
          <div id="csvinfo" style="margin-top:10px"></div>
        </div>
      </div>
      <div id="mapping"></div>
    </div>

    <h2 style="margin-bottom:12px">Lots précédents</h2>
    ${list.length ? `<div class="card"><table>
      <thead><tr><th>Lot</th><th>Application</th><th class="right">Lignes</th>
      <th class="right">Réussies</th><th class="right">Échouées</th><th class="right">État</th></tr></thead>
      <tbody>${list.map((b) => `<tr data-batch="${esc(b.id)}" style="cursor:pointer">
        <td><b>${esc(b.label)}</b><br><small class="dim">${dateTime(b.created_at)}</small></td>
        <td class="mute">${esc(b.app_id)}</td>
        <td class="right num">${b.total_rows}</td>
        <td class="right num">${b.reussies}</td>
        <td class="right num">${b.echouees || '—'}</td>
        <td class="right">${batchChip(b.status)}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<div class="card empty"><b>Aucun lot pour l\'instant</b></div>'}`;

  const drop = $('#csvdrop'), file = $('#csvfile');
  drop.onclick = () => file.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove('over');
    loadCsv(e.dataTransfer.files[0]);
  };
  file.onchange = () => loadCsv(file.files[0]);

  on(view(), 'click', '[data-batch]', (e, tr) => go('batch', { id: tr.dataset.batch }));
}

function batchChip(s) {
  return {
    running: '<span class="chip c-blue">en cours</span>',
    paused: '<span class="chip c-ocre">suspendu</span>',
    done: '<span class="chip c-green">terminé</span>',
    cancelled: '<span class="chip c-gray">annulé</span>',
  }[s] ?? esc(s);
}

async function loadCsv(f) {
  if (!f) return;
  const fd = new FormData();
  fd.append('file', f);
  $('#csvinfo').innerHTML = '<div class="spin"></div>';

  try {
    const out = await api('/batches/parse', { method: 'POST', body: fd });
    lot.columns = out.columns; lot.rows = out.rows;

    $('#csvinfo').innerHTML = `
      <div class="alert a-green">
        <span>✓</span>
        <div><b>${out.rowCount} lignes lues.</b><br>
        Colonnes : ${out.columns.map((c) => esc(c)).join(', ')}</div>
      </div>`;
    renderMapping();
  } catch (e) {
    err(e);
    $('#csvinfo').innerHTML = `<div class="alert a-red"><span>◇</span><div>${esc(e.message)}</div></div>`;
  }
}

/**
 * Correspondance champ → colonne. Sans cette étape, l'utilisateur devrait
 * nommer ses colonnes exactement comme les champs internes.
 */
function renderMapping() {
  const app = state.apps.find((a) => a.id === $('#bapp').value);
  if (!app || !lot.rows.length) return;

  const props = Object.entries(app.input_schema.properties)
    .filter(([, f]) => f.format !== 'assets');

  const estimate = app.credit_cost * lot.rows.length;
  const assez = state.balance.spendable >= estimate;

  $('#mapping').innerHTML = `
    <div style="border-top:1px solid var(--line);margin:20px 0 18px"></div>
    <h3 style="margin-bottom:12px">Correspondance des colonnes</h3>
    <div class="split">
      ${props.map(([key, f]) => `
        <div class="fs">
          <label for="m_${key}">${esc(f.title ?? key)}
            ${app.input_schema.required?.includes(key) ? ' *' : ''}</label>
          <select class="field" data-map="${esc(key)}" id="m_${key}">
            <option value="">— valeur fixe —</option>
            ${lot.columns.map((c) => `<option value="${esc(c)}"
              ${c.toLowerCase().includes(key.split('_')[0]) ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
          <input class="field" data-fixed="${esc(key)}" style="margin-top:6px"
            placeholder="valeur appliquée à toutes les lignes">
        </div>`).join('')}
    </div>

    <div class="bill">
      <div><small>Coût estimé du lot</small>
        <b class="num">${credits(estimate)} crédits</b>
        <small>${lot.rows.length} lignes × ${app.credit_cost}</small></div>
      <div class="right"><small>Solde disponible</small>
        <b class="num" style="${assez ? '' : 'color:var(--red)'}">${credits(state.balance.spendable)}</b></div>
    </div>

    ${!assez ? `<div class="alert a-ocre" style="margin-bottom:14px"><span>◇</span>
      <div>Votre solde ne couvre pas tout le lot. Le traitement s'arrêtera de
      lui-même quand les crédits seront épuisés, sans rien facturer de plus.</div></div>` : ''}

    <button class="btn btn-p" id="startbatch">Lancer le lot</button>`;

  $('#startbatch').onclick = startBatch;
}

async function startBatch() {
  const btn = $('#startbatch');
  btn.disabled = true; btn.textContent = 'Lancement…';

  const mapping = {}, fixed = {};
  $$('[data-map]').forEach((s) => { if (s.value) mapping[s.dataset.map] = s.value; });
  $$('[data-fixed]').forEach((i) => { if (i.value.trim()) fixed[i.dataset.fixed] = i.value.trim(); });

  try {
    const out = await api('/batches', {
      method: 'POST',
      body: {
        appId: $('#bapp').value,
        label: $('#blabel').value.trim() || 'Lot sans nom',
        rows: lot.rows, mapping, fixed,
      },
    });
    ok(`${out.queued} lignes en file`);
    if (out.rejected) toast(`${out.rejected} ligne(s) rejetée(s)`, 'err');
    refreshBalance();
    go('batch', { id: out.batchId });
  } catch (e) {
    err(e);
    btn.disabled = false; btn.textContent = 'Lancer le lot';
  }
}

async function batchDetail(id) {
  view().innerHTML = loading();
  const render = async () => {
    const b = await api(`/batches/${id}`);
    const c = b.counts ?? {};

    view().innerHTML = `
      <div class="head">
        <div class="between">
          <div><h1>${esc(b.label)}</h1>
            <p>${b.totalRows} lignes · ${esc(b.appId)} · ${dateTime(b.createdAt)}</p></div>
          <button class="btn btn-s" data-go="batch">← Tous les lots</button>
        </div>
      </div>

      <div class="steps">
        <div class="step on"><b>1. Fichier</b>${b.totalRows} lignes</div>
        <div class="step on"><b>2. Application</b>${esc(b.appId)}</div>
        <div class="step ${b.progress > 0 ? 'on' : ''}"><b>3. Rendu</b>${b.progress}%</div>
        <div class="step ${b.status === 'done' ? 'on' : ''}"><b>4. Export</b>
          ${b.status === 'done' ? 'disponible' : 'en attente'}</div>
      </div>

      <div class="split">
        <div class="card pad">
          <h2 style="margin-bottom:12px">Avancement</h2>
          <table>
            <tr><td>Terminées</td><td class="right"><span class="chip c-green">${c.succeeded ?? 0}</span></td></tr>
            <tr><td>En cours</td><td class="right"><span class="chip c-blue">${c.running ?? 0}</span></td></tr>
            <tr><td>En file</td><td class="right"><span class="chip c-gray">${c.queued ?? 0}</span></td></tr>
            <tr><td>Échouées · remboursées</td><td class="right"><span class="chip c-red">${c.failed ?? 0}</span></td></tr>
          </table>
          <div class="bar" style="margin-top:14px;height:6px"><i style="width:${b.progress}%"></i></div>
          <p class="dim" style="font-size:12px;margin-top:7px">${b.progress}% · ${batchChip(b.status)}</p>
          <div class="row" style="margin-top:14px;gap:8px;flex-wrap:wrap">
            ${c.failed ? '<button class="btn btn-s" data-retry>Relancer les échecs</button>' : ''}
            ${b.status === 'paused' ? '<button class="btn btn-s" data-resume>Reprendre</button>' : ''}
            ${(c.queued || c.running) ? '<button class="btn btn-s btn-d" data-cancel>Suspendre</button>' : ''}
            ${c.succeeded ? `<a class="btn btn-s btn-p" href="/api/batches/${esc(id)}/export">Exporter le ZIP</a>` : ''}
          </div>
        </div>

        <div class="card pad">
          <h2 style="margin-bottom:12px">Crédits</h2>
          <table>
            <tr><td>Débité à ce jour</td><td class="right num">${credits(b.credits.debite)}</td></tr>
            <tr><td>Réservé (en vol)</td><td class="right num mute">${credits(b.credits.reserve)}</td></tr>
            <tr><td>Rendu après échec</td><td class="right num" style="color:var(--green)">${credits(b.credits.rendu)}</td></tr>
            <tr><td>Économisé par le cache</td><td class="right num" style="color:var(--green)">${credits(b.credits.economise)}</td></tr>
          </table>
        </div>
      </div>

      ${b.failures?.length ? `
        <h2 style="margin:26px 0 12px">Lignes en échec</h2>
        <div class="card"><table>
          <thead><tr><th>Ligne</th><th>Motif</th></tr></thead>
          <tbody>${b.failures.map((f) => `<tr>
            <td class="num">${f.row_index ?? '—'}</td>
            <td class="mute">${esc(f.error_message ?? f.error_code ?? 'inconnu')}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : ''}`;

    $('[data-retry]')?.addEventListener('click', async () => {
      const out = await api(`/batches/${id}/retry`, { method: 'POST' });
      ok(`${out.relaunched} ligne(s) relancée(s)`); render();
    });
    $('[data-resume]')?.addEventListener('click', async () => {
      await api(`/batches/${id}/resume`, { method: 'POST' }); ok('Lot repris'); render();
    });
    $('[data-cancel]')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Suspendre ce lot ?',
        'Les lignes en file seront annulées et leurs crédits rendus.'))) return;
      await api(`/batches/${id}/cancel`, { method: 'POST' });
      ok('Lot suspendu'); refreshBalance(); render();
    });

    if ((c.queued || c.running) && !lot.timer) {
      lot.timer = setInterval(() => {
        if (state.route !== 'batch') { clearInterval(lot.timer); lot.timer = null; return; }
        render();
      }, 4000);
    }
    if (!c.queued && !c.running && lot.timer) { clearInterval(lot.timer); lot.timer = null; }
  };

  await render();
}

// ===========================================================================
// Administration — marges
// ===========================================================================
export async function adminMargin() {
  view().innerHTML = loading();
  let data, health;
  try {
    [data, health] = await Promise.all([
      api('/admin/margin?days=30'), api('/admin/health'),
    ]);
  } catch (e) {
    view().innerHTML = `<div class="card empty"><b>Accès réservé</b>
      <p>${esc(e.message)}</p></div>`;
    return;
  }

  const usd = (micros) => '$' + (Number(micros ?? 0) / 1e6).toFixed(2);
  // Un crédit vaut environ 0,055 TND au pack Boutique ; on convertit en
  // dollars pour comparer au coût fournisseur, facturé en devise.
  const CREDIT_USD = 0.0175;
  const multiple = (cr, micros) => {
    const cost = Number(micros ?? 0) / 1e6;
    if (!cost) return null;
    return (Number(cr) * CREDIT_USD) / cost;
  };

  const tot = data.totaux;
  const totMult = multiple(tot.credits, tot.cout_micros);

  view().innerHTML = `
    <div class="head">
      <h1>Marges</h1>
      <p>Ce que les applications encaissent face à ce que les fournisseurs facturent
      réellement, sur ${data.jours} jours. Une application mal tarifée se voit ici
      avant de se voir en banque.</p>
    </div>

    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat"><small>Crédits consommés</small><b class="num">${credits(tot.credits)}</b>
        <span class="dim" style="font-size:11.5px">${tot.generations} générations</span></div>
      <div class="stat"><small>Coût fournisseurs</small><b class="num">${usd(tot.cout_micros)}</b>
        <span class="dim" style="font-size:11.5px">facturé en devise</span></div>
      <div class="stat"><small>Multiple moyen</small>
        <b class="num" style="${totMult && totMult < 2 ? 'color:var(--red)' : ''}">${totMult ? totMult.toFixed(1) + ' ×' : '—'}</b>
        <span class="dim" style="font-size:11.5px">objectif 3 ×</span></div>
      <div class="stat"><small>Servi par le cache</small><b class="num">${tot.cache}</b>
        <span class="dim" style="font-size:11.5px">coût fournisseur nul</span></div>
    </div>

    <div class="card" style="margin-bottom:24px">
      <table>
        <thead><tr><th>Application</th><th class="right">Générations</th>
          <th class="right">Cache</th><th class="right">Crédits</th>
          <th class="right">Coût réel</th><th class="right">Multiple</th></tr></thead>
        <tbody>${data.parApp.length ? data.parApp.map((r) => {
          const m = multiple(r.credits_encaisses, r.cout_micros);
          const cls = !m ? 'c-gray' : m < 1.8 ? 'c-red' : m < 2.5 ? 'c-ocre' : 'c-green';
          return `<tr>
            <td><b>${esc(r.titre ?? r.app_id)}</b><br><small class="dim">${esc(r.app_id)}</small></td>
            <td class="right num">${r.generations}</td>
            <td class="right num mute">${r.depuis_cache || '—'}</td>
            <td class="right num">${credits(r.credits_encaisses)}</td>
            <td class="right num">${usd(r.cout_micros)}</td>
            <td class="right"><span class="chip ${cls}">${m ? m.toFixed(1) + ' ×' : '—'}</span></td>
          </tr>`;
        }).join('') : '<tr><td colspan="6" class="empty">Aucune production sur la période</td></tr>'}</tbody>
      </table>
    </div>

    <h2 style="margin-bottom:12px">État du système</h2>
    <div class="split">
      <div class="card pad">
        <h3 style="margin-bottom:10px">Fournisseurs</h3>
        <table>${health.fournisseurs.map((p) => `<tr>
          <td>${esc(p.name)}</td>
          <td class="right">${p.disponible
            ? '<span class="chip c-green">disponible</span>'
            : `<span class="chip c-red">écarté (${p.echecs} échecs)</span>`}</td>
        </tr>`).join('')}</table>
      </div>
      <div class="card pad">
        <h3 style="margin-bottom:10px">Infrastructure</h3>
        <table>
          <tr><td>File d'attente</td><td class="right">${esc(health.file.type)}
            <span class="dim">(${health.file.waiting} en file, ${health.file.active} actifs)</span></td></tr>
          <tr><td>Stockage</td><td class="right">${esc(health.stockage)}</td></tr>
          <tr><td>Paiement carte</td><td class="right">${health.paiementCarte
            ? '<span class="chip c-green">configuré</span>'
            : '<span class="chip c-ocre">non configuré</span>'}</td></tr>
          <tr><td>Écarts comptables</td><td class="right">${health.ecartsLedger.length
            ? `<span class="chip c-red">${health.ecartsLedger.length} compte(s)</span>`
            : '<span class="chip c-green">aucun</span>'}</td></tr>
        </table>
      </div>
    </div>

    ${totMult && totMult < 2.5 ? `
      <div class="alert a-ocre" style="margin-top:20px"><span>◇</span>
        <div><b>Le multiple moyen est sous l'objectif.</b> Les applications en rouge
        travaillent à perte relative. Deux leviers : relever leur coût en crédits,
        ou les garder en produit d'appel et laisser les autres porter la marge.</div>
      </div>` : ''}`;
}
