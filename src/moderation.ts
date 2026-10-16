/**
 * Modération.
 *
 * Deux niveaux : un filtre lexical local, toujours actif et gratuit, puis
 * un contrôle par modèle quand une clé Anthropic est configurée.
 *
 * Pourquoi c'est vital : les applications d'essayage et de portrait
 * attirent les usages interdits. Un compte fournisseur résilié met fin à
 * l'activité du jour au lendemain — la modération protège l'entreprise
 * avant de protéger l'utilisateur.
 */
import { config, enabled } from './config';

export interface Verdict {
  allowed: boolean;
  reason?: string;
  category?: string;
}

/**
 * Termes bloquants. La liste reste volontairement courte et porte sur les
 * catégories qui font résilier un compte fournisseur : contenu sexuel,
 * mineurs, violence réelle, usurpation de personnalité.
 */
const BLOCKED: { re: RegExp; category: string }[] = [
  { re: /\b(nude?|naked|nsfw|porn|erotic|lingerie\s+model|undress)\b/i, category: 'sexuel' },
  { re: /\b(nu+e?|dénudée?|déshabill|pornograph)\w*/i, category: 'sexuel' },
  { re: /\b(child|kid|minor|teen|underage|enfant|mineur|adolescent)\w*\s+(nude|naked|bikini|lingerie|nu|sexy)/i, category: 'mineur' },
  { re: /\b(gore|beheading|mutilat|torture|corpse|cadavre|décapit)\w*/i, category: 'violence' },
  { re: /\b(deepfake|face\s*swap\s+of|usurp)\w*/i, category: 'usurpation' },
];

/** Personnalités publiques : générer leur image expose à un litige. */
const REAL_PERSON = /\b(president|président|minister|ministre|celebrity|célébrité)\b/i;

function lexical(text: string): Verdict {
  for (const rule of BLOCKED) {
    if (rule.re.test(text)) {
      return {
        allowed: false,
        category: rule.category,
        reason: 'La demande contient un élément que nous ne pouvons pas traiter.',
      };
    }
  }
  if (REAL_PERSON.test(text)) {
    return {
      allowed: false,
      category: 'personne réelle',
      reason: "Nous ne générons pas d'images de personnalités publiques.",
    };
  }
  return { allowed: true };
}

/**
 * Second niveau : on demande à un modèle de classer la demande. Appelé
 * seulement si le filtre lexical a laissé passer, pour limiter le coût.
 * En cas de panne du service, on laisse passer : couper toute la
 * production parce que le classifieur est indisponible serait pire.
 */
async function modelCheck(text: string): Promise<Verdict> {
  if (!enabled.anthropic) return { allowed: true };

  try {
    const res = await fetch(`${config.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': config.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 12,
        system:
          "Tu classes des demandes de génération d'images pour une plateforme " +
          'e-commerce. Réponds uniquement par AUTORISE ou REFUSE. ' +
          'REFUSE si la demande vise du contenu sexuel, un mineur dans un ' +
          'contexte inapproprié, de la violence réelle, ou l\'image d\'une ' +
          'personne réelle identifiable. Tout le reste est AUTORISE.',
        messages: [{ role: 'user', content: text.slice(0, 2000) }],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return { allowed: true };
    const d: any = await res.json();
    const verdict = (d.content?.[0]?.text ?? '').trim().toUpperCase();

    if (verdict.startsWith('REFUSE')) {
      return {
        allowed: false,
        category: 'classifieur',
        reason: 'La demande ne respecte pas nos conditions d\'utilisation.',
      };
    }
    return { allowed: true };
  } catch {
    return { allowed: true }; // panne du classifieur : on ne bloque pas la production
  }
}

export const moderation = {
  async checkPrompt(text: string): Promise<Verdict> {
    const lex = lexical(text);
    if (!lex.allowed) return lex;
    return modelCheck(text);
  },

  /**
   * Contrôle d'une image envoyée par l'utilisateur. Non branché sur un
   * service de vision pour l'instant : on vérifie le type et la taille,
   * ce qui bloque déjà les fichiers piégés.
   */
  async checkUpload(mime: string, bytes: number): Promise<Verdict> {
    if (!/^image\/(png|jpeg|webp)$/.test(mime)) {
      return { allowed: false, reason: 'Formats acceptés : PNG, JPEG, WebP.' };
    }
    if (bytes > config.MAX_UPLOAD_MB * 1024 * 1024) {
      return { allowed: false, reason: `Fichier trop lourd (max ${config.MAX_UPLOAD_MB} Mo).` };
    }
    return { allowed: true };
  },
};
