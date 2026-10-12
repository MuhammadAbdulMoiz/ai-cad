import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* .env optional */ }
const env = (k: string, d: string) => process.env[k] || d;

export const config = {
  root,
  runsDir: path.join(root, 'runs'),
  profileDir: path.join(root, '.profile'),
  webDir: path.join(root, 'web'),
  playbookDir: path.join(root, 'server', 'playbook'),
  frontendUrl: env('FRONTEND_URL', 'https://localhost:8080'),
  inspectorUrl: env('INSPECTOR_URL', 'http://127.0.0.1:8083/mcp'),
  port: Number(env('HARNESS_PORT', '4377')),
  cdpPort: Number(env('CDP_PORT', '9222')),
  model: env('HARNESS_MODEL', 'claude-sonnet-5-5'),
  maxTurnsPerFeature: Number(env('MAX_TURNS_PER_FEATURE', '25')),
  maxRecoveries: 2,
};
