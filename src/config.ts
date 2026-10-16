/**
 * Configuration centrale. Lue une fois au démarrage et validée.
 * Un démarrage échoue bruyamment plutôt que de tomber en panne à la
 * première requête sur une variable oubliée.
 */
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET doit faire au moins 16 caractères'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),

  // Stockage : s3 (Cloudflare R2, AWS, Backblaze…) ou disque local
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE: z.string().optional(),

  // Fournisseurs d'IA — tous facultatifs : sans clé, le fournisseur de
  // démonstration prend le relais pour que la plateforme reste testable.
  BYTEPLUS_API_KEY: z.string().optional(),
  BYTEPLUS_BASE_URL: z.string().default('https://ark.ap-southeast.bytepluses.com/api/v3'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),
  FAL_API_KEY: z.string().optional(),

  // Paiement par carte — Konnect
  KONNECT_API_KEY: z.string().optional(),
  KONNECT_WALLET_ID: z.string().optional(),
  KONNECT_BASE_URL: z.string().default('https://api.konnect.network/api/v2'),
  KONNECT_SANDBOX: z.coerce.boolean().default(false),

  // Règles métier
  SIGNUP_BONUS_CREDITS: z.coerce.number().default(100),
  HOLD_TTL_SECONDS: z.coerce.number().default(900),
  WORKER_CONCURRENCY: z.coerce.number().default(10),
  RUN_WORKER_IN_PROCESS: z.coerce.boolean().default(true),
  DEDUP_ENABLED: z.coerce.boolean().default(true),
  MAX_BATCH_ROWS: z.coerce.number().default(500),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error('Configuration invalide :\n' + issues);
  process.exit(1);
}

export const config = parsed.data;

export const isProd = config.NODE_ENV === 'production';

/** Un fournisseur n'est utilisable que si sa clé est présente. */
export const enabled = {
  byteplus: !!config.BYTEPLUS_API_KEY,
  anthropic: !!config.ANTHROPIC_API_KEY,
  fal: !!config.FAL_API_KEY,
  konnect: !!(config.KONNECT_API_KEY && config.KONNECT_WALLET_ID),
  s3: config.STORAGE_DRIVER === 's3'
      && !!config.S3_BUCKET && !!config.S3_ACCESS_KEY_ID,
  redis: !!config.REDIS_URL,
};
