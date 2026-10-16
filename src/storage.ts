/**
 * Stockage des fichiers.
 *
 * Deux pilotes : S3 (Cloudflare R2, AWS, Backblaze) en production, disque
 * local pour le développement et les tests. L'interface est identique, donc
 * aucun autre module ne sait lequel tourne.
 *
 * Point critique : les URL rendues par les fournisseurs d'IA expirent en
 * quelques heures. `ingest()` rapatrie le fichier chez nous immédiatement.
 * Sans cette étape, le travail du client disparaît tout seul.
 */
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join, resolve, normalize } from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand }
  from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import jwt from 'jsonwebtoken';
import { config, enabled } from './config';

export interface Stored {
  key: string;
  bytes: number;
  sha256: string;
  mime: string;
}

export interface StorageAdapter {
  put(key: string, body: Buffer, mime: string): Promise<Stored>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  /** URL temporaire lisible par le navigateur ou par un fournisseur. */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Disque local
// ---------------------------------------------------------------------------
class LocalStorage implements StorageAdapter {
  private root = resolve(config.LOCAL_STORAGE_DIR);

  /** Empêche qu'une clé forgée (« ../../etc/passwd ») sorte du dossier. */
  private path(key: string) {
    const safe = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    const full = resolve(join(this.root, safe));
    if (!full.startsWith(this.root)) throw new Error('clé de stockage invalide');
    return full;
  }

  async put(key: string, body: Buffer, mime: string): Promise<Stored> {
    const p = this.path(key);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    await fs.writeFile(p + '.meta', JSON.stringify({ mime }));
    return {
      key, bytes: body.length, mime,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string) { return fs.readFile(this.path(key)); }

  async mimeOf(key: string): Promise<string> {
    try {
      const raw = await fs.readFile(this.path(key) + '.meta', 'utf8');
      return JSON.parse(raw).mime ?? 'application/octet-stream';
    } catch { return 'application/octet-stream'; }
  }

  async remove(key: string) {
    await fs.unlink(this.path(key)).catch(() => {});
    await fs.unlink(this.path(key) + '.meta').catch(() => {});
  }

  /**
   * En local il n'y a pas de stockage objet signé : on émet un jeton court
   * que la route /files/* vérifie. Même propriété qu'une URL signée S3 —
   * le lien expire et ne peut pas être forgé.
   */
  async signedUrl(key: string, ttlSeconds = 3600) {
    const t = jwt.sign({ k: key }, config.JWT_SECRET, { expiresIn: ttlSeconds });
    return `${config.PUBLIC_BASE_URL}/files/${encodeURIComponent(key)}?t=${t}`;
  }
}

// ---------------------------------------------------------------------------
// S3 / R2
// ---------------------------------------------------------------------------
class S3Storage implements StorageAdapter {
  private client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: !!config.S3_ENDPOINT,
  });
  private bucket = config.S3_BUCKET!;

  async put(key: string, body: Buffer, mime: string): Promise<Stored> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: mime,
    }));
    return {
      key, bytes: body.length, mime,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket, Key: key,
    }));
    const chunks: Buffer[] = [];
    for await (const c of r.Body as any) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async signedUrl(key: string, ttlSeconds = 3600) {
    // Un bucket servi par un domaine public n'a pas besoin de signature.
    if (config.S3_PUBLIC_BASE) {
      return `${config.S3_PUBLIC_BASE.replace(/\/$/, '')}/${key}`;
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}

export const storage: StorageAdapter =
  enabled.s3 ? new S3Storage() : new LocalStorage();

export const storageDriver = enabled.s3 ? 's3' : 'local';
export const localStorage_ = storage instanceof LocalStorage ? storage : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3',
};

export function keyFor(workspaceId: string, scope: string, mime: string) {
  const ext = EXT[mime] ?? 'bin';
  const d = new Date();
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `ws/${workspaceId}/${ym}/${scope}/${randomUUID()}.${ext}`;
}

/**
 * Télécharge une URL de fournisseur et la stocke chez nous.
 * Les garde-fous (taille, type) évitent qu'une réponse inattendue remplisse
 * le disque ou injecte un type de fichier arbitraire.
 */
export async function ingest(
  url: string, workspaceId: string, scope: string,
): Promise<Stored> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`téléchargement impossible (${res.status})`);

  const mime = (res.headers.get('content-type') ?? 'application/octet-stream')
    .split(';')[0].trim();
  if (!/^(image|video|audio)\//.test(mime)) {
    throw new Error(`type de fichier inattendu : ${mime}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const maxBytes = 200 * 1024 * 1024;
  if (buf.length > maxBytes) throw new Error('fichier trop volumineux');

  return storage.put(keyFor(workspaceId, scope, mime), buf, mime);
}

export function verifyFileToken(token: string, key: string): boolean {
  try {
    const p = jwt.verify(token, config.JWT_SECRET) as { k: string };
    return p.k === key;
  } catch { return false; }
}
