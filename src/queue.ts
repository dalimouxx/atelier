/**
 * File de travaux.
 *
 * BullMQ quand Redis est configuré. Sinon, une file en mémoire prend le
 * relais : la plateforme reste complètement fonctionnelle sur une
 * installation minimale, ce qui compte pour une première mise en ligne
 * ou une démonstration. L'interface est la même des deux côtés.
 *
 * Limite assumée du mode mémoire : les travaux en attente sont perdus au
 * redémarrage. Les gels de crédits correspondants expirent tout seuls et
 * sont rendus au client, donc personne n'est débité à tort.
 */
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config, enabled } from './config';

export interface JobPayload { jobId: string }
type Handler = (jobId: string) => Promise<void>;

export interface QueueAdapter {
  add(jobId: string, delayMs?: number): Promise<void>;
  process(handler: Handler): void;
  close(): Promise<void>;
  readonly kind: 'redis' | 'memory';
  stats(): Promise<{ waiting: number; active: number }>;
}

const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
class RedisQueue implements QueueAdapter {
  readonly kind = 'redis' as const;
  private connection: IORedis;
  private queue: Queue<JobPayload>;
  private worker?: Worker<JobPayload>;
  private onExhausted?: (jobId: string, code: string, msg: string) => Promise<void>;

  constructor() {
    this.connection = new IORedis(config.REDIS_URL!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.queue = new Queue<JobPayload>('generation', { connection: this.connection });
  }

  async add(jobId: string, delayMs = 0) {
    await this.queue.add('generate', { jobId }, {
      jobId,                         // idempotence : un seul travail par identifiant
      delay: delayMs,
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 4000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  process(handler: Handler) {
    this.worker = new Worker<JobPayload>(
      'generation',
      async (job: Job<JobPayload>) => handler(job.data.jobId),
      { connection: this.connection, concurrency: config.WORKER_CONCURRENCY },
    );

    this.worker.on('failed', async (job, err) => {
      if (!job) return;
      const attempts = job.opts.attempts ?? MAX_ATTEMPTS;
      if (job.attemptsMade < attempts) return; // il reste des tentatives
      await this.onExhausted?.(job.data.jobId, (err as any).code ?? 'worker_failed', err.message);
    });
  }

  onAttemptsExhausted(fn: (jobId: string, code: string, msg: string) => Promise<void>) {
    this.onExhausted = fn;
  }

  async stats() {
    const [waiting, active] = await Promise.all([
      this.queue.getWaitingCount(), this.queue.getActiveCount(),
    ]);
    return { waiting, active };
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
    this.connection.disconnect();
  }
}

// ---------------------------------------------------------------------------
class MemoryQueue implements QueueAdapter {
  readonly kind = 'memory' as const;
  private pending: { jobId: string; at: number; attempt: number }[] = [];
  private running = new Set<string>();
  private handler?: Handler;
  private timer?: NodeJS.Timeout;
  private onExhausted?: (jobId: string, code: string, msg: string) => Promise<void>;

  async add(jobId: string, delayMs = 0) {
    if (this.pending.some((p) => p.jobId === jobId) || this.running.has(jobId)) return;
    this.pending.push({ jobId, at: Date.now() + delayMs, attempt: 0 });
  }

  process(handler: Handler) {
    this.handler = handler;
    this.timer = setInterval(() => this.tick(), 400);
    this.timer.unref?.();
  }

  onAttemptsExhausted(fn: (jobId: string, code: string, msg: string) => Promise<void>) {
    this.onExhausted = fn;
  }

  private tick() {
    if (!this.handler) return;
    while (this.running.size < config.WORKER_CONCURRENCY) {
      const i = this.pending.findIndex((p) => p.at <= Date.now());
      if (i === -1) break;
      const item = this.pending.splice(i, 1)[0];
      this.running.add(item.jobId);

      this.handler(item.jobId)
        .catch(async (err) => {
          const next = item.attempt + 1;
          if (next < MAX_ATTEMPTS) {
            this.pending.push({
              jobId: item.jobId,
              at: Date.now() + 4000 * 2 ** item.attempt,
              attempt: next,
            });
          } else {
            await this.onExhausted?.(item.jobId, err?.code ?? 'worker_failed',
              err?.message ?? 'échec');
          }
        })
        .finally(() => this.running.delete(item.jobId));
    }
  }

  async stats() {
    return { waiting: this.pending.length, active: this.running.size };
  }

  async close() { if (this.timer) clearInterval(this.timer); }
}

export const queue: QueueAdapter & {
  onAttemptsExhausted?: (fn: (jobId: string, code: string, msg: string) => Promise<void>) => void;
} = enabled.redis ? new RedisQueue() : new MemoryQueue();

export const queueKind = queue.kind;
