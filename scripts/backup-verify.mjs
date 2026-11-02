// Verifies a restored backup: every table in the given schemas must exist in the
// restored database with EXACTLY the row count captured from the source at dump
// time. Exits non-zero on any mismatch.
//
//   node scripts/backup-verify.mjs --counts counts.json --restored postgres://...   (CI)
//   node scripts/backup-verify.mjs --capture postgres://... > counts.json           (capture)
import pg from "pg";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) =>
  (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const SCHEMAS = (args.schemas ?? "public").split(",");

async function counts(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows: tables } = await c.query(
      `SELECT table_schema s, table_name t FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' AND table_schema = ANY($1) ORDER BY 1, 2`, [SCHEMAS]);
    const out = {};
    for (const { s, t } of tables) {
      const { rows } = await c.query(`SELECT count(*)::bigint n FROM "${s}"."${t}"`);
      out[`${s}.${t}`] = Number(rows[0].n);
    }
    return out;
  } finally { await c.end(); }
}

if (args.capture) {
  process.stdout.write(JSON.stringify(await counts(args.capture), null, 2) + "\n");
} else {
  const { readFileSync } = await import("node:fs");
  const expected = JSON.parse(readFileSync(args.counts, "utf8"));
  const actual = await counts(args.restored);
  const problems = [];
  for (const [table, n] of Object.entries(expected)) {
    if (!(table in actual)) problems.push(`${table}: missing after restore (expected ${n} rows)`);
    else if (actual[table] !== n) problems.push(`${table}: ${actual[table]} rows restored, expected ${n}`);
  }
  const total = Object.values(expected).reduce((a, b) => a + b, 0);
  if (problems.length) {
    console.error(`RESTORE VERIFICATION FAILED (${problems.length} problem(s)):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`Restore verified: ${Object.keys(expected).length} tables, ${total} rows, all counts match.`);
}
