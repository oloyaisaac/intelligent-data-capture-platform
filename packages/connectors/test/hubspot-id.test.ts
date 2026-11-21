import { HubSpotConnector } from '../src/crm/hubspot-connector';
import type { ConnectorContext } from '../src/contract';

it('uses the top-level HubSpot record ID rather than an identically named property', async () => {
  const context: ConnectorContext = {
    organisationId: 'synthetic',
    logger: {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          results: [{ id: 'real-id', properties: { id: 'other-id', name: 'Example' } }],
        }),
        { status: 200 },
      ),
  };
  const records = await new HubSpotConnector().read({}, { token: 'synthetic' }, context);
  expect(records).toEqual([{ values: { id: 'real-id', name: 'Example' } }]);
});
