// Test-only connector: start one ordinary same-group descendant and hang.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { marker, pidFile } = JSON.parse(input);
  const descendant = spawn(
    process.execPath,
    [
      '-e',
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'ran'), 2500)",
      marker,
    ],
    { stdio: 'ignore' },
  );
  writeFileSync(pidFile, String(descendant.pid));
  setInterval(() => {}, 1000);
});
