import {
  ConnectorRegistry,
  type ConnectorContext,
  type ConnectorReadQuery,
  type ConnectorRecord,
} from '@idcp/connectors';
import type {
  ConnectorOperations,
  ConnectorOperationsRegistry,
} from '../services/connector-registry';
import { ConnectorProcess } from './connector-process';

/** First-party connector invocation through one-shot subprocesses; not a security sandbox. */
export class ProcessConnectorRegistry implements ConnectorOperationsRegistry {
  constructor(
    private readonly descriptors: ConnectorRegistry,
    private readonly process: ConnectorProcess,
  ) {}

  list(): ReturnType<ConnectorRegistry['list']> {
    return this.descriptors.list();
  }

  get(type: string): ConnectorOperations {
    // Descriptors are first-party registry objects. Their implementation methods are never invoked here.
    const descriptor = this.descriptors.get(type);
    const invoke = (
      operation: string,
      config: Record<string, unknown>,
      organisationId: string,
      extra: object = {},
    ) => this.process.invoke({ type, operation, organisationId, config, ...extra });
    const connector: ConnectorOperations = {
      type: descriptor.type,
      label: descriptor.label,
      capabilities: descriptor.capabilities,
      validateConfig: async (config, organisationId) => {
        await invoke('validateConfig', config, organisationId);
      },
      healthCheck: async (config, context) =>
        (await invoke('healthCheck', config, context.organisationId)) as Awaited<
          ReturnType<ConnectorOperations['healthCheck']>
        >,
      describeSchema: async (config, context) =>
        (await invoke('describeSchema', config, context.organisationId)) as Awaited<
          ReturnType<ConnectorOperations['describeSchema']>
        >,
      create: async (records, config, context) =>
        (await invoke('create', config, context.organisationId, { records })) as Awaited<
          ReturnType<ConnectorOperations['create']>
        >,
    };
    if (descriptor.read) {
      connector.read = async (
        query: ConnectorReadQuery,
        config: Record<string, unknown>,
        context: ConnectorContext,
      ) => (await invoke('read', config, context.organisationId, { query })) as ConnectorRecord[];
    }
    if (descriptor.search) {
      connector.search = async (
        query: ConnectorReadQuery,
        config: Record<string, unknown>,
        context: ConnectorContext,
      ) => (await invoke('search', config, context.organisationId, { query })) as ConnectorRecord[];
    }
    if (descriptor.update) {
      connector.update = async (records, keys, config, context) =>
        (await invoke('update', config, context.organisationId, { records, keys })) as Awaited<
          ReturnType<NonNullable<ConnectorOperations['update']>>
        >;
    }
    return connector;
  }
}
