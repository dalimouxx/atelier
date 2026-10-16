-- ============================================================================
-- Données de départ : tarifs fournisseurs, packs, catalogue d'applications
-- Idempotent — relançable sans dégât.
-- ============================================================================

INSERT INTO provider_costs (provider, model, unit, cost_usd_micros) VALUES
  ('byteplus','seedream-4-0','image',        30000),
  ('byteplus','seedance-1-0-pro','second',  100000),
  ('fal','fal-ai/flux/dev','image',          25000),
  ('anthropic','claude-sonnet-4-6','1k_tokens', 6000),
  ('demo','demo-image','image',                  0),
  ('demo','demo-video','second',                 0),
  ('demo','demo-text','1k_tokens',               0)
ON CONFLICT DO NOTHING;

INSERT INTO credit_packs (id, label, credits, bonus_credits, price_tnd_mils, sort_order) VALUES
  ('pack_trial',   'Découverte',   200,    0,   15000, 10),
  ('pack_starter', 'Boutique',    1000,  100,   60000, 20),
  ('pack_pro',     'Pro',         5000,  750,  270000, 30),
  ('pack_agency',  'Agence',     25000, 5000, 1200000, 40)
ON CONFLICT (id) DO UPDATE SET
  label=EXCLUDED.label, credits=EXCLUDED.credits,
  bonus_credits=EXCLUDED.bonus_credits, price_tnd_mils=EXCLUDED.price_tnd_mils;

-- ---------------------------------------------------------------------------
-- Catalogue. `routes` liste les fournisseurs par ordre de préférence :
-- `demo` en dernier sert de filet quand aucune clé n'est configurée.
-- ---------------------------------------------------------------------------
INSERT INTO ai_apps
  (id, title, description, category, modality, routes, input_schema,
   prompt_template, default_params, credit_cost, est_seconds, sort_order, status)
VALUES
(
 'product-on-white',
 '{"fr":"Produit sur fond blanc","ar":"منتج على خلفية بيضاء","en":"Product on white"}',
 '{"fr":"Une photo prise au téléphone devient un packshot conforme aux marketplaces."}',
 'ecommerce','image',
 '[{"provider":"byteplus","model":"seedream-4-0"},{"provider":"fal","model":"fal-ai/flux/dev"},{"provider":"demo","model":"demo-image"}]',
 '{"type":"object","required":["images","product_name"],"properties":{
    "images":{"type":"array","title":"Photo du produit","format":"assets","minItems":1,"maxItems":3,"items":{"type":"string"}},
    "product_name":{"type":"string","title":"Nom du produit","maxLength":120},
    "angle":{"type":"string","title":"Angle","enum":["de face","trois quarts","vue de dessus"],"default":"trois quarts"}}}',
 'Photo studio de {{product_name}}. Fond blanc uni sans raccord, éclairage studio doux et homogène, ombre de contact discrète, angle {{angle}}, sujet centré, net. Aucun accessoire, aucun texte. Photographie commerciale e-commerce.',
 '{"size":"1536x1536"}',
 4, 20, 10, 'live'
),
(
 'lifestyle-scene',
 '{"fr":"Mise en situation","ar":"المنتج في مشهد واقعي","en":"Lifestyle scene"}',
 '{"fr":"Place le produit dans une scène réelle qui correspond à votre marque."}',
 'ecommerce','image',
 '[{"provider":"byteplus","model":"seedream-4-0"},{"provider":"demo","model":"demo-image"}]',
 '{"type":"object","required":["images","scene"],"properties":{
    "images":{"type":"array","title":"Photo du produit","format":"assets","minItems":1,"maxItems":2,"items":{"type":"string"}},
    "scene":{"type":"string","title":"Décrivez la scène","format":"textarea","maxLength":400},
    "mood":{"type":"string","title":"Ambiance","enum":["chaleureuse","épurée","luxe","urbaine"],"default":"chaleureuse"}}}',
 'Intègre naturellement le produit fourni dans cette scène : {{scene}}. Ambiance {{mood}}.{{#brand.tone}} Ton de la marque : {{brand.tone}}.{{/brand.tone}} Conserve exactement la forme, les couleurs, le logo et les proportions du produit. Photoréaliste, lumière naturelle, faible profondeur de champ.',
 '{"size":"1536x1024"}',
 5, 25, 20, 'live'
),
(
 'model-try-on',
 '{"fr":"Essayage virtuel","ar":"تجربة افتراضية","en":"Virtual try-on"}',
 '{"fr":"Montre un vêtement porté par un mannequin, sans séance photo."}',
 'ecommerce','image',
 '[{"provider":"byteplus","model":"seedream-4-0"},{"provider":"demo","model":"demo-image"}]',
 '{"type":"object","required":["images"],"properties":{
    "images":{"type":"array","title":"Photo du vêtement","format":"assets","minItems":1,"maxItems":2,"items":{"type":"string"}},
    "model_type":{"type":"string","title":"Mannequin","enum":["femme","homme","neutre"],"default":"neutre"},
    "setting":{"type":"string","title":"Décor","default":"studio épuré"}}}',
 'Présente le vêtement fourni porté par un mannequin {{model_type}} dans un décor {{setting}}. Conserve à l''identique la matière, l''imprimé, la couleur et la coupe. Plan en pied, pose naturelle, photographie de lookbook professionnelle.',
 '{"size":"1024x1536"}',
 6, 30, 30, 'live'
),
(
 'ad-banner',
 '{"fr":"Bannière publicitaire","ar":"لافتة إعلانية","en":"Ad banner"}',
 '{"fr":"Un produit, tous les formats publicitaires, aux couleurs de la marque."}',
 'ecommerce','image',
 '[{"provider":"byteplus","model":"seedream-4-0"},{"provider":"demo","model":"demo-image"}]',
 '{"type":"object","required":["images","headline"],"properties":{
    "images":{"type":"array","title":"Photo du produit","format":"assets","minItems":1,"items":{"type":"string"}},
    "headline":{"type":"string","title":"Accroche","maxLength":60},
    "ratio":{"type":"string","title":"Format","enum":["1:1","4:5","9:16","16:9"],"default":"1:1"}}}',
 'Bannière publicitaire mettant en avant le produit fourni. Zone de texte réservée en haut pour l''accroche « {{headline}} ».{{#brand.palette}} Palette imposée : {{brand.palette}}.{{/brand.palette}} Composition commerciale nette, fort contraste, format {{ratio}}.',
 '{"size":"1024x1024"}',
 5, 25, 40, 'live'
),
(
 'product-video',
 '{"fr":"Clip produit animé","ar":"مقطع فيديو للمنتج","en":"Product motion clip"}',
 '{"fr":"Cinq secondes de mouvement caméra à partir d''une seule photo."}',
 'video','video',
 '[{"provider":"byteplus","model":"seedance-1-0-pro"},{"provider":"demo","model":"demo-video"}]',
 '{"type":"object","required":["images"],"properties":{
    "images":{"type":"array","title":"Photo du produit","format":"assets","minItems":1,"maxItems":1,"items":{"type":"string"}},
    "motion":{"type":"string","title":"Mouvement","enum":["orbite lente","travelling avant","révélation"],"default":"orbite lente"}}}',
 'Vidéo produit cinématographique. La caméra effectue un mouvement de {{motion}} autour du produit fourni. Éclairage studio, reflets doux, produit net et centré, aucun texte incrusté.',
 '{"duration":5,"ratio":"16:9"}',
 55, 90, 50, 'live'
),
(
 'ugc-clip',
 '{"fr":"Témoignage UGC","ar":"فيديو توصية","en":"UGC testimonial"}',
 '{"fr":"Clip vertical façon créateur, pour les publicités sur les réseaux."}',
 'video','video',
 '[{"provider":"byteplus","model":"seedance-1-0-pro"},{"provider":"demo","model":"demo-video"}]',
 '{"type":"object","required":["images","script"],"properties":{
    "images":{"type":"array","title":"Photo du produit","format":"assets","minItems":1,"items":{"type":"string"}},
    "script":{"type":"string","title":"Idée de la scène","format":"textarea","maxLength":300}}}',
 'Clip vertical de type contenu créateur. Une personne tient et présente le produit fourni face caméra, rendu téléphone à la main, lumière intérieure naturelle, expressif et enthousiaste. Déroulé de la scène : {{script}}',
 '{"duration":5,"ratio":"9:16"}',
 60, 100, 60, 'live'
),
(
 'product-copy',
 '{"fr":"Fiche produit rédigée","ar":"وصف المنتج","en":"Product listing writer"}',
 '{"fr":"Titre, arguments, description et mots-clés en français, arabe ou anglais."}',
 'agent','text',
 '[{"provider":"anthropic","model":"claude-sonnet-4-6"},{"provider":"demo","model":"demo-text"}]',
 '{"type":"object","required":["product_name","details"],"properties":{
    "product_name":{"type":"string","title":"Nom du produit"},
    "details":{"type":"string","title":"Caractéristiques","format":"textarea","maxLength":2000},
    "lang":{"type":"string","title":"Langue","enum":["fr","ar","en"],"default":"fr"},
    "marketplace":{"type":"string","title":"Plateforme","default":"boutique en ligne"}}}',
 'Rédige une fiche produit pour {{marketplace}}, en langue {{lang}}, pour « {{product_name}} ».\nCaractéristiques : {{details}}\n{{#brand.tone}}Voix de la marque : {{brand.tone}}\n{{/brand.tone}}Réponds uniquement en JSON strict, sans balises de code : {"title":"","bullets":["","","",""],"description":"","seo_tags":[""],"meta_description":""}',
 '{"max_tokens":2000,"system":"Tu es un rédacteur e-commerce. Tu ne produis que du JSON valide."}',
 2, 8, 70, 'live'
),
(
 'campaign-plan',
 '{"fr":"Plan de campagne","ar":"خطة حملة","en":"Campaign planner"}',
 '{"fr":"Calendrier de quatorze jours, chaque publication reliée à l''application qui la produit."}',
 'agent','text',
 '[{"provider":"anthropic","model":"claude-sonnet-4-6"},{"provider":"demo","model":"demo-text"}]',
 '{"type":"object","required":["objective"],"properties":{
    "objective":{"type":"string","title":"Objectif","format":"textarea","maxLength":500},
    "channels":{"type":"string","title":"Canaux","default":"Instagram, TikTok"},
    "lang":{"type":"string","title":"Langue","enum":["fr","ar","en"],"default":"fr"}}}',
 'Établis un plan de campagne sociale sur 14 jours, en langue {{lang}}. Objectif : {{objective}}. Canaux : {{channels}}.{{#brand.name}} Marque : {{brand.name}}.{{/brand.name}}\nPour chaque jour donne : canal, format, légende, et un "app_id" choisi parmi product-on-white, lifestyle-scene, model-try-on, ad-banner, product-video, ugc-clip, ainsi que les "inputs" exacts à transmettre.\nRéponds uniquement en JSON strict : {"days":[{"day":1,"channel":"","format":"","caption":"","app_id":"","inputs":{}}]}',
 '{"max_tokens":8000,"system":"Tu es un stratège en marketing de performance. Tu ne produis que du JSON valide."}',
 6, 20, 80, 'live'
)
ON CONFLICT (id) DO UPDATE SET
  title=EXCLUDED.title, description=EXCLUDED.description, routes=EXCLUDED.routes,
  input_schema=EXCLUDED.input_schema, prompt_template=EXCLUDED.prompt_template,
  default_params=EXCLUDED.default_params, credit_cost=EXCLUDED.credit_cost,
  est_seconds=EXCLUDED.est_seconds, sort_order=EXCLUDED.sort_order,
  status=EXCLUDED.status, updated_at=now();
