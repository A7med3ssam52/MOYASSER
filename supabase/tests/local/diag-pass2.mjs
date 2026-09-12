/* diag-pass2.mjs — TEMP diagnostic (delete after use).
 * Boots embedded PG on 54331, applies shim + full schema (pass 1),
 * then re-applies the full schema STATEMENT BY STATEMENT and reports
 * the first failing statement + its migration section. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(__dirname, '.diag-pass2');
const SHIM = path.join(__dirname, 'auth-shim.sql');
const FULL = path.join(ROOT, 'supabase-full-schema.sql');
const PORT = 54331;

// --- $$-aware splitter (copy of regen-schema.mjs logic) ---
function splitStatements(sql) {
  const chunks = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const rest = sql.slice(i);
    if (c === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? n : eol + 1;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i);
      const stop = end === -1 ? n : end + 2;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const dm = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (dm) {
      cur += dm[0];
      i += dm[0].length;
      const tag = dm[0];
      const end = sql.indexOf(tag, i);
      if (end === -1) {
        cur += sql.slice(i);
        i = n;
      } else {
        cur += sql.slice(i, end + tag.length);
        i = end + tag.length;
      }
      continue;
    }
    if (c === "'") {
      cur += c;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            cur += "''";
            i += 2;
            continue;
          }
          cur += "'";
          i++;
          break;
        }
        cur += sql[i];
        i++;
      }
      continue;
    }
    if (c === ';') {
      cur += ';';
      i++;
      let j = i;
      while (j < n && (sql[j] === ' ' || sql[j] === '\t' || sql[j] === '\n' || sql[j] === '\r')) j++;
      cur += sql.slice(i, j);
      i = j;
      chunks.push(cur);
      cur = '';
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

async function main() {
  const cjs = await import('embedded-postgres');
  const mod = cjs.default ?? cjs;
  const EP = mod.default ?? mod;
  const embedded = new EP({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: true,
  });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  await embedded.initialise();
  await embedded.start();
  console.log('[boot] up on ' + PORT);

  const { default: pg } = await import('pg');
  const client = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres' });
  await client.connect();

  await client.query(fs.readFileSync(SHIM, 'utf8'));
  console.log('[pass0] shim OK');
  await client.query(fs.readFileSync(FULL, 'utf8'));
  console.log('[pass1] full schema OK');

  const chunks = splitStatements(fs.readFileSync(FULL, 'utf8'));
  console.log('[info] total statements:', chunks.length);
  let section = '?';
  let applied = 0;
  for (const ch of chunks) {
    const m = ch.match(/>>> included from migrations\\(\S+)/);
    if (m) {
      section = m[1];
      continue;
    }
    if (!ch.trim().replace(/--[^\n]*\n/g, '').trim()) continue; // comment-only
    try {
      await client.query(ch);
      applied++;
    } catch (e) {
      console.log('=== FIRST PASS-2 FAILURE ===');
      console.log('section :', section);
      console.log('applied :', applied, 'statements before failure');
      console.log('error   :', String(e.message).split('\n')[0]);
      console.log('--- statement (first 1500 chars) ---');
      console.log(ch.slice(0, 1500));
      break;
    }
  }

  await client.end();
  await embedded.stop().catch(() => {});
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('[done]');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
