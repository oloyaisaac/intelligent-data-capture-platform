import type { FastifyInstance } from 'fastify';
import type { Guards } from '../guards';
import type { Services } from '../../services/container';
import type { RealtimeEvent } from '../../realtime/hub';
import { AppError } from '@idcp/shared';
import type { AuthenticatedActor } from '../../services/auth-service';

async function actorFromQueryToken(services: Services, token: string): Promise<AuthenticatedActor> {
  const claims = services.tokens.verifyAccessToken(token);
  if (!claims) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  const membership = await services.auth.findActiveMembership(claims.sub, claims.org);
  if (!membership) throw new AppError('UNAUTHENTICATED', 'Account is no longer active.');
  return {
    userId: claims.sub,
    organisationId: membership.organisation_id,
    role: membership.role,
    actorType: 'user',
  };
}

/**
 * Server-sent events for the desktop dashboard (DESK-002, PAIR-003).
 *
 * SSE and the in-process hub are the current transport (DEC-016); no Socket.IO adapter is shipped.
 * Events reach subscribers in this process only. Only identifiers travel in the payload — never
 * document content (API.md §9).
 */
export function registerRealtimeRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  app.get('/events', async (request, reply) => {
    // `EventSource` cannot send headers, so this one route also accepts the access token as a
    // query parameter. It is only used to open a stream and never written to the audit log.
    const queryToken = (request.query as { access_token?: string }).access_token;
    const actor =
      typeof queryToken === 'string' && queryToken.length > 0 && !request.headers.authorization
        ? await actorFromQueryToken(services, queryToken)
        : await guards.authenticate(request);

    const hub = services.hub;
    // A hub without subscription support cannot back this SSE endpoint.
    if (typeof hub.subscribe !== 'function') {
      return reply.code(501).send({
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'This server does not expose an event stream. Use the realtime socket.',
          requestId: request.id,
        },
      });
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Defeat proxy buffering so events arrive immediately.
      'x-accel-buffering': 'no',
    });

    const send = (event: RealtimeEvent, payload: Record<string, unknown>) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    send('job:progress', { stage: 'connected' });

    const unsubscribe = hub.subscribe({ organisationId: actor.organisationId }, (event, payload) =>
      send(event, payload),
    );

    // Comment frames keep intermediaries from closing an idle stream.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    heartbeat.unref?.();

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    };
    request.raw.on('close', close);
    return reply;
  });
}
