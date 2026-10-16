/**
 * Fournisseur de démonstration.
 *
 * Produit de vraies images PNG et de vraies réponses texte sans aucune clé
 * API. Sert à trois choses :
 *   1. tester la plateforme de bout en bout avant d'avoir les clés BytePlus ;
 *   2. garder le site vivant sur Render pour une démonstration client ;
 *   3. servir de filet quand tous les fournisseurs réels sont en panne.
 *
 * L'image est générée ici même, sans dépendance graphique : un PNG écrit
 * octet par octet, avec un dégradé déterministe dérivé du prompt. Deux
 * prompts différents donnent deux images différentes — ce qui permet de
 * vérifier visuellement que la bonne invite a circulé dans la chaîne.
 */
import { deflateSync } from 'zlib';
import { createHash as hash } from 'crypto';
import { Provider, GenerateRequest, GenerateResult, Modality } from './types';

// --- écriture PNG minimale ---------------------------------------------------
function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filtre : aucun
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 8 bits par canal
  ihdr[9] = 2;   // couleur vraie RVB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Trois couleurs stables dérivées du prompt. */
function paletteFor(seed: string): [number, number, number][] {
  const h = hash('sha256').update(seed).digest();
  const mk = (i: number): [number, number, number] => [
    60 + (h[i] % 150), 60 + (h[i + 1] % 150), 60 + (h[i + 2] % 150),
  ];
  return [mk(0), mk(3), mk(6)];
}

function demoImage(prompt: string, size: string): Buffer {
  const [w, h] = (() => {
    const m = /^(\d+)x(\d+)$/.exec(size);
    // On reste en basse résolution : l'image sert de témoin, pas de livrable.
    return m ? [Math.min(+m[1], 768), Math.min(+m[2], 768)] : [640, 640];
  })();

  const [a, b, c] = paletteFor(prompt);
  const seed = hash('sha256').update(prompt).digest();

  return png(w, h, (x, y) => {
    const fx = x / w, fy = y / h;
    // Dégradé diagonal entre deux teintes, plus un motif discret
    // dont la fréquence dépend du prompt.
    const t = (fx + fy) / 2;
    const freq = 3 + (seed[12] % 8);
    const wave = 0.07 * Math.sin(fx * freq * Math.PI) * Math.sin(fy * freq * Math.PI);
    const mix = Math.max(0, Math.min(1, t + wave));

    // Vignette, pour que ça ressemble à une photo plutôt qu'à un dégradé plat.
    const dx = fx - 0.5, dy = fy - 0.5;
    const vig = 1 - Math.min(0.45, (dx * dx + dy * dy) * 1.1);

    const ch = (i: 0 | 1 | 2) => {
      const base = mix < 0.5
        ? a[i] + (b[i] - a[i]) * (mix * 2)
        : b[i] + (c[i] - b[i]) * ((mix - 0.5) * 2);
      return Math.round(Math.max(0, Math.min(255, base * vig)));
    };
    return [ch(0), ch(1), ch(2)];
  });
}

/** Réponse texte plausible, en JSON quand le prompt en demande. */
function demoText(prompt: string): string {
  const wantsJson = /JSON strict|uniquement en JSON/i.test(prompt);
  if (!wantsJson) {
    return 'Réponse de démonstration. Configurez ANTHROPIC_API_KEY pour '
         + 'obtenir une génération réelle.';
  }
  if (/"days"/.test(prompt)) {
    const channels = ['Instagram', 'TikTok', 'Facebook'];
    const apps = ['product-on-white', 'lifestyle-scene', 'ad-banner', 'product-video'];
    return JSON.stringify({
      days: Array.from({ length: 14 }, (_, i) => ({
        day: i + 1,
        channel: channels[i % channels.length],
        format: i % 4 === 3 ? 'vidéo' : 'image',
        caption: `Publication de démonstration pour le jour ${i + 1}.`,
        app_id: apps[i % apps.length],
        inputs: { product_name: 'Produit de démonstration' },
      })),
    });
  }
  return JSON.stringify({
    title: 'Titre de démonstration — configurez une clé pour le rendu réel',
    bullets: [
      'Premier argument de démonstration',
      'Deuxième argument de démonstration',
      'Troisième argument de démonstration',
      'Quatrième argument de démonstration',
    ],
    description:
      'Ceci est une description de démonstration produite sans appel à un '
      + 'modèle. Renseignez ANTHROPIC_API_KEY pour une rédaction réelle.',
    seo_tags: ['démonstration', 'exemple', 'test'],
    meta_description: 'Fiche produit de démonstration.',
  });
}

export class DemoProvider implements Provider {
  readonly name = 'demo';
  /** Travaux vidéo en cours : identifiant → échéance simulée. */
  private pending = new Map<string, { at: number; prompt: string }>();

  supports(_m: Modality) { return true; }

  async submit(req: GenerateRequest): Promise<GenerateResult> {
    // Latence réaliste, pour que l'interface montre bien ses états d'attente.
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));

    if (req.modality === 'text') {
      const text = demoText(req.prompt);
      return {
        status: 'succeeded',
        providerJobId: `demo_${req.jobId}`,
        text,
        usage: { unit: '1k_tokens', quantity: text.length / 4000 },
      };
    }

    if (req.modality === 'video') {
      // La vidéo est asynchrone chez les vrais fournisseurs : on reproduit
      // ce comportement pour que le code de sondage soit réellement exercé.
      const id = `demo_${req.jobId}`;
      this.pending.set(id, { at: Date.now() + 6000, prompt: req.prompt });
      return { status: 'running', providerJobId: id };
    }

    const size = String(req.params?.size ?? '640x640');
    return {
      status: 'succeeded',
      providerJobId: `demo_${req.jobId}`,
      outputs: [{
        buffer: demoImage(req.prompt, size),
        kind: 'image',
        mime: 'image/png',
      }],
      usage: { unit: 'image', quantity: 1 },
    };
  }

  async poll(providerJobId: string): Promise<GenerateResult> {
    const job = this.pending.get(providerJobId);
    if (!job) {
      return { status: 'failed', errorCode: 'unknown_job' };
    }
    if (Date.now() < job.at) {
      return { status: 'running', providerJobId };
    }
    this.pending.delete(providerJobId);

    // Faute d'encodeur vidéo, on rend une image fixe marquée comme telle.
    // La chaîne complète (sondage, stockage, débit) est bien exercée.
    return {
      status: 'succeeded',
      providerJobId,
      outputs: [{
        buffer: demoImage(job.prompt + '::video', '768x432'),
        kind: 'image',
        mime: 'image/png',
      }],
      usage: { unit: 'second', quantity: 5 },
    };
  }
}
