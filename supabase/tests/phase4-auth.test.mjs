// Phase 4 authorization, against real Postgres (PGlite) with the real migration
// files. Offline, no hosted project, no credentials.
//
// The shape of these tests follows docs/phase-4-auth-plan.md §6: catalog shape
// first (what the database IS), then behaviour per role (what each person can
// actually reach). Both halves matter — a catalog check can pass while the data
// is exposed, and a behavioural test can pass for the wrong reason.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  enrol,
  expectViolation,
  freshDb,
  insertTask,
  resetDb,
  signUpWithoutProfile,
  withAnon,
  withUser,
} from "./harness.mjs";

// docs/phase-4-auth-plan.md §3.3. Fifteen rows, and this list is the spec:
// a policy in the catalog but not here is an over-policy, one here but not in
// the catalog is a missing control.
const EXPECTED_POLICIES = [
  ["tasks", "tasks_fon_select", "SELECT"],
  ["tasks", "tasks_fon_insert", "INSERT"],
  ["tasks", "tasks_fon_update", "UPDATE"],
  ["tasks", "tasks_fon_delete", "DELETE"],
  ["tasks", "tasks_abigail_select", "SELECT"],
  ["tasks", "tasks_abigail_insert", "INSERT"],
  ["tasks", "tasks_abigail_update", "UPDATE"],
  ["area_notes", "area_notes_fon_select", "SELECT"],
  ["area_notes", "area_notes_fon_insert", "INSERT"],
  ["area_notes", "area_notes_fon_update", "UPDATE"],
  ["area_notes", "area_notes_abigail_select", "SELECT"],
  ["area_notes", "area_notes_abigail_insert", "INSERT"],
  ["area_notes", "area_notes_abigail_update", "UPDATE"],
  ["area_notes", "area_notes_accountability_select", "SELECT"],
  ["profiles", "profiles_select_own", "SELECT"],
];

// docs/phase-4-auth-plan.md §3.2.
const EXPECTED_GRANTS = [
  ["tasks", "SELECT"], ["tasks", "INSERT"], ["tasks", "UPDATE"], ["tasks", "DELETE"],
  ["area_notes", "SELECT"], ["area_notes", "INSERT"], ["area_notes", "UPDATE"],
  ["profiles", "SELECT"],
  ["school_summary", "SELECT"],
];

// Reachable by nobody through the API in Phase 4. audit_log is deferred to
// Phase 5, when there is an audit surface to consume it.
const SERVER_ONLY_TABLES = ["audit_log", "idempotency_keys", "import_batches"];

const SHARED_HOME = "22222222-2222-4222-8222-222222222222";
const PRIVATE_HOME = "33333333-3333-4333-8333-333333333333";
const SCHOOL = "11111111-1111-4111-8111-111111111111";
const WORK = "44444444-4444-4444-8444-444444444444";

let db;
let fon;
let abigail;
let accountability;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("reset role");
  await resetDb(db);
  fon = await enrol(db, "fon");
  abigail = await enrol(db, "abigail");
  accountability = await enrol(db, "accountability");
});

/** Seeds one task per interesting shape, as the owner (which bypasses RLS). */
async function seedBoard() {
  await insertTask(db, { id: SCHOOL, title: "UMPI 311 paper", area: "school", notes: "outline first" });
  await insertTask(db, { id: SHARED_HOME, title: "Groceries", area: "home", visibility: "shared" });
  await insertTask(db, { id: PRIVATE_HOME, title: "Anniversary gift", area: "home", visibility: "private" });
  await insertTask(db, { id: WORK, title: "Client AB intake", area: "work", notes: "ref 2291" });
  await db.query(`
    insert into public.area_notes (area, note) values
      ('school', 'Midterms in three weeks'),
      ('home', 'Bins out Tuesday'),
      ('work', 'Confidential')
  `);
}

const titles = (rows) => rows.map((r) => r.title).sort();

// ─── CATALOG SHAPE ────────────────────────────────────────────────────────────

describe("the role function is hardened (§3.1)", () => {
  it("is owned by postgres, definer, stable, with an empty search_path", async () => {
    const { rows } = await db.query(`
      select pg_get_userbyid(p.proowner) as owner,
             p.prosecdef,
             p.provolatile,
             coalesce(array_to_string(p.proconfig, ','), '') as config
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'current_app_role'
    `);
    expect(rows).toHaveLength(1);
    // A definer function runs as its owner. Owned by something lesser it could
    // not read profiles; owned by supabase_admin it would carry more authority
    // than intended.
    expect(rows[0].owner).toBe("postgres");
    expect(rows[0].prosecdef).toBe(true);
    // Stable, so Postgres evaluates it once per statement rather than per row.
    expect(rows[0].provolatile).toBe("s");
    // The classic definer-function attack is search-path hijacking.
    expect(rows[0].config).toMatch(/search_path=/);
  });

  it("returns null for a user with no profile, so every policy fails closed", async () => {
    const stray = await signUpWithoutProfile(db);
    await withUser(db, stray, async () => {
      const { rows } = await db.query("select app.current_app_role() as role");
      expect(rows[0].role).toBeNull();
    });
  });

  it("returns only the caller's own role — it cannot enumerate anyone else's", async () => {
    await withUser(db, abigail, async () => {
      const { rows } = await db.query("select app.current_app_role() as role");
      expect(rows[0].role).toBe("abigail");
    });
  });

  it("is not referenced by any policy on profiles — that would be circular", async () => {
    const { rows } = await db.query(`
      select policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
        from pg_policies where schemaname = 'public' and tablename = 'profiles'
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.expr, `${r.policyname} reads profiles to decide access to profiles`)
        .not.toMatch(/current_app_role/);
    }
  });
});

describe("the policy set matches the plan exactly (§3.3)", () => {
  it("has exactly the fifteen expected policies, all PERMISSIVE to authenticated", async () => {
    const { rows } = await db.query(`
      select tablename, policyname, cmd, roles::text as roles, permissive
        from pg_policies where schemaname = 'public'
       order by tablename, policyname
    `);

    const actual = rows.map((r) => [r.tablename, r.policyname, r.cmd]);
    expect(actual.sort()).toEqual([...EXPECTED_POLICIES].sort());

    for (const r of rows) {
      expect(r.roles, `${r.policyname} roles`).toBe("{authenticated}");
      // A policy switched to RESTRICTIVE keeps its key but inverts its meaning.
      expect(r.permissive, `${r.policyname} permissive`).toBe("PERMISSIVE");
    }
  });

  it("gives tasks seven policies — no DELETE for abigail, nothing for accountability", async () => {
    const { rows } = await db.query(
      "select policyname, cmd from pg_policies where schemaname='public' and tablename='tasks'",
    );
    expect(rows).toHaveLength(7);
    expect(rows.filter((r) => r.cmd === "DELETE").map((r) => r.policyname)).toEqual(["tasks_fon_delete"]);
    expect(rows.some((r) => r.policyname.includes("accountability"))).toBe(false);
  });

  it("gives area_notes no DELETE policy for anyone", async () => {
    const { rows } = await db.query(
      "select cmd from pg_policies where schemaname='public' and tablename='area_notes'",
    );
    expect(rows).toHaveLength(7);
    expect(rows.some((r) => r.cmd === "DELETE")).toBe(false);
  });

  it("gives profiles exactly one policy, and it is read-only (D3)", async () => {
    const { rows } = await db.query(
      "select policyname, cmd from pg_policies where schemaname='public' and tablename='profiles'",
    );
    expect(rows).toEqual([{ policyname: "profiles_select_own", cmd: "SELECT" }]);
  });

  it.each(SERVER_ONLY_TABLES)("gives %s zero policies", async (table) => {
    const { rows } = await db.query(
      "select policyname from pg_policies where schemaname='public' and tablename=$1",
      [table],
    );
    expect(rows).toEqual([]);
  });

  // The D5a invariant. Scans every expression, so it binds policies added later
  // as well as the fifteen above.
  it("gates on no MFA assurance claim anywhere (D5a invariant)", async () => {
    const { rows } = await db.query(`
      select tablename, policyname
        from pg_policies
       where schemaname = 'public'
         and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~* '(aal[0-9]|assurance|auth\\.jwt)'
    `);
    expect(rows).toEqual([]);
  });
});

describe("the grant set matches the plan exactly (§3.2)", () => {
  it("gives authenticated exactly the nine expected privileges", async () => {
    const { rows } = await db.query(`
      select c.relname, p.priv
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                           ('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
       where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
         and has_table_privilege('authenticated', c.oid, p.priv)
    `);
    const actual = rows.map((r) => [r.relname, r.priv]).sort();
    expect(actual).toEqual([...EXPECTED_GRANTS].sort());
  });

  it("gives anon nothing at all", async () => {
    const { rows } = await db.query(`
      select c.relname, p.priv
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                           ('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
       where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
         and has_table_privilege('anon', c.oid, p.priv)
    `);
    expect(rows).toEqual([]);
  });

  it.each(SERVER_ONLY_TABLES)("gives authenticated no privilege on %s", async (table) => {
    const { rows } = await db.query(
      `select p.priv from (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv)
        where has_table_privilege('authenticated', $1, p.priv)`,
      [`public.${table}`],
    );
    expect(rows).toEqual([]);
  });

  // The silent dependency: Phase 4 relies on this and never grants it.
  it("keeps USAGE on schema public for authenticated (check 5a)", async () => {
    const { rows } = await db.query(
      "select has_schema_privilege('authenticated','public','USAGE') as ok",
    );
    expect(rows[0].ok).toBe(true);
  });

  it("exposes exactly one app-schema function to authenticated", async () => {
    const { rows } = await db.query(`
      select p.proname
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')
       order by p.proname
    `);
    expect(rows.map((r) => r.proname)).toEqual(["current_app_role"]);
  });

  // Postgres grants EXECUTE to PUBLIC on every new function by default, and
  // section 2 grants USAGE on schema app — so a function added later without an
  // explicit revoke becomes reachable. This is the durable form of that rule:
  // it fails for any future function, not just today's six.
  it("leaves no app function executable by PUBLIC", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proacl is null
       order by p.proname
    `);
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it("leaves no app function executable by anon", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and has_function_privilege('anon', p.oid, 'EXECUTE')
       order by p.proname
    `);
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it("denies anon USAGE on the app schema", async () => {
    const { rows } = await db.query(
      "select has_schema_privilege('anon','app','USAGE') as ok",
    );
    expect(rows[0].ok).toBe(false);
  });

  // docs/phase-4-auth-plan.md §3.2 specifies
  //   alter default privileges ... revoke execute on functions from public
  // to stop future functions inheriting PUBLIC EXECUTE. It does not work: the
  // statement records nothing and a function created afterwards still lands
  // with owner + PUBLIC. Reproduced here in four forms, because the migration
  // deliberately departs from the plan on this point and the reason has to be
  // checkable rather than asserted in a comment.
  it("reproduces why the planned ALTER DEFAULT PRIVILEGES line is a no-op", async () => {
    const variants = [
      "alter default privileges for role postgres in schema app revoke execute on functions from public",
      "alter default privileges in schema app revoke execute on functions from public",
      "alter default privileges for role postgres in schema app revoke all on functions from public",
      "alter default privileges for role postgres in schema app revoke execute on functions from public, anon, authenticated",
    ];
    for (const variant of variants) {
      const probe = await freshDb({ migrate: false });
      await probe.exec("create schema app;");
      await probe.exec(`${variant};`);
      await probe.exec("create function app.later() returns int language sql as $$ select 1 $$;");
      const { rows } = await probe.query(`
        select p.proacl is null as still_public,
               (select count(*)::int from pg_default_acl) as default_acl_rows
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.proname = 'later'
      `);
      // No default-ACL row is recorded, and the new function is still PUBLIC.
      expect(rows[0].default_acl_rows, variant).toBe(0);
      expect(rows[0].still_public, variant).toBe(true);
      await probe.close();
    }
  });

  it("an explicit revoke does work — which is what the migration uses instead", async () => {
    const probe = await freshDb({ migrate: false });
    await probe.exec(`
      create schema app;
      create function app.later() returns int language sql as $$ select 1 $$;
      revoke execute on function app.later() from public;
    `);
    const { rows } = await probe.query(`
      select has_function_privilege('authenticated', 'app.later()', 'EXECUTE') as reachable
    `);
    expect(rows[0].reachable).toBe(false);
    await probe.close();
  });

  it("still lets the touch_updated_at trigger run after its EXECUTE was revoked", async () => {
    // Postgres does not check EXECUTE on a trigger function for the triggering
    // user, so revoking it from PUBLIC does not break Phase 3's triggers. This
    // asserts that, because getting it wrong would break every update.
    await seedBoard();
    await withUser(db, fon, async () => {
      const { rows } = await db.query(
        "update public.tasks set title = 'renamed' where id = $1 returning updated_at",
        [SCHOOL],
      );
      expect(rows).toHaveLength(1);
    });
  });
});

// ─── BEHAVIOUR: WHAT EACH PERSON ACTUALLY REACHES ─────────────────────────────

describe("fon reaches the whole board", () => {
  beforeEach(seedBoard);

  it("reads every area", async () => {
    await withUser(db, fon, async () => {
      const { rows } = await db.query("select title from public.tasks");
      expect(titles(rows)).toEqual(
        ["Anniversary gift", "Client AB intake", "Groceries", "UMPI 311 paper"],
      );
    });
  });

  it("inserts, updates and deletes", async () => {
    await withUser(db, fon, async () => {
      await db.query(
        "insert into public.tasks (title, area) values ('New', 'work')",
      );
      const { rows: updated } = await db.query(
        "update public.tasks set title = 'Renamed' where id = $1 returning id", [WORK],
      );
      expect(updated).toHaveLength(1);
      const { rows: deleted } = await db.query(
        "delete from public.tasks where id = $1 returning id", [PRIVATE_HOME],
      );
      expect(deleted).toHaveLength(1);
    });
  });

  it("reads and writes every area note", async () => {
    await withUser(db, fon, async () => {
      const { rows } = await db.query("select area from public.area_notes");
      expect(rows).toHaveLength(3);
      const { rows: updated } = await db.query(
        "update public.area_notes set note = 'changed' where area = 'work' returning area",
      );
      expect(updated).toHaveLength(1);
    });
  });
});

describe("abigail reaches shared Family and Home, and nothing else", () => {
  beforeEach(seedBoard);

  it("reads only the shared Home task", async () => {
    await withUser(db, abigail, async () => {
      const { rows } = await db.query("select title from public.tasks");
      expect(titles(rows)).toEqual(["Groceries"]);
    });
  });

  it.each(["work", "school", "faith", "reading", "inbox"])(
    "reads nothing in %s", async (area) => {
      await insertTask(db, {
        id: "55555555-5555-4555-8555-555555555555", title: `A ${area} task`, area,
      });
      await withUser(db, abigail, async () => {
        const { rows } = await db.query("select title from public.tasks where area = $1", [area]);
        expect(rows).toEqual([]);
      });
    },
  );

  it("cannot see a private Family or Home task", async () => {
    await withUser(db, abigail, async () => {
      const { rows } = await db.query("select title from public.tasks where id = $1", [PRIVATE_HOME]);
      expect(rows).toEqual([]);
    });
  });

  it("updates nothing on a private Home task — zero rows, not an error", async () => {
    await withUser(db, abigail, async () => {
      const { rows } = await db.query(
        "update public.tasks set title = 'hijacked' where id = $1 returning id", [PRIVATE_HOME],
      );
      expect(rows).toEqual([]);
    });
    const { rows } = await db.query("select title from public.tasks where id = $1", [PRIVATE_HOME]);
    expect(rows[0].title).toBe("Anniversary gift");
  });

  it("cannot move a task out of her areas (WITH CHECK)", async () => {
    await withUser(db, abigail, async () => {
      const error = await expectViolation(() =>
        db.query("update public.tasks set area = 'school' where id = $1", [SHARED_HOME]),
      );
      expect(error.message).toMatch(/row-level security/i);
    });
  });

  it("cannot unshare a task to hide it (WITH CHECK)", async () => {
    await withUser(db, abigail, async () => {
      const error = await expectViolation(() =>
        db.query("update public.tasks set visibility = 'private' where id = $1", [SHARED_HOME]),
      );
      expect(error.message).toMatch(/row-level security/i);
    });
  });

  it("cannot unshare and move in one statement either", async () => {
    await withUser(db, abigail, async () => {
      const error = await expectViolation(() =>
        db.query(
          "update public.tasks set visibility = 'private', area = 'school' where id = $1",
          [SHARED_HOME],
        ),
      );
      expect(error.message).toMatch(/row-level security/i);
    });
  });

  // D1: archive-only. Archiving is reversible; deleting someone else's task
  // from a shared list is not, and is the easiest accident to make.
  it("cannot DELETE even a shared task she can see (D1)", async () => {
    await withUser(db, abigail, async () => {
      const { rows } = await db.query(
        "delete from public.tasks where id = $1 returning id", [SHARED_HOME],
      );
      expect(rows).toEqual([]);
    });
    const { rows } = await db.query("select id from public.tasks where id = $1", [SHARED_HOME]);
    expect(rows).toHaveLength(1);
  });

  it("can archive a shared task instead (D1)", async () => {
    await withUser(db, abigail, async () => {
      const { rows } = await db.query(
        "update public.tasks set status = 'archived' where id = $1 returning status", [SHARED_HOME],
      );
      expect(rows[0].status).toBe("archived");
    });
  });

  it("cannot insert into an area she does not hold", async () => {
    await withUser(db, abigail, async () => {
      const error = await expectViolation(() =>
        db.query("insert into public.tasks (title, area) values ('sneaky', 'work')"),
      );
      expect(error.message).toMatch(/row-level security/i);
    });
  });

  it("cannot insert a private task into her own areas", async () => {
    await withUser(db, abigail, async () => {
      const error = await expectViolation(() =>
        db.query(
          "insert into public.tasks (title, area, visibility) values ('hidden', 'home', 'private')",
        ),
      );
      expect(error.message).toMatch(/row-level security/i);
    });
  });

  it("reads only Family and Home area notes", async () => {
    await withUser(db, abigail, async () => {
      const { rows } = await db.query("select area from public.area_notes");
      expect(rows.map((r) => r.area)).toEqual(["home"]);
    });
  });
});

describe("accountability reads the School summary and nothing else (D6)", () => {
  beforeEach(seedBoard);

  it("reads zero rows from tasks directly", async () => {
    await withUser(db, accountability, async () => {
      const { rows } = await db.query("select * from public.tasks");
      expect(rows).toEqual([]);
    });
  });

  it("reads School titles through the view", async () => {
    await withUser(db, accountability, async () => {
      const { rows } = await db.query("select title from public.school_summary");
      expect(titles(rows)).toEqual(["UMPI 311 paper"]);
    });
  });

  it("cannot reach notes: the column is not in the view", async () => {
    await withUser(db, accountability, async () => {
      const error = await expectViolation(() => db.query("select notes from public.school_summary"));
      expect(error.message).toMatch(/column "notes" does not exist/i);
    });
  });

  it("sees no non-School task through the view", async () => {
    await withUser(db, accountability, async () => {
      const { rows } = await db.query("select title from public.school_summary");
      expect(rows.map((r) => r.title)).not.toContain("Client AB intake");
    });
  });

  it.each(["insert", "update", "delete"])("cannot %s a task", async (verb) => {
    const statements = {
      insert: "insert into public.tasks (title, area) values ('x', 'school')",
      update: "update public.tasks set title = 'x' where id = $1",
      delete: "delete from public.tasks where id = $1",
    };
    await withUser(db, accountability, async () => {
      if (verb === "insert") {
        const error = await expectViolation(() => db.query(statements[verb]));
        expect(error.message).toMatch(/row-level security/i);
      } else {
        const { rows } = await db.query(`${statements[verb]} returning id`, [SCHOOL]);
        expect(rows).toEqual([]);
      }
    });
  });

  it("cannot write through the view", async () => {
    await withUser(db, accountability, async () => {
      const error = await expectViolation(() =>
        db.query("update public.school_summary set title = 'x'"),
      );
      expect(error.message).toMatch(/permission denied|cannot (update|be updated)/i);
    });
  });

  it("reads the School area note but no other", async () => {
    await withUser(db, accountability, async () => {
      const { rows } = await db.query("select area from public.area_notes");
      expect(rows.map((r) => r.area)).toEqual(["school"]);
    });
  });
});

describe("the view's security properties (§3.7)", () => {
  it("is a definer view with a barrier, owned by postgres", async () => {
    const { rows } = await db.query(`
      select array_to_string(c.reloptions, ',') as opts, pg_get_userbyid(c.relowner) as owner
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'school_summary' and c.relkind = 'v'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].opts).toMatch(/security_invoker=false/);
    // Without the barrier, a caller's leaky predicate can be pushed below the
    // view's own filter and observe rows the filter was meant to exclude.
    expect(rows[0].opts).toMatch(/security_barrier=true/);
    expect(rows[0].owner).toBe("postgres");
  });

  it("exposes exactly the agreed columns, and notes is not among them", async () => {
    const { rows } = await db.query(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'school_summary'
       order by column_name
    `);
    expect(rows.map((r) => r.column_name)).toEqual([
      "completed_at", "due_date", "due_time", "id", "priority", "status", "title", "updated_at",
    ]);
  });

  it("carries the role filter in its definition", async () => {
    const { rows } = await db.query(
      "select pg_get_viewdef('public.school_summary'::regclass, true) as def",
    );
    expect(rows[0].def).toMatch(/current_app_role/);
    expect(rows[0].def).toMatch(/accountability/);
    expect(rows[0].def).not.toMatch(/notes/);
  });

  it("is the only view in public, and there are no materialized views", async () => {
    const { rows } = await db.query(`
      select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('v','m')
    `);
    expect(rows).toEqual([{ relname: "school_summary", relkind: "v" }]);
  });

  it("returns nothing to abigail or to an unprofiled user", async () => {
    await seedBoard();
    await withUser(db, abigail, async () => {
      const { rows } = await db.query("select * from public.school_summary");
      expect(rows).toEqual([]);
    });
    const stray = await signUpWithoutProfile(db);
    await withUser(db, stray, async () => {
      const { rows } = await db.query("select * from public.school_summary");
      expect(rows).toEqual([]);
    });
  });
});

// The dependency the plan described but did not state: a definer object runs as
// its owner, and FORCE ROW LEVEL SECURITY makes even the table owner subject to
// RLS. Both app.current_app_role() and school_summary work only because the
// owner additionally bypasses RLS.
//
// On Supabase `postgres` holds BYPASSRLS (confirmed in Phase 3 from pg_roles).
// In PGlite `postgres` is a superuser, which bypasses for a different reason —
// so a test that only ran as postgres would pass for the wrong reason and prove
// nothing about the hosted project. This reproduces both role shapes directly.
describe("definer objects depend on the owner bypassing FORCE RLS (check 21)", () => {
  async function definerViewRowCount(ownerBypassesRls) {
    const probe = await freshDb({ migrate: false });
    await probe.exec(`
      create role vw_owner nologin ${ownerBypassesRls ? "bypassrls" : ""};
      grant usage, create on schema public to vw_owner;
      grant usage on schema public to authenticated;
      create table public.t (id int, area text);
      insert into public.t values (1, 'school');
      alter table public.t owner to vw_owner;
      alter table public.t enable row level security;
      alter table public.t force row level security;
      set role vw_owner;
      create view public.v with (security_invoker = false, security_barrier = true)
        as select id from public.t where area = 'school';
      reset role;
      grant select on public.v to authenticated;
    `);
    await probe.exec("set role authenticated");
    const { rows } = await probe.query("select * from public.v");
    await probe.exec("reset role");
    await probe.close();
    return rows.length;
  }

  it("returns rows when the owner bypasses RLS — the Supabase shape", async () => {
    expect(await definerViewRowCount(true)).toBe(1);
  });

  it("returns ZERO rows when it does not — a silent outage, not a leak", async () => {
    // Fail-closed, which is the right direction, but a total outage that no
    // other check would explain. Hence check 21.
    expect(await definerViewRowCount(false)).toBe(0);
  });

  it("check 21 asserts the live owner can do it", async () => {
    const { rows } = await db.query(`
      select bool_and(r.rolsuper or r.rolbypassrls) as ok
        from (
          select p.proowner as owner from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app' and p.proname = 'current_app_role'
          union all
          select c.relowner from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'school_summary'
        ) o join pg_roles r on r.oid = o.owner
    `);
    expect(rows[0].ok).toBe(true);
  });
});

// ─── DEFAULT DENY ─────────────────────────────────────────────────────────────

describe("an account on its own grants nothing (§2)", () => {
  it("creates no profile row for a new auth user — nothing auto-provisions", async () => {
    const before = await db.query("select count(*)::int as n from public.profiles");
    await signUpWithoutProfile(db);
    const after = await db.query("select count(*)::int as n from public.profiles");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("installs no trigger on auth.users", async () => {
    const { rows } = await db.query(`
      select t.tgname from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'auth' and not t.tgisinternal
    `);
    expect(rows).toEqual([]);
  });

  it("has no function anywhere that inserts into profiles", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('app', 'public')
         and p.prosrc ~* 'insert\\s+into\\s+(public\\.)?profiles'
    `);
    expect(rows).toEqual([]);
  });

  it.each(["tasks", "area_notes", "profiles", "school_summary"])(
    "gives an unprofiled user zero rows from %s", async (rel) => {
      await seedBoard();
      const stray = await signUpWithoutProfile(db);
      await withUser(db, stray, async () => {
        const { rows } = await db.query(`select * from public.${rel}`);
        expect(rows).toEqual([]);
      });
    },
  );

  it.each(["tasks", "area_notes", "profiles", "school_summary", ...SERVER_ONLY_TABLES])(
    "denies anon any access to %s", async (rel) => {
      await withAnon(db, async () => {
        const error = await expectViolation(() => db.query(`select * from public.${rel}`));
        expect(error.message).toMatch(/permission denied/i);
      });
    },
  );

  it.each(SERVER_ONLY_TABLES)("denies every signed-in role any read of %s", async (table) => {
    for (const user of [fon, abigail, accountability]) {
      await withUser(db, user, async () => {
        const error = await expectViolation(() => db.query(`select * from public.${table}`));
        expect(error.message).toMatch(/permission denied/i);
      });
    }
  });
});

describe("profiles is read-own and has no write path (D3)", () => {
  it("lets each person read only their own row", async () => {
    for (const [role, id] of [["fon", fon], ["abigail", abigail], ["accountability", accountability]]) {
      await withUser(db, id, async () => {
        const { rows } = await db.query("select user_id, role from public.profiles");
        expect(rows).toHaveLength(1);
        expect(rows[0].role).toBe(role);
      });
    }
  });

  it.each([
    ["update", "update public.profiles set role = 'fon'"],
    ["insert", "insert into public.profiles (user_id, role) values ('00000000-0000-4000-8000-00000000dead','fon')"],
    ["delete", "delete from public.profiles"],
  ])("denies abigail any %s on profiles — self-elevation is not reachable (T1)", async (_verb, sql) => {
    await withUser(db, abigail, async () => {
      const error = await expectViolation(() => db.query(sql));
      expect(error.message).toMatch(/permission denied/i);
    });
    const { rows } = await db.query("select role from public.profiles where user_id = $1", [abigail]);
    expect(rows[0].role).toBe("abigail");
  });

  it("gives authenticated no write privilege on profiles at all", async () => {
    const { rows } = await db.query(`
      select p.priv from (values ('INSERT'),('UPDATE'),('DELETE')) p(priv)
       where has_table_privilege('authenticated', 'public.profiles', p.priv)
    `);
    expect(rows).toEqual([]);
  });
});

// ─── PROVENANCE (§3.6) ────────────────────────────────────────────────────────

describe("provenance is stamped inside app sessions and immutable everywhere", () => {
  it("stamps fon's insert as fon/manual", async () => {
    await withUser(db, fon, async () => {
      const { rows } = await db.query(
        "insert into public.tasks (title, area) values ('x','inbox') returning created_by, source",
      );
      expect(rows[0]).toEqual({ created_by: "fon", source: "manual" });
    });
  });

  it("stamps abigail's insert as abigail/abigail even when she claims otherwise", async () => {
    await withUser(db, abigail, async () => {
      const { rows } = await db.query(`
        insert into public.tasks (title, area, visibility, created_by, source)
        values ('mine', 'home', 'shared', 'fon', 'manual')
        returning created_by, source
      `);
      expect(rows[0]).toEqual({ created_by: "abigail", source: "abigail" });
    });
  });

  it("leaves a session with no auth.uid() untouched — the importer path", async () => {
    const { rows } = await db.query(`
      insert into public.tasks (title, area, created_by, source)
      values ('imported', 'inbox', 'pong', 'pong-voice')
      returning created_by, source
    `);
    expect(rows[0]).toEqual({ created_by: "pong", source: "pong-voice" });
  });

  it("leaves a signed-in but unprofiled session untouched too", async () => {
    const stray = await signUpWithoutProfile(db);
    await db.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: stray }),
    ]);
    const { rows } = await db.query(`
      insert into public.tasks (title, area, created_by, source)
      values ('odd', 'inbox', 'claude-import', 'claude-import')
      returning created_by, source
    `);
    await db.query("select set_config('request.jwt.claims', '', false)");
    expect(rows[0]).toEqual({ created_by: "claude-import", source: "claude-import" });
  });

  it.each(["created_by", "source"])("refuses to let any role change %s", async (column) => {
    await seedBoard();
    const error = await expectViolation(() =>
      db.query(`update public.tasks set ${column} = 'abigail' where id = $1`, [SCHOOL]),
    );
    expect(error.message).toMatch(/immutable/i);
  });

  it("refuses to let fon change created_at or id through an app session", async () => {
    await seedBoard();
    await withUser(db, fon, async () => {
      const error = await expectViolation(() =>
        db.query("update public.tasks set created_at = now() where id = $1", [SCHOOL]),
      );
      expect(error.message).toMatch(/immutable/i);
    });
  });

  it("still allows an ordinary edit", async () => {
    await seedBoard();
    await withUser(db, fon, async () => {
      const { rows } = await db.query(
        "update public.tasks set title = 'Renamed' where id = $1 returning title", [SCHOOL],
      );
      expect(rows[0].title).toBe("Renamed");
    });
  });

  // The whole reason the stamp is conditional. An unconditional trigger would
  // rewrite every imported row to fon/manual and destroy the history Phases 2
  // and 3 went to trouble to preserve.
  it("preserves every Phase 3 provenance value through a BYPASSRLS import", async () => {
    const fixtures = [
      ["pong", "pong-voice"],
      ["claude-import", "claude-import"],
      ["abigail", "abigail"],
      ["fon", "manual"],
    ];
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'importer') then
          create role importer nologin bypassrls;
        end if;
      end $$;
      grant usage on schema public, auth to importer;
      grant insert, select on public.tasks to importer;
    `);
    await db.exec("set role importer");
    for (const [i, [createdBy, source]] of fixtures.entries()) {
      await db.query(
        `insert into public.tasks (id, title, area, created_by, source)
         values ($1, $2, 'inbox', $3, $4)`,
        [`00000000-0000-4000-8000-00000000000${i}`, `row ${i}`, createdBy, source],
      );
    }
    await db.exec("reset role");

    const { rows } = await db.query(
      "select created_by, source from public.tasks order by title",
    );
    expect(rows.map((r) => [r.created_by, r.source])).toEqual(fixtures);

    await db.exec("revoke all on public.tasks from importer");
  });
});
