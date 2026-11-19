import type { Connector, ConnectorRegistry } from '@idcp/connectors';

/** Service-facing registry; validation may require an isolated asynchronous invocation. */
export type ConnectorOperations = Omit<Connector, 'validateConfig'> & {
  validateConfig(config: Record<string, unknown>, organisationId: string): void | Promise<void>;
};

export interface ConnectorOperationsRegistry {
  get(type: string): ConnectorOperations;
  list(): ReturnType<ConnectorRegistry['list']>;
}
