/**
 * Validation des entrées utilisateur contre le `input_schema` déclaré par
 * chaque application. On n'utilise pas un validateur JSON Schema complet :
 * le sous-ensemble employé par le catalogue est volontairement étroit, et
 * une implémentation explicite produit des messages en français lisibles.
 */
import { Err } from './errors';

export interface FieldSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  format?: string;
  enum?: string[];
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  items?: { type: string };
}

export interface InputSchema {
  type: 'object';
  required?: string[];
  properties: Record<string, FieldSchema>;
}

export function validateInputs(
  schema: InputSchema, raw: unknown,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw Err.badInput('Les entrées doivent être un objet');
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [key, field] of Object.entries(schema.properties)) {
    const label = field.title ?? key;
    let value = input[key];

    if (value === undefined || value === null || value === '') {
      if (field.default !== undefined) { out[key] = field.default; continue; }
      if (schema.required?.includes(key)) problems.push(`« ${label} » est obligatoire`);
      continue;
    }

    switch (field.type) {
      case 'string': {
        if (typeof value !== 'string') { problems.push(`« ${label} » doit être du texte`); break; }
        const s = value.trim();
        if (field.minLength && s.length < field.minLength) {
          problems.push(`« ${label} » doit faire au moins ${field.minLength} caractères`); break;
        }
        if (field.maxLength && s.length > field.maxLength) {
          problems.push(`« ${label} » dépasse ${field.maxLength} caractères`); break;
        }
        if (field.enum && !field.enum.includes(s)) {
          problems.push(`« ${label} » doit être parmi : ${field.enum.join(', ')}`); break;
        }
        out[key] = s;
        break;
      }
      case 'number':
      case 'integer': {
        const n = Number(value);
        if (!Number.isFinite(n)) { problems.push(`« ${label} » doit être un nombre`); break; }
        if (field.type === 'integer' && !Number.isInteger(n)) {
          problems.push(`« ${label} » doit être un entier`); break;
        }
        if (field.minimum !== undefined && n < field.minimum) {
          problems.push(`« ${label} » doit être au moins ${field.minimum}`); break;
        }
        if (field.maximum !== undefined && n > field.maximum) {
          problems.push(`« ${label} » doit être au plus ${field.maximum}`); break;
        }
        out[key] = n;
        break;
      }
      case 'boolean':
        out[key] = value === true || value === 'true';
        break;
      case 'array': {
        if (typeof value === 'string') value = [value];
        if (!Array.isArray(value)) { problems.push(`« ${label} » doit être une liste`); break; }
        if (field.minItems && value.length < field.minItems) {
          problems.push(`« ${label} » demande au moins ${field.minItems} élément(s)`); break;
        }
        if (field.maxItems && value.length > field.maxItems) {
          problems.push(`« ${label} » accepte au plus ${field.maxItems} élément(s)`); break;
        }
        out[key] = value.map(String);
        break;
      }
    }
  }

  if (problems.length) {
    throw Err.badInput(problems.join('. '), { problems });
  }
  return out;
}

/** Les identifiants de fichiers envoyés par le client doivent être des UUID. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function requireUuid(s: unknown, label = 'identifiant'): string {
  if (!isUuid(s)) throw Err.badInput(`${label} invalide`);
  return s;
}
