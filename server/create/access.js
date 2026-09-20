import { choice, noul } from "../jev.js";
import { newId } from "./ops.js";
import { safeName } from "./validate.js";
import { PRIVILEGES } from "./types.js";
import { stagedReply } from "./wording.js";

// Roles, grants and row-level security by natural language. Only the request text and table or role
// names go to Jev. Roles are always created without login: a password never passes through here.

const NONE = "__none__";
const STATED = 0.6;
const OWNERISH = /(owner|user|created_by|author|tenant|org|organization|account|workspace|team)/;

const PRIVILEGE_MEANING = {
  SELECT: "read, view, query or select rows",
  INSERT: "add, create or insert new rows",
  UPDATE: "edit, change or update existing rows",
  DELETE: "delete or remove rows",
};

export async function interpretAccess({ reading, request, state, draft, tables, schema, spans, targetTable, mentioned, ops, done, decline }) {
  const existingRoles = Object.keys(draft.roles).filter((r) => !/^pg_/.test(r)).slice(0, 80);
  // "the support role" names the role support: a trailing generic word, spoken as a separate word, is not part of the name.
  const roleIdent = (s) => (/\s(role|user|group|account)$/i.test(s.text) ? s.ident.replace(/_(role|user|group|account)$/, "") : s.ident);
  const newRoles = [...new Set(spans.roles.map((s) => safeName(roleIdent(s))))].filter((r) => r && !existingRoles.includes(r));
  const roleOptions = { ...Object.fromEntries(existingRoles.map((r) => [r, `The existing role ${r}`])), ...Object.fromEntries(newRoles.map((r) => [r, `A role called ${r}, named in the request`])) };

  const q = {
    action: choice("What does `request` ask for?", {
      create_role: "Only create a new role, without saying what it may access.",
      grant: "Give a role access to tables (it may also need the role to be created first).",
      revoke: "Take access away from a role.",
      row_policy: "Restrict which rows people can see or change, so that each user or tenant only gets their own rows.",
    }),
    on_all: noul("Does `request` ask for access to every table, the whole database or the whole schema, rather than to particular tables?"),
    tmpl: choice("If `request` restricts which rows are visible, what is the rule?", {
      owner_column: "Each row belongs to one database user, and users see only their own rows.",
      tenant_setting: "Each row belongs to a tenant, organization, account or workspace, and a session sees only the rows of its own tenant.",
      read_all: "Everyone may read every row.",
      [NONE]: "It does not restrict rows.",
    }),
  };
  if (Object.keys(roleOptions).length) q.role = choice("Which role does `request` give access to, take access from, or create?", { ...roleOptions, [NONE]: "None of these." });
  // A checkable rule stays in code: "read-only" means SELECT and nothing else.
  const readOnly = /\bread[- ]?only\b|\bview[- ]?only\b/i.test(request);
  const fullAccess = /\b(full|all|complete) (access|privileges|permissions)\b|\bread and write\b|\bread\/write\b/i.test(request);
  if (!readOnly && !fullAccess) for (const p of PRIVILEGES) q[`priv:${p}`] = noul(`Does \`request\` say the role should be able to ${PRIVILEGE_MEANING[p]}?`);
  for (const t of tables.slice(0, 80)) q[`on:${t.label}`] = noul(`Does \`request\` ask for access to, or a row restriction on, the table "${t.label}" specifically?`);
  const policyTable = targetTable ?? mentioned[0];
  const policyColumns = policyTable ? policyTable.table.columns.filter((c) => OWNERISH.test(c.name)).slice(0, 20) : [];
  if (policyColumns.length) {
    q.pcol = choice(`Which column of "${policyTable.label}" says who a row belongs to?`, { ...Object.fromEntries(policyColumns.map((c) => [c.name, c.type.base ?? "other"])), [NONE]: "None of these." });
  }

  const a = await reading.ask(state, q);
  const action = reading.choice("action", "Access change", a.action, { labels: { create_role: "create a role", grant: "grant", revoke: "revoke", row_policy: "row-level security" } });
  if (!action.ok) return decline("I couldn't tell whether you want to create a role, grant access, revoke access or restrict rows. Say it directly, for example: \"create a read-only role called analyst\".");

  if (action.value === "row_policy") {
    if (!policyTable) return decline("Row-level security applies to one table. Name it, for example: \"users should only see their own rows in documents\".");
    const tmpl = reading.choice("tmpl", "Rule", a.tmpl, { labels: { owner_column: "own rows", tenant_setting: "own tenant", read_all: "everyone reads", [NONE]: "none" } });
    if (!tmpl.ok || tmpl.value === NONE) return decline("I couldn't tell which rows each user should see. I can write two rules: each user sees rows they own, or each tenant sees its own rows.");
    const op = { id: newId(), kind: "create_policy", table: policyTable.id, template: tmpl.value };
    if (tmpl.value !== "read_all") {
      const pcol = q.pcol ? reading.choice("pcol", "Owner column", a.pcol, { labels: { [NONE]: "none" } }) : { ok: false };
      if (!pcol.ok || pcol.value === NONE) {
        return decline(`${policyTable.label} has no column that says who a row belongs to. Add one first, for example "add owner to ${policyTable.label}" (text, holding the role name) or a tenant_id.`);
      }
      op.column = pcol.value;
    }
    ops.push(op);
    return done({
      reply: { text: stagedReply([op]), notes: [tmpl.value === "tenant_setting"
        ? "Your application must run  set app.tenant_id = '…'  at the start of each session or transaction. Table owners and superusers bypass policies, so connect the app as an ordinary role."
        : "Table owners and superusers bypass policies, so connect the app as an ordinary role."] },
      added: [op.id],
    });
  }

  const role = q.role ? reading.choice("role", "Role", a.role, { labels: { [NONE]: "not named" } }) : { ok: false };
  if (!role.ok || role.value === NONE) return decline("I need the role's name, and I can only use a name that appears in your message. For example: \"create a role called analyst that can read orders\".");
  const made = [];
  if (!existingRoles.includes(role.value)) made.push({ id: newId(), kind: "create_role", name: role.value });
  if (action.value !== "create_role" || readOnly || fullAccess) {
    let privileges;
    if (readOnly) { privileges = ["SELECT"]; reading.rule("priv", "Privileges", "read-only → SELECT"); }
    else if (fullAccess) { privileges = [...PRIVILEGES]; reading.rule("priv", "Privileges", "full access → all four"); }
    else privileges = PRIVILEGES.filter((p) => reading.noul(`priv:${p}`, `May ${p.toLowerCase()}`, a[`priv:${p}`]).ok);
    const named = tables.filter((t) => reading.noul(`on:${t.label}`, `On ${t.label}`, a[`on:${t.label}`]).ok);
    const all = !named.length || reading.noul("on_all", "Every table", a.on_all).ok;
    if (privileges.length) {
      const kind = action.value === "revoke" ? "revoke" : "grant";
      if (all) made.push({ id: newId(), kind, role: role.value, privileges, allIn: schema });
      else for (const t of named) made.push({ id: newId(), kind, role: role.value, privileges, table: t.id });
    } else if (action.value !== "create_role") {
      return decline("I couldn't tell which kind of access you mean. Say read, add, edit or delete, or \"read-only\" / \"full access\".");
    }
  }
  if (!made.length) return decline(`The role ${role.value} already exists, and I didn't find anything to grant it.`);
  ops.push(...made);
  const notes = [];
  if (made.some((o) => o.kind === "create_role")) notes.push("New roles are created without login, and I never handle passwords. To sign in as it, set a password yourself in the SQL editor, or grant this role to an existing login role.");
  if (made.some((o) => o.allIn)) notes.push("Granting on every table covers the tables that exist when you apply, not ones created later.");
  return done({ reply: { text: stagedReply(made), notes }, added: made.map((o) => o.id) });
}
