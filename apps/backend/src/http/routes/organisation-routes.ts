import type { FastifyInstance } from 'fastify';
import {
  InviteUserRequestSchema,
  UpdateOrganisationRequestSchema,
  UpdateRoleRequestSchema,
  badRequest,
} from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

export function registerOrganisationRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  app.get('/organisation', async (request) => {
    const actor = await guards.authenticate(request);
    return services.organisation.get(actor);
  });

  app.patch('/organisation', async (request) => {
    const actor = await guards.authenticate(request);
    const parsed = UpdateOrganisationRequestSchema.safeParse(request.body);
    if (!parsed.success)
      throw badRequest('Those organisation settings are not valid.', parsed.error.issues);
    return services.organisation.update(actor, parsed.data);
  });

  app.get('/users', async (request) => {
    const actor = await guards.authenticate(request);
    return { items: await services.organisation.listUsers(actor) };
  });

  app.post('/users/invite', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    const parsed = InviteUserRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter a valid email address and role.');
    const invitation = await services.auth.invite({
      email: parsed.data.email,
      role: parsed.data.role,
      invitedBy: actor.userId,
      organisationId: actor.organisationId,
    });
    // Delivery is out of scope, so the caller receives the link once; only its hash is stored.
    return reply.code(202).send({ status: 'invited', invitation });
  });

  app.get('/invitations', async (request) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request);
    return { items: await services.auth.listInvitations(actor.organisationId) };
  });

  app.delete('/invitations/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request);
    await services.auth.revokeInvitation(actor.organisationId, guards.uuidParam(request, 'id'));
    return reply.code(204).send();
  });

  app.patch('/users/:id/role', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    const parsed = UpdateRoleRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Choose a valid role.');
    return services.organisation.changeRole(actor, guards.uuidParam(request), parsed.data.role);
  });

  app.delete('/users/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    await services.organisation.removeUser(actor, guards.uuidParam(request));
    return reply.code(204).send();
  });

  app.get('/audit-logs', async (request) => {
    const actor = await guards.authenticate(request);
    const query = request.query as Record<string, string | undefined>;
    return {
      items: await services.organisation.auditLogs(actor, {
        action: query.action,
        actorId: query.actorId,
        from: query.from,
        to: query.to,
      }),
    };
  });

  app.get('/stats', async (request) => {
    const actor = await guards.authenticate(request);
    return services.organisation.stats(actor);
  });

  app.post('/retention/purge', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const result = await services.organisation.enqueueRetentionPurge(actor);
    return reply.code(202).send(result);
  });
}
