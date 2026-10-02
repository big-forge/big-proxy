// Development: core with hot reload + Vite dev server. Open http://localhost:5173
import { spawn } from 'node:child_process';

const procs = [
  ['core', 'npx', ['tsx', 'watch', '--clear-screen=false', 'src/cli.ts', '--dev']],
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
  // SIGINT lets the core restore the system proxy before exiting.
  for (const p of procs) p.kill('SIGINT');
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
