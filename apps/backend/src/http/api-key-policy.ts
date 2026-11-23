import type { ApiKeyScope, Role } from '@idcp/shared';
import { roleAtLeast } from '@idcp/shared';
import { roleForScopes, type ApiKeyPrincipal } from '../services/api-key-service';

// Explicit route templates, not raw URLs or prefix matches. An unlisted method/route is unavailable
// to machine credentials, including an admin key. Additions need a security and product review.
export const API_KEY_ROUTES: Readonly<Record<string, ApiKeyScope>> = Object.freeze({
  'GET /api/v1/documents': 'documents:read',
  'GET /api/v1/documents/:id': 'documents:read',
  'GET /api/v1/documents/:id/file': 'documents:read',
  'GET /api/v1/documents/:id/result': 'documents:read',
  'POST /api/v1/documents': 'documents:write',
  'POST /api/v1/documents/:id/reprocess': 'documents:write',
  'DELETE /api/v1/documents/:id': 'documents:write',
  'GET /api/v1/batches': 'documents:read',
  'GET /api/v1/batches/:id': 'documents:read',
  'GET /api/v1/batches/:id/items': 'documents:read',
  'GET /api/v1/batches/:id/results.csv': 'documents:read',
  'POST /api/v1/batches': 'documents:write',
  'GET /api/v1/review/queue': 'review:write',
  'POST /api/v1/documents/:id/review': 'review:write',
  'PATCH /api/v1/review/:id/fields': 'review:write',
  'POST /api/v1/review/:id/approve': 'review:write',
  'POST /api/v1/review/:id/reject': 'review:write',
  'POST /api/v1/review/bulk-approve': 'review:write',
  'GET /api/v1/exports': 'exports:read',
  'GET /api/v1/exports/:id': 'exports:read',
  'GET /api/v1/exports/:id/download': 'exports:read',
  'GET /api/v1/connectors/types': 'connectors:write',
  'GET /api/v1/connectors': 'connectors:write',
  'POST /api/v1/connectors': 'connectors:write',
  'PATCH /api/v1/connectors/:id': 'connectors:write',
  'DELETE /api/v1/connectors/:id': 'connectors:write',
  'POST /api/v1/connectors/:id/test': 'connectors:write',
  'GET /api/v1/connectors/:id/schema': 'connectors:write',
  'GET /api/v1/connectors/:id/runs': 'connectors:write',
  'GET /api/v1/mapping-profiles': 'connectors:write',
  'POST /api/v1/mapping-profiles': 'connectors:write',
  'GET /api/v1/documents/:id/duplicates': 'connectors:write',
  'POST /api/v1/documents/:id/send': 'connectors:write',
  'GET /api/v1/workflows': 'admin',
  'POST /api/v1/workflows': 'admin',
  'PATCH /api/v1/workflows/:id': 'admin',
  'DELETE /api/v1/workflows/:id': 'admin',
  'GET /api/v1/workflows/runs': 'admin',
  'GET /api/v1/workflows/runs/:id': 'admin',
  'POST /api/v1/workflows/evaluate': 'admin',
  'POST /api/v1/workflows/runs/:id/approve': 'admin',
});

/** Returns the route-specific role, or null when a machine credential cannot use the route. */
export function apiKeyRoleForRoute(
  principal: ApiKeyPrincipal,
  method: string,
  route: string | undefined,
): Role | null {
  if (!route) return null;
  const key = `${method === 'HEAD' ? 'GET' : method} ${route}`;
  if (!Object.hasOwn(API_KEY_ROUTES, key)) return null;
  const required = API_KEY_ROUTES[key]!;
  const allowedScopes = principal.scopes.filter((scope) => scope === required || scope === 'admin');
  const scopeRole = roleForScopes(allowedScopes);
  if (!scopeRole) return null;
  // A different scope cannot raise the role on this route; the creator's live membership remains a cap.
  return roleAtLeast(principal.role, scopeRole) ? scopeRole : principal.role;
}
