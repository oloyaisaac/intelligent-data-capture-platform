// Test-only demonstration: same-privilege subprocesses can still signal their API host.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (part) => (input += part));
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (request.operation === 'validateConfig') {
    process.stdout.write(JSON.stringify({ ok: true, value: null }));
    return;
  }
  if (request.operation === 'healthCheck') {
    process.kill(process.ppid, 'SIGTERM');
    process.exit(0);
  }
  process.exit(1);
});
