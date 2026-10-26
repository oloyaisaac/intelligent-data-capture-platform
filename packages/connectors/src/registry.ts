import type { Connector } from './contract';
import { CsvFileConnector } from './csv-connector';
import { GoogleSheetsConnector } from './google-sheets-connector';
import { PostgresConnector } from './postgres-connector';
import { MysqlConnector } from './mysql-connector';
import { SqliteConnector } from './sqlite-connector';

/**
 * Connector registry (CON-001).
 *
 * Connectors are looked up by type; unknown types produce an actionable error that names what is
 * supported rather than a stack trace.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  constructor(connectors: Connector[] = defaultConnectors()) {
    for (const connector of connectors) {
      this.connectors.set(connector.type, connector);
    }
  }

  get(type: string): Connector {
    const connector = this.connectors.get(type);
    if (!connector) {
      throw new Error(
        `Unsupported connector type "${type}". Available: ${this.types().join(', ')}.`,
      );
    }
    return connector;
  }

  has(type: string): boolean {
    return this.connectors.has(type);
  }

  types(): string[] {
    return [...this.connectors.keys()].sort();
  }

  list(): Array<{ type: string; label: string; capabilities: readonly string[] }> {
    return [...this.connectors.values()].map((connector) => ({
      type: connector.type,
      label: connector.label,
      capabilities: connector.capabilities,
    }));
  }
}

export function defaultConnectors(): Connector[] {
  return [
    new CsvFileConnector(),
    new SqliteConnector(),
    new PostgresConnector(),
    new MysqlConnector(),
    new GoogleSheetsConnector(),
  ];
}
