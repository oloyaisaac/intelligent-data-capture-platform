// Application-owned replacements for historical connector errors. Arbitrary adapter text is never
// considered safe merely because it appears in a persisted row.
export const CONNECTOR_HEALTH_FAILURE =
  'Connection check failed. Review the destination and connection settings.';
export const CONNECTOR_RUN_FAILURE =
  'Connector request failed. Check the destination for changes and review connection settings before retrying.';
