import { flow, runButton, wrongButton } from './flows.js';

const CAT = 'Security';

export const SECURITY_DEMOS = [
  {
    id: 'roles',
    category: CAT,
    title: 'Roles & privileges',
    tagline: 'GRANT, REVOKE, schema USAGE, column privileges, SET ROLE',
    description: [
      'In Postgres, users and groups are both roles. A role can log in (LOGIN), own objects, and be granted privileges: USAGE on a schema to enter it, SELECT/INSERT/UPDATE/DELETE on tables (or just some columns), EXECUTE on functions. Only the owner (or a superuser) can ALTER or DROP an object.',
      'The matrix shows a reader role and a writer role trying different statements, each run for real with SET ROLE. Note the two-step lesson in the first rows: without USAGE on the schema the table is invisible; with USAGE but no table grant, Postgres says permission denied. Column-level grants hide the salary amount from the reader.',
      'Apps should connect as a role that owns nothing and has only the grants it needs; migrations run as a separate owner role.',
    ],
    keyApis: ['CREATE ROLE … LOGIN', 'GRANT … ON TABLE … TO', 'GRANT USAGE ON SCHEMA', 'GRANT SELECT (col, …)', 'REVOKE', 'SET ROLE', 'ALTER DEFAULT PRIVILEGES', 'information_schema.role_table_grants'],
    useCases: ['Least-privilege app users', 'Read-only reporting users', 'Hiding sensitive columns', 'Separating migration and runtime roles'],
    snippet: {
      lang: 'sql', name: 'roles.sql', code: `CREATE ROLE app_reader NOLOGIN;
CREATE ROLE report_user LOGIN PASSWORD '…' IN ROLE app_reader;

GRANT USAGE ON SCHEMA hr TO app_reader;                  -- may enter the schema
GRANT SELECT (name, team) ON hr.salaries TO app_reader;  -- may read two columns

-- Future tables, too:
ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT SELECT ON TABLES TO app_reader;`,
    },
    flow: flow('/api/demos/roles',
      ['api', 'session', 'SET ROLE lab_reader'],
      ['session', 'planner', 'privilege check on schema, table, columns'],
      ['planner', 'session', 'allowed / permission denied'],
      ['session', 'api', 'privilege matrix'],
    ),
    actions: [runButton('/api/demos/roles', 'Try every privilege')],
    pitfalls: [
      {
        mistake: 'Granting on the table but forgetting the schema',
        symptom: 'ERROR:  permission denied for schema reporting\n(or, with an unqualified name: ERROR:  relation "salaries" does not exist)',
        why: 'A role needs USAGE on the schema before any table privilege matters. Schemas without USAGE are silently skipped in search_path, so the table looks missing.',
        fix: 'GRANT USAGE ON SCHEMA reporting TO the_role;',
        avoid: 'Grant schema USAGE and table privileges together, and ALTER DEFAULT PRIVILEGES for future tables.',
        reproduce: 'run',
      },
      {
        mistake: 'Creating tables in public on Postgres 15+',
        symptom: 'ERROR:  permission denied for schema public\nLINE 1: create table public.t_pub(i int);',
        why: 'Since Postgres 15, ordinary roles no longer have CREATE on the public schema (a security fix).',
        fix: 'Create a schema owned by the app owner role (CREATE SCHEMA app AUTHORIZATION app_owner;) or GRANT CREATE ON SCHEMA public TO app_owner;',
        avoid: 'Use dedicated schemas per application.',
      },
      {
        mistake: 'Connecting the application as a superuser or the table owner',
        symptom: 'One SQL injection can DROP everything; row-level security policies are silently ignored.',
        why: 'Superusers bypass every permission check; owners bypass RLS and can ALTER/DROP.',
        fix: 'Create a login role with only the needed grants and switch the app to it.',
        avoid: 'Separate roles for owning (migrations) and using (runtime).',
      },
    ],
    visual: 'roles',
  },
  {
    id: 'rls',
    category: CAT,
    title: 'Row-level security',
    tagline: 'Multi-tenant isolation enforced by the database',
    description: [
      'Row-level security (RLS) attaches policies to a table: USING decides which rows a role can see, update or delete; WITH CHECK decides which rows it may write. Once enabled, every query is filtered automatically, so a forgotten WHERE tenant_id = … in the app cannot leak another customer\'s data.',
      'Pick a tenant. The app role sets app.tenant_id (as a real app would at the start of each request) and runs SELECT * with no WHERE: only that tenant\'s invoices come back (the others fade out). An UPDATE without WHERE touches only its own rows, and inserting a row for another tenant is rejected.',
      'The table owner, superusers and BYPASSRLS roles skip policies. "Do it wrong" connects as the owner and sees everything, then FORCE ROW LEVEL SECURITY closes the gap.',
    ],
    keyApis: ['ALTER TABLE … ENABLE ROW LEVEL SECURITY', 'CREATE POLICY … USING … WITH CHECK', 'current_setting(\'app.tenant_id\')', 'set_config(…, is_local)', 'FORCE ROW LEVEL SECURITY', 'BYPASSRLS'],
    useCases: ['Multi-tenant SaaS', 'Per-user data', 'Regulated data access', 'Defense in depth'],
    snippet: {
      lang: 'sql', name: 'rls.sql', code: `ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
  USING      (tenant_id = current_setting('app.tenant_id')::int)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);

-- Per request, as the (non-owner) app role:
BEGIN;
SELECT set_config('app.tenant_id', '2', true);   -- true = only for this transaction
SELECT * FROM invoices;                          -- tenant 2's rows only
COMMIT;`,
    },
    inputs: [{ name: 'tenant', label: 'app.tenant_id', type: 'select', default: 1, options: [1, 2, 3] }],
    flow: flow('/api/demos/rls',
      ['api', 'session', "SET ROLE lab_app; set_config('app.tenant_id', …)"],
      ['session', 'planner', 'add policy: AND tenant_id = current_setting(…)'],
      ['planner', 'storage', 'scan invoices with the policy filter'],
      ['session', 'api', 'only this tenant\'s rows'],
    ),
    actions: [
      runButton('/api/demos/rls', 'Query as the tenant', (i) => ({ tenant: i.tenant })),
      wrongButton('/api/demos/rls', 'Connect as the table owner', (i) => ({ tenant: i.tenant })),
    ],
    pitfalls: [
      {
        mistake: 'The app connects as the table owner',
        symptom: 'RLS is enabled and the policy is correct, yet every tenant sees all rows.',
        why: 'Table owners, superusers and roles with BYPASSRLS are exempt from policies by default.',
        fix: 'ALTER TABLE invoices FORCE ROW LEVEL SECURITY; and/or connect as a separate non-owner role.',
        avoid: 'Test RLS as the exact role the application uses.',
        reproduce: 'mistake',
      },
      {
        mistake: 'Writing rows for another tenant',
        symptom: 'ERROR:  new row violates row-level security policy for table "invoices"',
        why: 'WITH CHECK (or USING, when WITH CHECK is absent) rejects rows outside the policy.',
        fix: 'Set the right tenant before writing; fix the app bug that mixed tenants.',
        avoid: 'Always give policies both USING and WITH CHECK.',
        reproduce: 'run',
      },
      {
        mistake: 'Tenant setting leaking between pooled requests',
        symptom: 'A request occasionally sees the previous request\'s tenant.',
        why: 'set_config(…, false) / SET lasts for the whole session, and pooled sessions are reused.',
        fix: "Use set_config('app.tenant_id', $1, true) inside a transaction (or SET LOCAL), so it ends at COMMIT.",
        avoid: 'Reset session state when returning connections to the pool (DISCARD ALL, as this lab does).',
      },
    ],
    visual: 'rls',
  },
  {
    id: 'sql-injection',
    category: CAT,
    title: 'SQL injection vs parameters',
    tagline: 'Why values must be bound parameters, and how to handle identifiers',
    description: [
      'SQL injection happens when user input is pasted into the SQL text: the input\'s quotes and keywords become part of the query. The fix is not escaping by hand: it is bound parameters. The driver sends the SQL with placeholders ($1) and the values separately, so a value can never change the query\'s structure.',
      'Pick a prepared payload. The red panel concatenates it into the SQL (you can see the final text Postgres received) and leaks rows; the green panel sends the same text as a parameter and correctly finds nothing. The lab only ever runs these fixed payloads.',
      'Table and column names cannot be parameters. Pick them from an allow-list, or quote them with psycopg.sql.Identifier (or format(\'%I\') in PL/pgSQL).',
    ],
    keyApis: ['$1 placeholders', "cursor.execute(sql, params)", 'psycopg.sql.Identifier', "format('%I', name)", 'quote_ident()', 'PREPARE / EXECUTE'],
    useCases: ['Every query with user input', 'Dynamic sorting / filtering', 'Search boxes', 'Admin tools'],
    snippet: {
      lang: 'python', name: 'safe.py', code: `# ✗ String building: the input becomes SQL
conn.execute("SELECT owner, body FROM notes WHERE owner = '" + name + "'")

# ✓ Bound parameter: psycopg sends the value separately ($1)
conn.execute("SELECT owner, body FROM notes WHERE owner = %s", [name])

# ✓ Identifiers: allow-list or sql.Identifier
from psycopg import sql
column = {"name": "name", "date": "created_at"}[sort_key]
conn.execute(sql.SQL("SELECT * FROM notes ORDER BY {}").format(sql.Identifier(column)))`,
    },
    inputs: [{
      name: 'payload', label: 'Payload (prepared)', type: 'select', default: "' OR '1'='1",
      options: ["' OR '1'='1", "x' UNION SELECT username, password_hash FROM users --", 'alice'],
    }],
    flow: flow('/api/demos/sql-injection',
      ['api', 'session', "UNSAFE: … WHERE owner = '' OR '1'='1'"],
      ['session', 'planner', 'parses the payload as SQL'],
      ['api', 'session', 'SAFE: … WHERE owner = $1  [payload]'],
      ['session', 'planner', 'payload is just a string value'],
      ['session', 'api', 'leaked rows vs none'],
    ),
    actions: [runButton('/api/demos/sql-injection', 'Send the payload both ways', (i) => ({ payload: i.payload }))],
    pitfalls: [
      {
        mistake: 'Building SQL with string concatenation or f-strings',
        symptom: "Login bypassed with ' OR '1'='1, or data from other tables appears via UNION SELECT.",
        why: 'The input changes the structure of the query.',
        fix: 'Rewrite every such query with placeholders; rotate any credentials that may have leaked.',
        avoid: 'Never put values into SQL text. Lint for f-strings/format() near execute().',
        lang: 'python', wrongCode: 'conn.execute(f"SELECT * FROM notes WHERE owner = \'{name}\'")', rightCode: 'conn.execute("SELECT * FROM notes WHERE owner = %s", [name])',
        reproduce: 'run',
      },
      {
        mistake: 'Trying to bind a table or column name',
        symptom: 'ERROR:  syntax error at or near "$1"\n(e.g. SELECT * FROM notes ORDER BY $1 sorts by a constant, or FROM $1 fails)',
        why: 'Parameters are values, not identifiers.',
        fix: 'Use an allow-list mapping, or psycopg.sql.Identifier / format(\'%I\').',
        avoid: 'Treat identifiers from users as untrusted, always.',
      },
      {
        mistake: 'Dynamic SQL inside PL/pgSQL with ||',
        symptom: "EXECUTE 'SELECT … WHERE name = ''' || p_name || '''' is just as injectable as app code.",
        why: 'Concatenation inside the database is still concatenation.',
        fix: "EXECUTE format('SELECT … FROM %I WHERE name = $1', tbl) USING p_name;",
        avoid: 'format() with %I for identifiers, %L for literals, USING for values.',
      },
    ],
    visual: 'injection',
  },
];
