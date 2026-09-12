// regen-schema.mjs — REBUILDS supabase-full-schema.sql from scratch as a
// single-file snapshot of supabase/migrations/*.sql (in filename order):
//   * header range is derived dynamically (0001..<last migration number>)
//   * every migration is included with its exact marker block, so stale
//     or missing sections are impossible (fix for review finding MED-4)
//   * legacy migrations 0001-0026 are filtered at STATEMENT level: any
//     statement whose text matches a banned subscription pattern is
//     dropped, EXCEPT when it mixes a banned reference with legit content
//     (e.g. trigger loops that also cover legit tables) — those are kept
//     verbatim and logged as notes. Migrations 0027+ are kept verbatim
//     (0028_units_purchase.sql intentionally DROPs the subscription
//     objects, so its removal statements must survive).
//   * byte-verifies the result (LF endings, no BOM, trailing single
//     newline, marker count == migration count)
/* global Buffer, console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // repo root
const SCHEMA = path.join(ROOT, 'supabase', 'supabase-full-schema.sql');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

// ---------------------------------------------------------------------------
// banned subscription patterns (post-0028 these only appear in 0028's own
// intentional removal statements)
// ---------------------------------------------------------------------------
// 'subscription' as a bare substring covers every legacy name variant
// (subscriptions, subscription_codes, redeem_subscription_code,
// create_manual_subscription, ...) without maintaining parallel lists
const FORBIDDEN_PAT =
  /subscription|pricing_plan|code_redemption|expiry_warning_days|v_active_subscriptions|v_dashboard_metrics|create_codes_for_staff|generate_codes_internal|get_dashboard_stats/i;

// legit public objects that must survive (final-schema surfaces)
const LEGIT_RE =
  /\b(profiles|grades|units|lessons|lesson_videos|lesson_pdfs|progress|notifications|audit_logs|app_settings|unit_pricing|unit_codes|unit_purchases|exams|exam_questions|exam_attempts|exam_answers|lesson_comments)\b/i;

// forbidden object names (their presence makes a statement suspicious)
const FORBIDDEN_OBJ_RE =
  /\b(pricing_plans|subscriptions|subscription_codes|code_redemptions|v_active_subscriptions|subscription_status|expire_subscriptions|redeem_subscription_code|get_my_subscriptions|get_my_current_subscription|create_manual_subscription|revoke_subscription_code|set_pricing_plan|delete_pricing_plan|create_codes_for_staff|generate_codes_internal)\b/i;

// statements whose primary subject is a legit public object even though the
// stripped text mentions a forbidden object
const MIXED_EXPLICIT_RE =
  /COMMENT ON TABLE public\.app_settings|notification_type|set_updated_at|audit_trigger|notify_new_content|can_access_lesson|get_dashboard_stats|v_dashboard_metrics|v_lesson_access|v_student_progress_summary|app_settings|is_teacher|create_grade/i;

// a mixed statement is only safe to keep when it self-guards every table
// access with to_regclass (survives DBs where the subscription subsystem
// was already removed); anything else would fail with 42P01 mid-file
const SELF_GUARDED_RE = /to_regclass\(format\(/i;

// benign mixed statements: forbidden words appear incidentally (legacy enum
// member names, settings-key cleanup) while the subject itself is legit and
// must survive on every deployment
const BENIGN_MIXED_RE =
  /CREATE TYPE public\.notification_type|INSERT INTO public\.app_settings|DELETE FROM public\.app_settings\s*\n?\s*WHERE key = 'expiry_warning_days'|CREATE OR REPLACE FUNCTION public\.(can_access_lesson|notify_new_content)\(/i;

// statement whose subject IS a forbidden object -> PURE (drop)
const SUBJECT_FORBIDDEN_RE =
  /^(CREATE OR REPLACE FUNCTION|CREATE TABLE|ALTER TABLE|COMMENT ON TABLE|COMMENT ON VIEW|CREATE VIEW|CREATE INDEX|DROP INDEX|GRANT|REVOKE|CREATE POLICY|DROP POLICY|ALTER FUNCTION|CREATE OR REPLACE VIEW|DROP VIEW|DROP TYPE|CREATE TYPE)[\s\S]{0,80}?\b(pricing_plans|subscriptions|subscription_codes|code_redemptions|v_active_subscriptions|v_dashboard_metrics|subscription_status|expire_subscriptions|redeem_subscription_code|get_my_subscriptions|get_my_current_subscription|create_manual_subscription|revoke_subscription_code|set_pricing_plan|delete_pricing_plan|create_codes_for_staff|generate_codes_internal)\b/i;

// ---------------------------------------------------------------------------
// Idempotency normalization (pass-2 safety). The full schema must apply
// cleanly TWICE (apply-full-twice.mjs proves it): once on a fresh project,
// once again on the same database (the live-remote shape). Older migrations
// predate the DROP+CREATE convention, so regen prepends the missing guards:
//   * bare CREATE POLICY  -> prepend DROP POLICY IF EXISTS (policies hold
//     no grants, so drop+recreate is semantically a no-op)
//   * bare CREATE TRIGGER -> prepend DROP TRIGGER IF EXISTS
//   * 0028's list_unit_pricing()/get_public_unit_prices(): later migrations
//     (0051/0053) changed their return types via DROP+CREATE with identical
//     grants, so the 0028 definitions get a DROP-prepend (final grants still
//     come from 0051/0053)
//   * 0029's get_exam_questions(uuid): its 8-column body went stale when
//     0045 added the image columns, so re-running it fails validation
//     ("too few columns"). The CREATE+COMMENT+REVOKE+GRANT quartet is
//     dropped from the 0029 section only — 0045 restores all four and 0061
//     finalizes the body. Proven safe: nothing references the function in
//     0030..0044 (no callers, no policies, no grants).
// ---------------------------------------------------------------------------
const POLICY_CREATE_RE = /^\s*CREATE\s+POLICY\s+("?[A-Za-z_][\w$]*"?)\s+ON\s+([A-Za-z_][\w$.]*)/i;
const POLICY_DROP_RE = /^\s*DROP\s+POLICY\s+IF\s+EXISTS\s+("?[A-Za-z_][\w$]*"?)\s+ON\s+([A-Za-z_][\w$.]*)/i;
const TRIGGER_CREATE_RE = /^\s*CREATE\s+TRIGGER\s+("?[A-Za-z_][\w$]*"?)\b/i;
const TRIGGER_ON_RE = /\sON\s+([A-Za-z_][\w$.]*)\s+FOR\s+EACH\s+ROW/i;
const TRIGGER_DROP_RE = /^\s*DROP\s+TRIGGER\s+IF\s+EXISTS\s+("?[A-Za-z_][\w$]*"?)\s+ON\s+([A-Za-z_][\w$.]*)/i;
const EARLY_FN_RE =
  /^\s*CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(list_unit_pricing|get_public_unit_prices)\s*\(/i;
const STALE_EXAM_FN_RE =
  /^\s*(CREATE\s+OR\s+REPLACE\s+FUNCTION|COMMENT\s+ON\s+FUNCTION|REVOKE\s+EXECUTE\s+ON\s+FUNCTION|GRANT\s+EXECUTE\s+ON\s+FUNCTION)\s+public\.get_exam_questions\s*\(\s*(?:[A-Za-z_][\w$]*\s+)?uuid\s*\)/i;

function normName(s) {
  return s.replace(/"/g, '').toLowerCase();
}

function idempotentize(content, file) {
  let guards = 0;
  let droppedFn = 0;
  let out = '';
  let prevCode = '';
  for (const chunk of splitStatements(content)) {
    const code = stripComments(chunk).trim();
    if (!code) {
      out += chunk;
      prevCode = '';
      continue;
    }
    // 0029-only: drop the superseded get_exam_questions quartet (see above)
    if (file === '0029_exams.sql' && STALE_EXAM_FN_RE.test(code)) {
      droppedFn++;
      console.log(`  drop(superseded-fn): ${file} | ${firstMeaningfulLine(chunk)}`);
      prevCode = '';
      continue;
    }
    // 0028-only: DROP-prepend before the two return-type-changed functions
    const earlyFn = file === '0028_units_purchase.sql' ? code.match(EARLY_FN_RE) : null;
    if (earlyFn) {
      out += `DROP FUNCTION IF EXISTS public.${normName(earlyFn[1])}();\n`;
      guards++;
      console.log(`  guard(fn-drop): ${file} | DROP FUNCTION IF EXISTS public.${normName(earlyFn[1])}()`);
    }
    // bare CREATE POLICY -> DROP-prepend unless already guarded
    const pol = code.match(POLICY_CREATE_RE);
    if (pol) {
      const want = `DROP POLICY IF EXISTS ${pol[1]} ON ${pol[2]}`;
      const prevDrop = prevCode.match(POLICY_DROP_RE);
      if (!(prevDrop && normName(prevDrop[1]) === normName(pol[1]) && normName(prevDrop[2]) === normName(pol[2]))) {
        out += `${want};\n`;
        guards++;
        console.log(`  guard(policy-drop): ${file} | ${want}`);
      }
      out += chunk;
      prevCode = code;
      continue;
    }
    // bare CREATE TRIGGER -> DROP-prepend unless already guarded
    const trg = code.match(TRIGGER_CREATE_RE);
    const trgOn = code.match(TRIGGER_ON_RE);
    if (trg && trgOn) {
      const want = `DROP TRIGGER IF EXISTS ${trg[1]} ON ${trgOn[1]}`;
      const prevDrop = prevCode.match(TRIGGER_DROP_RE);
      if (!(prevDrop && normName(prevDrop[1]) === normName(trg[1]) && normName(prevDrop[2]) === normName(trgOn[1]))) {
        out += `${want};\n`;
        guards++;
        console.log(`  guard(trigger-drop): ${file} | ${want}`);
      }
      out += chunk;
      prevCode = code;
      continue;
    }
    out += chunk;
    prevCode = code;
  }
  return { text: out, guards, droppedFn };
}

// ---------------------------------------------------------------------------
// $$-aware statement splitter. Each chunk keeps its trailing `;` plus any
// following blank lines, so dropping a chunk removes exactly that statement
// and re-joining the kept chunks reproduces the file byte-for-byte.
// Handles: line comments, block comments, single-quoted strings ('' escape),
// dollar-quoted strings ($$ or $tag$).
// ---------------------------------------------------------------------------
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

function stripComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? n : eol + 1;
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i);
      i = end === -1 ? n : end + 2;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

function firstMeaningfulLine(stmt) {
  for (const l of stmt.split('\n')) {
    const t = l.trim();
    if (t && !t.startsWith('--')) return t.slice(0, 90);
  }
  return '(comment-only)';
}

function isLegacy(file) {
  const num = parseInt(file.slice(0, 4), 10);
  return Number.isInteger(num) && num >= 1 && num <= 26;
}

function filterMigration(content, file) {
  if (!isLegacy(file)) return { text: content, dropped: 0, mixed: 0 };
  let out = '';
  let dropped = 0;
  let mixed = 0;
  for (const chunk of splitStatements(content)) {
    const code0 = stripComments(chunk);
    if (!FORBIDDEN_PAT.test(code0)) {
      out += chunk;
      continue;
    }
    const code = code0;
    const hasLegit = LEGIT_RE.test(code);
    const subjectForbidden = SUBJECT_FORBIDDEN_RE.test(code.trimStart());
    const isMixed = !subjectForbidden && (hasLegit || MIXED_EXPLICIT_RE.test(code));
    if (isMixed) {
      if (SELF_GUARDED_RE.test(code) || BENIGN_MIXED_RE.test(code.trim())) {
        out += chunk;
        mixed++;
        console.log(`  keep(guarded-mixed): ${file} | ${firstMeaningfulLine(chunk)}`);
      } else {
        dropped++;
        console.log(`  drop(mixed): ${file} | ${firstMeaningfulLine(chunk)}`);
      }
    } else {
      dropped++;
      console.log(`  drop: ${file} | ${firstMeaningfulLine(chunk)}`);
    }
  }
  return { text: out, dropped, mixed };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
const migrations = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const last = migrations[migrations.length - 1];
const lastNumber = last.match(/^(\d{4})_/)?.[1];
if (!lastNumber) throw new Error(`cannot derive migration number from ${last}`);

const header =
  '-- =====================================================================\n' +
  '-- supabase-full-schema.sql - consolidated Phase 1 schema\n' +
  '-- ---------------------------------------------------------------------\n' +
  `-- Single-file snapshot of supabase/migrations/0001..${lastNumber}, concatenated\n` +
  '-- in filename order. Apply ONCE to a fresh project; incremental changes\n' +
  '-- always go into new numbered migration files (never edit this file).\n' +
  '-- Statements from legacy migrations 0001-0026 that reference the removed\n' +
  '-- subscription subsystem are dropped at regen time; mixed statements are\n' +
  '-- dropped too unless they self-guard table access with to_regclass (the\n' +
  '-- guarded trigger loops). 0028_units_purchase.sql performs the actual\n' +
  '-- DROP of the subscription objects.\n' +
  '-- Idempotency guards are prepended at regen time so the file also\n' +
  '-- applies cleanly a SECOND time on the same database (DROP POLICY /\n' +
  '-- DROP TRIGGER IF EXISTS before bare CREATEs; DROP FUNCTION before the\n' +
  '-- two 0028 definitions whose return type changed in 0051/0053; the\n' +
  '-- superseded 0029 get_exam_questions definition is dropped because\n' +
  '-- 0045 restores it with the image columns and 0061 finalizes it).\n' +
  '-- Verified by the embedded-PostgreSQL harness (tests/local).\n' +
  '-- =====================================================================\n' +
  '\n';

let totalDropped = 0;
let totalMixed = 0;
let totalGuards = 0;
let totalFnDropped = 0;
const sections = migrations.map((file) => {
  const raw = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').replace(/\r\n/g, '\n');
  const filtered = filterMigration(raw, file);
  totalDropped += filtered.dropped;
  totalMixed += filtered.mixed;
  const idem = idempotentize(filtered.text, file);
  totalGuards += idem.guards;
  totalFnDropped += idem.droppedFn;
  const content = idem.text.replace(/\n+$/, '') + '\n';
  return (
    '-- =====================================================================\n' +
    `-- >>> included from migrations\\${file}\n` +
    '-- =====================================================================\n' +
    '\n' +
    content
  );
});

const expected = header + sections.join('\n');

// ---------------------------------------------------------------------------
// byte-verify: no BOM, LF only, trailing single newline, marker count
// ---------------------------------------------------------------------------
const buf = Buffer.from(expected, 'utf8');
if (buf.length !== Buffer.byteLength(expected, 'utf8')) throw new Error('length mismatch');
if ((expected.match(/\r\n/g) ?? []).length > 0) throw new Error('CRLF introduced');
if (expected.charCodeAt(0) === 0xfeff) throw new Error('BOM introduced');
if (!expected.endsWith('\n')) throw new Error('file must end with a single newline');
const markers = (expected.match(/-- >>> included from migrations\\/g) ?? []).length;
if (markers !== migrations.length)
  throw new Error(`expected ${migrations.length} markers, got ${markers}`);

fs.writeFileSync(SCHEMA, expected, 'utf8');
console.log(
  `regen OK: ${buf.length} bytes, ${markers} markers, LF-only, no BOM (range 0001..${lastNumber})`,
);
console.log(
  `schema-filter: dropped ${totalDropped} forbidden statement(s), kept ${totalMixed} mixed statement(s) with notes above`,
);
console.log(
  `idempotency: prepended ${totalGuards} guard(s), dropped ${totalFnDropped} superseded function statement(s)`,
);
