import type { Command } from '../src/domain.ts';
import type { AppUser } from '../src/types.ts';
import { HttpError } from './errors.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Informe um e-mail válido.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  return email;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || !value.trim()) {
    throw new HttpError(400, 'A senha deve ter entre 12 e 128 caracteres.');
  }
  return value;
}

export function validateUser(value: unknown): AppUser {
  if (!record(value) || !keys(value, ['id', 'name', 'email', 'role', 'active'], ['driverId'])
    || !id(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 100
    || /[\u0000-\u001f\u007f]/.test(value.name) || !['admin', 'manager', 'driver'].includes(String(value.role))
    || typeof value.active !== 'boolean' || (value.driverId !== undefined && !id(value.driverId))) {
    throw new HttpError(400, 'Revise os dados do usuário.');
  }
  return { id: value.id, name: value.name.trim(), email: normalizeEmail(value.email), role: value.role as AppUser['role'], active: value.active,
    ...(value.driverId !== undefined ? { driverId: value.driverId as string } : {}) };
}

export function validateCommand(value: unknown): Command {
  let valid = false;
  if (record(value)) {
    switch (value.type) {
      case 'assign': valid = keys(value, ['type', 'deliveryId', 'driverId']) && id(value.deliveryId) && (value.driverId === null || id(value.driverId)); break;
      case 'start': valid = keys(value, ['type', 'deliveryId', 'driverId']) && id(value.deliveryId) && id(value.driverId); break;
      case 'advance': valid = keys(value, ['type', 'deliveryId']) && id(value.deliveryId); break;
      case 'complete': valid = keys(value, ['type', 'deliveryId', 'receivedBy']) && id(value.deliveryId) && typeof value.receivedBy === 'string' && !!value.receivedBy.trim() && value.receivedBy.trim().length <= 120 && !/[\u0000-\u001f\u007f]/.test(value.receivedBy); break;
      case 'availability': valid = keys(value, ['type', 'driverId', 'online']) && id(value.driverId) && typeof value.online === 'boolean'; break;
      case 'save-user':
        if (keys(value, ['type', 'user'])) { validateUser(value.user); valid = true; }
        break;
      case 'toggle-user': valid = keys(value, ['type', 'id']) && id(value.id); break;
      case 'reset': valid = keys(value, ['type']); break;
    }
  }
  if (!valid) throw new HttpError(400, 'Comando inválido.');
  return value as Command;
}

export function exactBody(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!record(value) || !keys(value, required, optional)) throw new HttpError(400, 'Conteúdo da solicitação inválido.');
  return value;
}
