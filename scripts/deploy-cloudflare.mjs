#!/usr/bin/env node
// Copies only the static dashboard files into .cf-pages/ and deploys with Wrangler.
// Usage: npm run deploy:cf
// Requires: npx wrangler login (once)

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.cf-pages');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'data'), { recursive: true });
cpSync(join(root, 'index.html'), join(out, 'index.html'));
cpSync(join(root, 'data', 'latest.json'), join(out, 'data', 'latest.json'));
writeFileSync(
  join(out, '_headers'),
  `/*
  Cache-Control: public, max-age=60
/data/*
  Cache-Control: public, max-age=60, must-revalidate
`
);

console.log('Staging static files in .cf-pages/ …');
const result = spawnSync(
  'npx',
  [
    '--yes',
    'wrangler',
    'pages',
    'deploy',
    out,
    '--project-name=rytsensetech-growth-board',
    '--commit-dirty=true',
  ],
  { stdio: 'inherit', shell: true, cwd: root }
);
process.exit(result.status ?? 1);
