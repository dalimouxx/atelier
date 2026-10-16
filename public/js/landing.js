/* =========================================================================
   Vitrine publique.

   Le héros n'est ni un titre ni un chiffre : c'est la transformation
   elle-même. Une photo de téléphone à gauche, le visuel fini à droite,
   et un curseur que le visiteur fait glisser. C'est ce que le produit
   fait, montré plutôt que raconté.

   Les deux panneaux sont des illustrations vectorielles, pas de fausses
   photos de clients : on montre le principe sans prétendre exhiber un
   résultat qui n'existe pas.
   ====================================================================== */
import { api, esc, $, nf } from './core.js';

/* ---------------------------------------------------------------------
   Illustration : la photo de téléphone, avant
   ------------------------------------------------------------------ */
const AVANT = `
<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-label="Photo de produit prise au téléphone, fond encombré">
  <defs>
    <linearGradient id="mur" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#C9C4BA"/><stop offset="1" stop-color="#A89F91"/>
    </linearGradient>
  </defs>
  <rect width="800" height="600" fill="url(#mur)"/>
  <!-- plan de travail encombré -->
  <rect y="392" width="800" height="208" fill="#8C7A64"/>
  <rect y="392" width="800" height="12" fill="#6F5F4D"/>
  <circle cx="118" cy="352" r="42" fill="#9A8E7C"/>
  <rect x="616" y="286" width="104" height="106" rx="8" fill="#A4977F"/>
  <rect x="648" y="258" width="40" height="30" rx="5" fill="#8C8070"/>
  <path d="M0 150 L800 128" stroke="#8E8678" stroke-width="7" fill="none"/>
  <!-- ombre dure, lumière de plafonnier -->
  <ellipse cx="432" cy="470" rx="128" ry="22" fill="#5B4C3C" opacity=".46"/>
  <!-- bouteille, légèrement de travers -->
  <g transform="rotate(-6 400 340)">
    <rect x="356" y="196" width="88" height="268" rx="16" fill="#3F6B45"/>
    <rect x="378" y="150" width="44" height="54" rx="8" fill="#3F6B45"/>
    <rect x="374" y="136" width="52" height="22" rx="7" fill="#2A4A2F"/>
    <rect x="366" y="282" width="68" height="104" rx="6" fill="#EFE7D4"/>
    <rect x="378" y="304" width="44" height="7" rx="3" fill="#8C7A3E"/>
    <rect x="378" y="320" width="44" height="7" rx="3" fill="#B6AC92"/>
    <rect x="384" y="336" width="32" height="7" rx="3" fill="#B6AC92"/>
    <rect x="368" y="212" width="18" height="212" rx="9" fill="#5B8A61" opacity=".55"/>
  </g>
  <!-- reflet de flash -->
  <ellipse cx="300" cy="238" rx="86" ry="56" fill="#FFFFFF" opacity=".16"/>
  <!-- objet parasite au bord du cadre -->
  <rect x="-20" y="430" width="120" height="76" rx="10" fill="#B4453A"/>
</svg>`;

/* ---------------------------------------------------------------------
   Illustration : le packshot, après
   ------------------------------------------------------------------ */
const APRES = `
<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-label="Le même produit en photo studio sur fond blanc">
  <defs>
    <radialGradient id="fond" cx="50%" cy="38%" r="76%">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#EDF0F8"/>
    </radialGradient>
    <linearGradient id="verre" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2E7A4F"/>
      <stop offset=".34" stop-color="#4FA873"/>
      <stop offset=".62" stop-color="#2E7A4F"/>
      <stop offset="1" stop-color="#215C3B"/>
    </linearGradient>
  </defs>
  <rect width="800" height="600" fill="url(#fond)"/>
  <!-- ombre de contact douce -->
  <ellipse cx="400" cy="470" rx="104" ry="17" fill="#141C3A" opacity=".13"/>
  <ellipse cx="400" cy="470" rx="58" ry="10" fill="#141C3A" opacity=".1"/>
  <!-- bouteille, droite et centrée -->
  <rect x="356" y="196" width="88" height="270" rx="17" fill="url(#verre)"/>
  <rect x="378" y="148" width="44" height="54" rx="8" fill="url(#verre)"/>
  <rect x="374" y="132" width="52" height="22" rx="7" fill="#1B4730"/>
  <rect x="364" y="280" width="72" height="108" rx="7" fill="#FFFFFF"/>
  <rect x="378" y="302" width="44" height="8" rx="4" fill="#12A67C"/>
  <rect x="376" y="320" width="48" height="7" rx="3.5" fill="#C9D0E6"/>
  <rect x="384" y="336" width="32" height="7" rx="3.5" fill="#C9D0E6"/>
  <rect x="382" y="356" width="36" height="7" rx="3.5" fill="#FFC53D"/>
  <!-- reflet vertical maîtrisé -->
  <rect x="370" y="214" width="15" height="218" rx="7.5" fill="#FFFFFF" opacity=".42"/>
  <rect x="424" y="236" width="7" height="176" rx="3.5" fill="#FFFFFF" opacity=".2"/>
</svg>`;

/* ---------------------------------------------------------------------
   Vignettes des catégories — formes pleines, pas de fausses photos
   ------------------------------------------------------------------ */
function vignetteImage() {
  return `<svg viewBox="0 0 400 275" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="400" height="275" fill="#E6ECFE"/>
    <rect x="128" y="74" width="144" height="150" rx="14" fill="#2F5BEA"/>
    <rect x="152" y="104" width="96" height="10" rx="5" fill="#FFFFFF" opacity=".92"/>
    <rect x="152" y="126" width="68" height="10" rx="5" fill="#FFFFFF" opacity=".55"/>
    <ellipse cx="200" cy="240" rx="80" ry="11" fill="#141C3A" opacity=".12"/>
    <circle cx="316" cy="62" r="26" fill="#FFC53D"/>
  </svg>`;
}
function vignetteVideo() {
  return `<svg viewBox="0 0 400 275" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="400" height="275" fill="#EFE7FE"/>
    <rect x="104" y="58" width="192" height="160" rx="16" fill="#7B3FE4"/>
    <path d="M178 112 L232 139 L178 166 Z" fill="#FFFFFF"/>
    <rect x="104" y="232" width="192" height="8" rx="4" fill="#7B3FE4" opacity=".28"/>
    <rect x="104" y="232" width="78" height="8" rx="4" fill="#7B3FE4"/>
  </svg>`;
}
function vignetteTexte() {
  return `<svg viewBox="0 0 400 275" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="400" height="275" fill="#DEF5EE"/>
    <rect x="96" y="54" width="208" height="168" rx="14" fill="#FFFFFF"/>
    <rect x="120" y="82" width="124" height="13" rx="6.5" fill="#12A67C"/>
    <rect x="120" y="112" width="160" height="9" rx="4.5" fill="#C9D0E6"/>
    <rect x="120" y="130" width="148" height="9" rx="4.5" fill="#C9D0E6"/>
    <rect x="120" y="148" width="160" height="9" rx="4.5" fill="#C9D0E6"/>
    <rect x="120" y="178" width="56" height="20" rx="10" fill="#FFC53D"/>
    <rect x="186" y="178" width="46" height="20" rx="10" fill="#E6ECFE"/>
  </svg>`;
}

/* ------------------------------------------------------------------ */
export async function landing(root) {
  let packs = [];
  try { packs = (await api('/packs')).packs ?? []; } catch { /* vitrine sans tarifs */ }

  root.innerHTML = `
  <header class="site-bar">
    <div class="site">
      <span class="logo"><span class="mark">A</span>Atelier</span>
      <nav>
        <button class="btn btn-s" data-auth="login">Se connecter</button>
        <button class="btn btn-s btn-p" data-auth="signup">Créer un compte</button>
      </nav>
    </div>
  </header>

  <section class="hero">
    <div class="site">
      <div>
        <h1 class="display">Photographiez votre produit.<em>Le reste, c'est nous.</em></h1>
        <p>Une photo prise au téléphone devient un visuel de boutique, une mise
        en situation ou un clip vidéo. Sans studio, sans photographe, sans
        attendre trois jours.</p>
        <div class="hero-actions">
          <button class="btn btn-lg btn-p" data-auth="signup">Commencer gratuitement</button>
          <button class="btn btn-lg" data-scroll="#produire">Voir des exemples</button>
        </div>
        <p class="hero-note">100 crédits offerts à l'inscription, de quoi produire
        une vingtaine de visuels. Aucune carte demandée.</p>
      </div>

      <div class="compare" id="compare" role="group"
           aria-label="Comparaison avant et après. Faites glisser pour révéler.">
        <div class="avant">${AVANT}</div>
        <div class="apres" id="apres">${APRES}</div>
        <span class="compare-etiq g">Votre photo</span>
        <span class="compare-etiq d">Le rendu</span>
        <div class="compare-poignee" id="poignee"><span>◀▶</span></div>
      </div>
    </div>
  </section>

  <section class="bande" id="produire">
    <div class="site">
      <h2 class="display">Ce que vous pouvez produire</h2>
      <p>Chaque application est une recette prête. Vous envoyez une photo, vous
      choisissez, vous récupérez un fichier publiable.</p>

      <div class="vitrine">
        <article class="vcarte">
          <div class="toile">${vignetteImage()}</div>
          <div class="corps">
            <h3>Photos de produit</h3>
            <p>Fond blanc conforme aux marketplaces, mise en situation dans une
            vraie scène, essayage sur mannequin, bannières publicitaires à tous
            les formats.</p>
            <div class="pied">
              <span class="chip c-bleu">à partir de 4 crédits</span>
              <span class="dim" style="font-size:13px">environ 20 s</span>
            </div>
          </div>
        </article>

        <article class="vcarte">
          <div class="toile">${vignetteVideo()}</div>
          <div class="corps">
            <h3>Vidéos courtes</h3>
            <p>Un clip de cinq secondes à partir d'une seule photo : mouvement
            de caméra autour du produit, ou format vertical pour les réseaux.</p>
            <div class="pied">
              <span class="chip c-figue">à partir de 55 crédits</span>
              <span class="dim" style="font-size:13px">environ 1 min 30</span>
            </div>
          </div>
        </article>

        <article class="vcarte">
          <div class="toile">${vignetteTexte()}</div>
          <div class="corps">
            <h3>Fiches et campagnes</h3>
            <p>Titre, arguments, description et mots-clés en français, arabe ou
            anglais. Et un calendrier de publications sur deux semaines.</p>
            <div class="pied">
              <span class="chip c-menthe">à partir de 2 crédits</span>
              <span class="dim" style="font-size:13px">environ 8 s</span>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>

  <section class="etapes">
    <div class="site">
      <h2 class="display">Comment ça marche</h2>
      <ol>
        <li>
          <span class="n">1</span>
          <h3>Envoyez une photo</h3>
          <p>Prise au téléphone, sur un coin de table. Ni cadrage ni lumière
          particulière ne sont nécessaires.</p>
        </li>
        <li>
          <span class="n">2</span>
          <h3>Choisissez le rendu</h3>
          <p>Le coût en crédits est affiché avant de lancer. Vous savez toujours
          ce que vous allez dépenser.</p>
        </li>
        <li>
          <span class="n">3</span>
          <h3>Récupérez le fichier</h3>
          <p>Prêt à publier. Si la génération échoue, vos crédits vous sont
          rendus automatiquement.</p>
        </li>
      </ol>
    </div>
  </section>

  <section class="tarifs">
    <div class="site">
      <h2 class="display">Vous payez ce que vous produisez</h2>
      <p>Pas d'abonnement. Vous achetez des crédits, ils ne périment pas, et
      vous les dépensez quand vous en avez besoin.</p>

      <div class="grille-packs">
        ${packs.length ? packs.map((p) => {
          const total = p.credits + p.bonus_credits;
          return `<div class="tpack">
            <div class="credits">${nf.format(total)}</div>
            <div class="nom">crédits · ${esc(p.label)}</div>
            <div class="prix">${(p.price_tnd_mils / 1000).toLocaleString('fr-FR',
              { minimumFractionDigits: 3 })} TND</div>
            <div class="unite">${(p.price_tnd_mils / total).toFixed(1)} millimes le crédit</div>
            ${p.bonus_credits ? `<span class="offert">+${nf.format(p.bonus_credits)} offerts</span>` : ''}
          </div>`;
        }).join('') : ''}
      </div>

      <div style="margin-top:32px">
        <button class="btn btn-lg btn-j" data-auth="signup">Créer un compte</button>
      </div>
    </div>
  </section>

  <footer class="pied-site">
    <div class="site">
      <span>Atelier — visuels produit pour l'e-commerce</span>
      <span>Gabès, Tunisie</span>
    </div>
  </footer>`;

  brancherComparateur();

  root.querySelectorAll('[data-scroll]').forEach((b) => {
    b.onclick = () => document.querySelector(b.dataset.scroll)
      ?.scrollIntoView({ behavior: 'smooth' });
  });
}

/**
 * Le curseur avant/après. Mouvement déclenché par la personne, jamais
 * automatique : il répond à un geste et montre ce qui change.
 */
function brancherComparateur() {
  const box = $('#compare'), apres = $('#apres'), poignee = $('#poignee');
  if (!box) return;

  let actif = false;

  const placer = (clientX) => {
    const r = box.getBoundingClientRect();
    const pct = Math.max(4, Math.min(96, ((clientX - r.left) / r.width) * 100));
    apres.style.clipPath = `inset(0 0 0 ${pct}%)`;
    poignee.style.left = pct + '%';
  };

  const debut = (e) => {
    actif = true;
    placer(e.touches ? e.touches[0].clientX : e.clientX);
  };
  const bouge = (e) => {
    if (!actif) return;
    e.preventDefault();
    placer(e.touches ? e.touches[0].clientX : e.clientX);
  };
  const fin = () => { actif = false; };

  box.addEventListener('mousedown', debut);
  box.addEventListener('touchstart', debut, { passive: true });
  window.addEventListener('mousemove', bouge);
  window.addEventListener('touchmove', bouge, { passive: false });
  window.addEventListener('mouseup', fin);
  window.addEventListener('touchend', fin);

  // Accessible au clavier : la poignée est atteignable et déplaçable.
  poignee.tabIndex = 0;
  poignee.setAttribute('role', 'slider');
  poignee.setAttribute('aria-label', 'Révéler le rendu');
  poignee.setAttribute('aria-valuenow', '50');
  poignee.addEventListener('keydown', (e) => {
    const actuel = parseFloat(poignee.style.left) || 50;
    let suivant = actuel;
    if (e.key === 'ArrowLeft') suivant = Math.max(4, actuel - 6);
    if (e.key === 'ArrowRight') suivant = Math.min(96, actuel + 6);
    if (suivant === actuel) return;
    e.preventDefault();
    apres.style.clipPath = `inset(0 0 0 ${suivant}%)`;
    poignee.style.left = suivant + '%';
    poignee.setAttribute('aria-valuenow', String(Math.round(suivant)));
  });
}
