/**
 * Erreurs métier. Chacune porte un code stable que le frontend peut traiter
 * et un statut HTTP. Les messages sont en français, destinés à l'utilisateur.
 */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Err = {
  badInput: (msg = 'Données invalides', detail?: Record<string, unknown>) =>
    new AppError('bad_input', msg, 400, detail),

  unauthorized: (msg = 'Connexion requise') =>
    new AppError('unauthorized', msg, 401),

  forbidden: (msg = "Vous n'avez pas les droits nécessaires") =>
    new AppError('forbidden', msg, 403),

  notFound: (msg = 'Introuvable') =>
    new AppError('not_found', msg, 404),

  conflict: (msg = 'Conflit') =>
    new AppError('conflict', msg, 409),

  insufficientCredits: (required: number, available: number) =>
    new AppError(
      'insufficient_credits',
      `Crédits insuffisants : ${required} nécessaires, ${available} disponibles`,
      402,
      { required, available },
    ),

  blocked: (msg = 'Contenu refusé par la modération') =>
    new AppError('content_blocked', msg, 422),

  rateLimited: (retryAfter: number) =>
    new AppError(
      'rate_limited',
      'Trop de requêtes. Réessayez dans un instant.',
      429,
      { retryAfter },
    ),

  providerDown: (msg = 'Aucun fournisseur disponible pour cette application') =>
    new AppError('provider_unavailable', msg, 503),

  internal: (msg = 'Erreur interne') =>
    new AppError('internal', msg, 500),
};

/** Erreur à relancer : le travail sera retenté par la file. */
export class RetryableError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'RetryableError';
  }
}
