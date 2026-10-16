/**
 * Registre et routeur de fournisseurs.
 *
 * Chaque application déclare ses `routes` par ordre de préférence. Le
 * routeur prend la première route utilisable : fournisseur enregistré,
 * clé présente, modalité supportée, disjoncteur fermé.
 *
 * Le disjoncteur évite d'envoyer cent travaux vers un fournisseur qui vient
 * de répondre 500 : après quelques échecs il est écarté une minute, puis
 * réessayé.
 */
import { enabled } from '../config';
import { Provider, Route, Modality } from './types';
import { DemoProvider } from './demo';
import { BytePlusProvider, AnthropicProvider, FalProvider } from './real';
import { query } from '../db';

export * from './types';

class Registry {
  private providers = new Map<string, Provider>();
  private failures = new Map<string, number>();
  private openUntil = new Map<string, number>();

  private readonly THRESHOLD = 3;
  private readonly COOLDOWN_MS = 60_000;

  register(p: Provider) { this.providers.set(p.name, p); return this; }

  get(name: string): Provider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`fournisseur inconnu : ${name}`);
    return p;
  }

  has(name: string) { return this.providers.has(name); }

  private isOpen(name: string) {
    const until = this.openUntil.get(name);
    if (until === undefined) return false;
    if (until <= Date.now()) { this.openUntil.delete(name); this.failures.delete(name); return false; }
    return true;
  }

  /** Signale un échec ; ouvre le disjoncteur au seuil. */
  recordFailure(name: string) {
    const n = (this.failures.get(name) ?? 0) + 1;
    this.failures.set(name, n);
    if (n >= this.THRESHOLD) {
      this.openUntil.set(name, Date.now() + this.COOLDOWN_MS);
      console.warn(`[providers] ${name} écarté ${this.COOLDOWN_MS / 1000}s après ${n} échecs`);
    }
  }

  recordSuccess(name: string) {
    this.failures.delete(name);
    this.openUntil.delete(name);
  }

  /** Première route utilisable, ou null si aucune. */
  select(routes: Route[], modality: Modality): Route | null {
    for (const r of routes) {
      const p = this.providers.get(r.provider);
      if (!p) continue;
      if (!p.supports(modality)) continue;
      if (this.isOpen(r.provider)) continue;
      return r;
    }
    return null;
  }

  /** Route de repli ignorant le disjoncteur — mieux que rien. */
  selectAny(routes: Route[], modality: Modality): Route | null {
    for (const r of routes) {
      const p = this.providers.get(r.provider);
      if (p?.supports(modality)) return r;
    }
    return null;
  }

  status() {
    return [...this.providers.keys()].map((name) => ({
      name,
      disponible: !this.isOpen(name),
      echecs: this.failures.get(name) ?? 0,
    }));
  }
}

export const registry = new Registry();

// Un fournisseur réel n'est enregistré que si sa clé existe : sans cela
// le routeur l'essaierait et échouerait sur chaque travail.
if (enabled.byteplus) registry.register(new BytePlusProvider());
if (enabled.anthropic) registry.register(new AnthropicProvider());
if (enabled.fal) registry.register(new FalProvider());
registry.register(new DemoProvider()); // toujours présent, en dernier recours

// ---------------------------------------------------------------------------
// Carnet de prix — lu en base, pas codé en dur
// ---------------------------------------------------------------------------
let costCache: { at: number; rows: any[] } = { at: 0, rows: [] };

async function costBook() {
  if (Date.now() - costCache.at < 300_000 && costCache.rows.length) {
    return costCache.rows;
  }
  const { rows } = await query(
    `SELECT DISTINCT ON (provider, model, unit)
            provider, model, unit, cost_usd_micros
       FROM provider_costs
      WHERE effective_from <= now()
      ORDER BY provider, model, unit, effective_from DESC`,
  );
  costCache = { at: Date.now(), rows };
  return rows;
}

/**
 * Coût réel d'un travail, en micro-dollars. Renvoie null si le tarif n'est
 * pas connu — mieux vaut une case vide dans le tableau des marges qu'un
 * chiffre inventé.
 */
export async function costOf(
  provider: string, model: string,
  usage?: { unit: string; quantity: number },
): Promise<number | null> {
  if (!usage) return null;
  const book = await costBook();
  const row = book.find(
    (r) => r.provider === provider && r.model === model && r.unit === usage.unit,
  );
  if (!row) return null;
  return Math.round(Number(row.cost_usd_micros) * usage.quantity);
}

export function invalidateCostBook() { costCache = { at: 0, rows: [] }; }
