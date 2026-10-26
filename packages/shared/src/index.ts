/**
 * @idcp/shared — single source of truth for types, validation and pure business rules.
 *
 * Safe to import from React Native: nothing here touches Node built-ins.
 * Node-only helpers (ids, token hashing, IP hashing) live in `@idcp/shared/ids` so that importing
 * the main entry never pulls `node:crypto` into a mobile bundle.
 */

export * from './constants';
export * from './errors';
export * from './udm/schema';
export * from './contracts';
export * from './money';
export * from './dates';
export * from './csv';
export * from './dedupe';
export * from './i18n';
export * from './review';
