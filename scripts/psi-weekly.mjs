#!/usr/bin/env node
// Monday weekly Page Speed run: scan top pages, store scores, create Dev tasks.
// Usage: npm run psi:weekly   (does not need the API server)
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { runPSISync } from '../server/src/jobs/sync-psi.js';
import { createPSITasks } from '../server/src/jobs/create-psi-tasks.js';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const sync = await runPSISync(db);
const tasks = await createPSITasks(db);
console.log(JSON.stringify({ ok: true, sync, tasks }, null, 2));
