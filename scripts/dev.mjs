// Development: the Go engine (API only) + the Vite dev server with hot reload. Open http://localhost:5173
import { spawn } from 'node:child_process';

const procs = [
  ['engine', 'go', ['run', './cmd/proxyapp', '--dev']],
  ['ui', 'npx', ['vite']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join('\n') + '\n';
  p.stdout.on('data', (c) => process.stdout.write(prefix(c)));
  p.stderr.on('data', (c) => process.stderr.write(prefix(c)));
  return p;
});

const stop = () => {
  // SIGINT lets the engine put the system proxy settings back before it exits.
  for (const p of procs) p.kill('SIGINT');
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
