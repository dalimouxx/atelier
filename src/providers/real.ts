/**
 * Adaptateurs des fournisseurs réels.
 *
 * Aucun module métier n'importe un SDK de fournisseur : changer BytePlus
 * pour fal doit rester un changement de configuration, pas une refonte.
 *
 * Les formats de réponse sont ceux documentés par chaque fournisseur ;
 * ils demanderont un calage au premier appel réel. Les parseurs sont donc
 * défensifs : une forme inattendue produit une erreur explicite plutôt
 * qu'un plantage.
 */
import { config } from '../config';
import { Provider, GenerateRequest, GenerateResult, Modality } from './types';

const TIMEOUT_IMAGE = 150_000;
const TIMEOUT_SUBMIT = 30_000;

function fail(code: string, message?: string): GenerateResult {
  return { status: 'failed', errorCode: code, errorMessage: message?.slice(0, 500) };
}

// ---------------------------------------------------------------------------
// BytePlus ModelArk — Seedream (image), Seedance (vidéo)
// ---------------------------------------------------------------------------
export class BytePlusProvider implements Provider {
  readonly name = 'byteplus';

  supports(m: Modality) { return m === 'image' || m === 'video'; }

  async submit(req: GenerateRequest): Promise<GenerateResult> {
    const isVideo = req.modality === 'video';
    const url = `${config.BYTEPLUS_BASE_URL}${
      isVideo ? '/contents/generations/tasks' : '/images/generations'}`;

    const body = isVideo
      ? {
          model: req.model,
          content: [
            { type: 'text', text: req.prompt },
            ...(req.images ?? []).map((u) => ({
              type: 'image_url', image_url: { url: u },
            })),
          ],
          ...req.params,
        }
      : {
          model: req.model,
          prompt: req.prompt,
          ...(req.images?.length ? { image: req.images } : {}),
          response_format: 'url',
          ...req.params,
        };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.BYTEPLUS_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': req.jobId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(isVideo ? TIMEOUT_SUBMIT : TIMEOUT_IMAGE),
      });
    } catch (e: any) {
      return fail('network', e.message);
    }

    if (!res.ok) return fail(`http_${res.status}`, await res.text());

    const d: any = await res.json().catch(() => null);
    if (!d) return fail('bad_response', 'réponse illisible');

    if (isVideo) {
      const id = d.id ?? d.task_id;
      if (!id) return fail('bad_response', "identifiant de tâche absent");
      return { status: 'running', providerJobId: id };
    }

    const items: any[] = d.data ?? [];
    if (!items.length) return fail('empty_output', 'aucune image rendue');

    return {
      status: 'succeeded',
      providerJobId: d.id,
      outputs: items
        .filter((i) => i.url)
        .map((i) => ({ url: i.url, kind: 'image' as const, mime: 'image/png' })),
      usage: { unit: 'image', quantity: items.length },
    };
  }

  async poll(providerJobId: string): Promise<GenerateResult> {
    let res: Response;
    try {
      res = await fetch(
        `${config.BYTEPLUS_BASE_URL}/contents/generations/tasks/${providerJobId}`,
        { headers: { Authorization: `Bearer ${config.BYTEPLUS_API_KEY}` },
          signal: AbortSignal.timeout(20_000) },
      );
    } catch (e: any) {
      return { status: 'running', providerJobId }; // réseau instable : on retente
    }
    if (!res.ok) return fail(`http_${res.status}`);

    const d: any = await res.json().catch(() => null);
    if (!d) return fail('bad_response');

    const status = String(d.status ?? '').toLowerCase();

    if (status === 'succeeded' || status === 'success') {
      const videoUrl = d.content?.video_url ?? d.video_url;
      if (!videoUrl) return fail('empty_output', 'aucune vidéo rendue');
      const seconds = Number(d.content?.duration ?? d.duration ?? 5);
      return {
        status: 'succeeded',
        providerJobId,
        outputs: [{
          url: videoUrl, kind: 'video', mime: 'video/mp4',
          durationMs: seconds * 1000,
        }],
        usage: { unit: 'second', quantity: seconds },
      };
    }
    if (status === 'failed' || status === 'cancelled') {
      return fail(d.error?.code ?? 'provider_failed', d.error?.message);
    }
    return { status: 'running', providerJobId };
  }
}

// ---------------------------------------------------------------------------
// Anthropic — agents texte
// ---------------------------------------------------------------------------
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';

  supports(m: Modality) { return m === 'text'; }

  async submit(req: GenerateRequest): Promise<GenerateResult> {
    const content: any = req.images?.length
      ? [
          ...req.images.map((u) => ({
            type: 'image', source: { type: 'url', url: u },
          })),
          { type: 'text', text: req.prompt },
        ]
      : req.prompt;

    let res: Response;
    try {
      res = await fetch(`${config.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': config.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: (req.params?.max_tokens as number) ?? 2048,
          ...(req.params?.system ? { system: req.params.system } : {}),
          messages: [{ role: 'user', content }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e: any) {
      return fail('network', e.message);
    }

    if (!res.ok) return fail(`http_${res.status}`, await res.text());

    const d: any = await res.json().catch(() => null);
    if (!d?.content) return fail('bad_response');

    const text = d.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');

    const tokens = (d.usage?.input_tokens ?? 0) + (d.usage?.output_tokens ?? 0);
    return {
      status: 'succeeded',
      providerJobId: d.id,
      text,
      usage: { unit: '1k_tokens', quantity: tokens / 1000 },
    };
  }
}

// ---------------------------------------------------------------------------
// fal.ai — second fournisseur image/vidéo, évite la dépendance unique
// ---------------------------------------------------------------------------
export class FalProvider implements Provider {
  readonly name = 'fal';

  supports(m: Modality) { return m === 'image' || m === 'video'; }

  async submit(req: GenerateRequest): Promise<GenerateResult> {
    let res: Response;
    try {
      res = await fetch(`https://queue.fal.run/${req.model}`, {
        method: 'POST',
        headers: {
          Authorization: `Key ${config.FAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: req.prompt,
          ...(req.images?.length ? { image_url: req.images[0] } : {}),
          ...req.params,
        }),
        signal: AbortSignal.timeout(TIMEOUT_SUBMIT),
      });
    } catch (e: any) {
      return fail('network', e.message);
    }
    if (!res.ok) return fail(`http_${res.status}`, await res.text());

    const d: any = await res.json().catch(() => null);
    if (!d?.request_id) return fail('bad_response');
    return { status: 'running', providerJobId: d.request_id };
  }

  async poll(providerJobId: string): Promise<GenerateResult> {
    let res: Response;
    try {
      res = await fetch(`https://queue.fal.run/requests/${providerJobId}`, {
        headers: { Authorization: `Key ${config.FAL_API_KEY}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { status: 'running', providerJobId };
    }
    if (!res.ok) return fail(`http_${res.status}`);

    const d: any = await res.json().catch(() => null);
    if (!d) return fail('bad_response');

    const status = String(d.status ?? '').toUpperCase();
    if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
      return { status: 'running', providerJobId };
    }
    if (status && status !== 'COMPLETED' && !d.images && !d.video) {
      return fail('provider_failed', d.error ?? status);
    }

    // Les sorties arrivent soit comme liste d'images, soit comme objet vidéo.
    const raw: any[] = d.video ? [d.video] : (d.images ?? []);
    if (!raw.length) return fail('empty_output');

    const outputs = raw.map((o: any) => {
      const mime = o.content_type ?? 'image/png';
      return {
        url: o.url,
        kind: (mime.startsWith('video') ? 'video' : 'image') as Modality,
        mime,
      };
    });

    return {
      status: 'succeeded',
      providerJobId,
      outputs,
      usage: outputs[0].kind === 'video'
        ? { unit: 'second', quantity: 5 }
        : { unit: 'image', quantity: outputs.length },
    };
  }
}
