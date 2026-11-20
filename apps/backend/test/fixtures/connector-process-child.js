// Test-only child used to exercise failure modes of the subprocess transport.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (request.operation === 'validateConfig') {
    process.stdout.write(JSON.stringify({ ok: true, value: null }));
    return;
  }
  if (request.operation === 'healthCheck') process.exit(73);
  switch (request.action) {
    case 'exit':
      process.exit(73);
      break;
    case 'hang':
      setInterval(() => {}, 1000);
      break;
    case 'flood':
      process.stdout.write('x'.repeat(100_000));
      break;
    case 'invalid':
      process.stdout.write('{not-json');
      break;
    case 'secret':
      process.stdout.write(
        JSON.stringify({ ok: true, value: process.env.IDCP_TEST_INHERITED_SECRET ?? null }),
      );
      break;
    case 'error':
      process.stdout.write(JSON.stringify({ ok: false, error: request.secret }));
      break;
    default:
      process.stdout.write(JSON.stringify({ ok: true, value: request.value }));
  }
});
