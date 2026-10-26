/**
 * @idcp/connectors — connector SDK and first-party connectors (CON-001).
 * Core code only talks to the `Connector` interface; adding a destination means adding an
 * implementation and registering it here.
 */
export * from './contract';
export * from './csv-connector';
export * from './sqlite-connector';
export * from './postgres-connector';
export * from './mysql-connector';
export * from './google-sheets-connector';
export * from './crm/http';
export * from './crm/hubspot-connector';
export * from './crm/odoo-connector';
export * from './crm/quickbooks-connector';
export * from './registry';
