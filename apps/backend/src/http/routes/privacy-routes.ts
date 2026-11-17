import type { FastifyInstance } from 'fastify';
import { AppError, EraseAccountRequestSchema, badRequest } from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

/**
 * Data-subject rights (privacy policy §7).
 *
 * Both routes act on the signed-in person only — never on an organisation — and both are audited by
 * the service layer. They live under `/me` so there is no way to aim them at another account.
 */
export function registerPrivacyRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  app.get('/me/export', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const data = await services.privacy.exportData(actor);
    const stamp = data.generatedAt.slice(0, 10);
    return reply
      .header('content-disposition', `attachment; filename="idcp-my-data-${stamp}.json"`)
      .type('application/json; charset=utf-8')
      .send(data);
  });

  app.post('/me/erase', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = EraseAccountRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Confirm by typing DELETE and entering your password.', parsed.error.issues);
    }

    // Erasure is destructive and hard to undo: rate-limit the confirmation step so a stolen token
    // cannot be used to guess the password quickly.
    const key = `erase:${actor.userId}`;
    if (!services.authLimiter.hit(key)) {
      reply.header('Retry-After', String(services.authLimiter.retryAfterSeconds(key)));
      throw new AppError('RATE_LIMITED', 'Too many attempts. Wait a moment and try again.');
    }

    const result = await services.privacy.eraseAccount(actor, parsed.data);
    return reply.code(result.fileDeletionStatus === 'pending' ? 202 : 200).send(result);
  });
}
