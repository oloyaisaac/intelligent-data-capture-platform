// Synthetic runtime check against the disposable Compose stack in CI.
const base = 'http://127.0.0.1:4000/api/v1';
async function request(path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Unexpected ${response.status} from ${path}`);
  return value;
}
const account = await request('/auth/register', {
  email: 'connector-smoke@example.com',
  password: 'synthetic password for compose testing only',
  displayName: 'Compose test',
  organisationName: 'Compose test',
  acceptTerms: true,
});
const connector = await request(
  '/connectors',
  {
    type: 'csv',
    name: 'Compose CSV',
    config: {
      directory: process.argv[2] ?? '/data/documents/connector-smoke',
      filename: 'out.csv',
    },
  },
  account.accessToken,
);
const health = await request(`/connectors/${connector.id}/test`, {}, account.accessToken);
if (health.ok !== true) throw new Error('Packaged connector health check failed');
console.log('Packaged connector validation and health check passed.');
