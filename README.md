# Atelier

Plateforme de création visuelle vendue au crédit, destinée aux vendeurs
e-commerce et aux agences du marché tunisien. Image, vidéo et agents texte,
derrière un portefeuille de crédits payable par carte bancaire.

---

## Ce qui tourne aujourd'hui

| Partie | État |
|---|---|
| Schéma et migrations | Vérifié sur Postgres 16 |
| Grand livre de crédits | 15 tests, concurrence comprise |
| Authentification, rôles, sessions | Opérationnel |
| Catalogue (8 applications) | Opérationnel |
| Génération image / vidéo / texte | Opérationnel |
| Cache de déduplication | Opérationnel |
| Production en lot (CSV + export ZIP) | Opérationnel |
| Bibliothèque, identité de marque | Opérationnel |
| Paiement par carte (Konnect) | Codé, non testé contre l'API réelle |
| Interface complète | Opérationnelle |
| Tableau des marges | Opérationnel |
| Déploiement Render | `render.yaml` prêt |

**40 tests automatisés passent contre le build de production.**

---

## Démarrage en cinq minutes

```bash
npm install
cp .env.example .env          # renseigner DATABASE_URL et JWT_SECRET
npm run seed                  # schéma + catalogue
npm run dev
```

Ouvrir `http://localhost:3000`, créer un compte, produire un visuel.
**Aucune clé API n'est nécessaire** : le fournisseur de démonstration rend de
vraies images et toute la chaîne est exercée.

---

## Déploiement sur Render

1. Pousser ce dépôt sur GitHub.
2. Render → **New** → **Blueprint** → sélectionner le dépôt.
   Le service web, la base Postgres et Redis sont créés automatiquement.
3. Après le premier déploiement, renseigner `PUBLIC_BASE_URL` avec l'URL
   réelle du service (ex. `https://atelier.onrender.com`), puis redéployer.
4. Ouvrir l'URL : la plateforme fonctionne en mode démonstration.

### Pour passer en production réelle

**Le stockage d'abord.** Le disque de Render est éphémère : sans stockage
objet, tous les fichiers produits disparaissent à chaque redéploiement.
Créer un bucket Cloudflare R2 (gratuit jusqu'à 10 Go) et renseigner
`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.

**Puis les fournisseurs.** `BYTEPLUS_API_KEY` pour l'image et la vidéo,
`ANTHROPIC_API_KEY` pour les agents texte. Chaque clé ajoutée fait
automatiquement reculer le mode démonstration.

**Puis le paiement.** `KONNECT_API_KEY` et `KONNECT_WALLET_ID`. Sans eux, le
bouton de paiement reste désactivé et la plateforme le signale clairement.

**Enfin, le compte administrateur** — pour accéder au tableau des marges :

```sql
UPDATE users SET is_platform_admin = true WHERE email = 'vous@domaine.tn';
```

---

## Architecture

```
Navigateur ─── Express ─┬─ API REST        ─── Postgres (grand livre, catalogue)
                        ├─ Fichiers signés ─── R2 / S3
                        └─ Worker          ─── Redis (file)
                                                 │
                                   ┌─────────────┴──────────────┐
                              BytePlus      Anthropic       fal / démo
```

Un seul processus Node sert l'API, l'interface et le worker. Quand le volume
l'exigera, `RUN_WORKER_IN_PROCESS=false` et un service séparé suffisent —
rien d'autre ne change.

### La règle qui porte tout le reste

Les crédits circulent **uniquement** par `LedgerService` :

```
reserve()  →  le montant est gelé, le solde ne bouge pas
commit()   →  le gel devient débit, une écriture est inscrite
release()  →  le gel est annulé, rien n'a bougé, rien n'est facturé
```

Le client n'est **jamais** débité d'un rendu qu'il n'a pas reçu.

La table `credit_entries` porte des déclencheurs qui interdisent `UPDATE` et
`DELETE` au niveau de la base. Une correction ajoute une ligne ; elle n'en
efface aucune. Une tâche horaire compare le solde stocké à la somme des
écritures et alerte au moindre écart.

### Les applications sont des données

Chaque application du catalogue est une ligne de `ai_apps` : invite, schéma
d'entrée, fournisseurs par ordre de préférence, coût en crédits. En ajouter
une, c'est un `INSERT` — pas un déploiement.

### Bascule entre fournisseurs

Si BytePlus répond en erreur trois fois, un disjoncteur l'écarte une minute
et la route suivante prend le relais. Le client ne voit rien. C'est la
protection contre le risque le plus sérieux du métier : dépendre d'un seul
fournisseur qui peut augmenter ses prix ou couper le service.

---

## Économie du modèle

Chaque travail enregistre son coût réel en micro-dollars. L'écran **Marges**
compare, par application, ce qui a été encaissé en crédits et ce qui a été
payé en devise.

Repère : **un crédit vendu doit rapporter environ trois fois son coût
fournisseur.** Au pack Boutique (1 100 crédits pour 60 TND), un crédit vaut
environ 0,0175 $.

| Application | Crédits | Revenu | Coût fournisseur | Multiple |
|---|---:|---:|---:|---:|
| Fiche produit rédigée | 2 | 0,035 $ | ~0,008 $ | 4,4 × |
| Produit sur fond blanc | 4 | 0,070 $ | 0,030 $ | 2,3 × |
| Mise en situation | 5 | 0,088 $ | 0,030 $ | 2,9 × |
| Essayage virtuel | 6 | 0,105 $ | 0,030 $ | 3,5 × |
| Clip produit (5 s) | 55 | 0,963 $ | 0,500 $ | 1,9 × |

La vidéo reste la plus mince. Elle a été portée de 40 à 55 crédits ; en
dessous, elle travaillait à 1,4 × quand la moyenne du catalogue est à 2,6 ×.

**Le cache de déduplication est le seul levier qui améliore la marge et la
vitesse en même temps.** Une demande identique déjà produite est resservie
sans appel fournisseur et sans débit. Sur des catalogues où les vendeurs
relancent sans cesse la même référence, c'est considérable.

---

## Sécurité

- Mots de passe hachés avec bcrypt, coût 11.
- Session dans un cookie `httpOnly` — inaccessible au JavaScript.
- Appartenance à l'espace de travail relue à chaque requête : un membre
  retiré perd l'accès immédiatement, sans attendre l'expiration du jeton.
- Limitation de débit **persistée en base**, pas en mémoire : elle survit aux
  redéploiements et fonctionne même avec plusieurs instances.
- Connexion : même message et même temps de réponse que le compte existe ou
  non, pour ne pas révéler quelles adresses sont inscrites.
- Les fichiers d'entrée sont vérifiés comme appartenant à l'espace de travail
  qui les désigne.
- Le webhook de paiement n'est jamais cru sur parole : chaque notification
  déclenche une relecture de l'état chez Konnect.
- Le montant facturé vient toujours de la base, jamais du client.
- Modération avant toute dépense — un compte fournisseur résilié mettrait fin
  à l'activité.

---

## Commandes

```bash
npm run dev          # développement, rechargement à chaud
npm run build        # compilation TypeScript
npm start            # production
npm run migrate      # schéma seul
npm run seed         # schéma + catalogue
npm test             # tests du grand livre
npm run test:api     # tests de contrat (serveur démarré requis)
npm run typecheck    # vérification des types
```

---

## Ce qui reste à faire

**Avant la vente réelle**

- Brancher Konnect et faire un premier paiement de bout en bout. Les
  adaptateurs sont écrits d'après la documentation mais n'ont jamais parlé à
  l'API réelle — compter une demi-journée de calage.
- Même chose pour BytePlus : les formats de réponse sont raisonnés, pas
  vérifiés.
- Envoi d'e-mails : la réinitialisation de mot de passe produit un jeton mais
  aucun message n'est envoyé.
- CGU, politique de confidentialité, statut fiscal et facturation.

**Ensuite**

- Interface en arabe (le RTL touche chaque écran : c'est une deuxième mise en
  page, pas une traduction).
- Invitation de membres par e-mail.
- Espace revendeur, si la vente par cartes à gratter est reprise — le schéma
  et la logique de hachage sont prêts à être réactivés.
- Parrainage en crédits, qui coûte le prix fournisseur et non le prix de vente.

---

## Conformité

Envelopper des modèles dans ses propres applications est conforme aux
conditions des fournisseurs. **La revente d'un accès brut à une API ne l'est
pas**, chez Anthropic comme chez la plupart des autres. Le produit doit rester
une application : il ne doit jamais exister de ligne « acheter des crédits
Claude ».
