export type Modality = 'image' | 'video' | 'text';

export interface GenerateRequest {
  model: string;
  modality: Modality;
  prompt: string;
  /** URL temporaires des images d'entrée, lisibles par le fournisseur. */
  images?: string[];
  params?: Record<string, unknown>;
  /** Notre identifiant, transmis au fournisseur pour l'idempotence. */
  jobId: string;
}

export interface Output {
  url?: string;
  /** Contenu direct, quand le fournisseur ne passe pas par une URL. */
  buffer?: Buffer;
  kind: Modality;
  mime: string;
  durationMs?: number;
}

export interface GenerateResult {
  status: 'succeeded' | 'running' | 'failed';
  providerJobId?: string;
  outputs?: Output[];
  text?: string;
  /** Unités consommées, pour calculer le coût via le carnet de prix. */
  usage?: { unit: 'image' | 'second' | '1k_tokens' | 'call'; quantity: number };
  errorCode?: string;
  errorMessage?: string;
}

export interface Provider {
  readonly name: string;
  supports(m: Modality): boolean;
  submit(req: GenerateRequest): Promise<GenerateResult>;
  /** Interrogation d'un travail asynchrone (vidéo). */
  poll?(providerJobId: string): Promise<GenerateResult>;
}

export interface Route {
  provider: string;
  model: string;
}
