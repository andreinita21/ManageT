# Groups feature — implementation review

Branch state: `main`, fast-forward of `pre-groups-feature` tag.

## What shipped

A new "groups" concept layered on top of free-standing terminal sessions:

- A **group** is a persisted, user-named collection of up to **6** standalone
  terminal sessions.
- Sessions that belong to a `stacks` row are **ineligible** for groups
  (mutually exclusive by design).
- The group's view at `/groups/[id]` lays out its members in a
  **3-per-row** mosaic (rows of 1–3, max 2 rows) with **draggable** row
  heights and per-row column widths, and supports **drag-and-drop**
  reordering with a blurred-pane + glowing accent overlay and big
  centered slot numbers.
- The `/sessions` page is now a hub with three headed sections:
  **Terminal sessions** (standalone), **Group Terminal sessions**
  (linking to each group's mosaic), and **Stacks** (linking out to
  `/stacks`).

## Files added

### DB
- `drizzle/0007_groups.sql` — adds `groups`, `group_layouts`; adds
  `sessions.group_id` and `sessions.group_order_index`.
- `src/lib/db/schema.ts` — `groups`, `groupLayouts`, plus the two new
  columns on `sessions` (`groupId`, `groupOrderIndex`).

### Backend (lib + API)
- `src/lib/groups/index.ts` — CRUD + constraint enforcement
  (`createGroupWithFirstMember`, `addMember`, `removeMember`,
  `reorderMembers`, `renameGroup`, `deleteGroup`,
  `cleanupEmptyGroupIfNeeded`, `getUserLayout` / `saveUserLayout`).
  Includes `GroupConstraintError` for clean 400 surfaces from the
  routes.
- `src/app/api/groups/route.ts` — GET list / POST create.
- `src/app/api/groups/[id]/route.ts` — GET / PATCH (rename) / DELETE.
- `src/app/api/groups/[id]/members/route.ts` — POST add.
- `src/app/api/groups/[id]/members/[sessionId]/route.ts` — DELETE detach
  (returns `{ groupDeleted: boolean }` for auto-cleanup signalling).
- `src/app/api/groups/[id]/order/route.ts` — PUT full reorder.
- `src/app/api/groups/[id]/layout/route.ts` — GET/PUT per-user layout.
- `src/lib/ssh/session-manager.ts` — `killSession` now captures the
  outgoing `groupId` before the row is dropped and calls
  `cleanupEmptyGroupIfNeeded` so closing the last member of a group
  auto-deletes it.
- `src/lib/db/transform.ts` — consolidated `rowToSession` (was
  duplicated in 4 places; now imported from one place; also surfaces
  the new `groupId` / `groupOrderIndex` fields).
- `src/lib/hooks/useApi.ts` — `useGroups`, `useGroup`, plus client
  helpers for create / rename / delete / addGroupMember /
  removeGroupMember / reorderGroup / getGroupLayout / saveGroupLayout.
- `src/types/index.ts` — `Group`, `GroupLayout`, `CreateGroupRequest`,
  `AddGroupMemberRequest`, `ReorderGroupRequest`, `GROUP_MAX_MEMBERS`.
  Extended `Session` with the new optional `groupId` / `groupOrderIndex`.

### UI
- `src/app/(dashboard)/groups/[id]/page.tsx` — group page: header strip
  (name, member count, rename, delete-group, "+ Add terminal"),
  member-removal handler, add-member modal (existing-free picker +
  launch-new-on-server picker).
- `src/app/(dashboard)/groups/[id]/GroupMosaic.tsx` — the resizable
  mosaic. Vertical `PanelGroup` wraps two horizontal `PanelGroup`s
  (one per row). Drag-and-drop is native HTML5 with `swap` semantics
  (drop A onto B → A and B swap positions). During a drag every cell
  shows a big centered slot number; the source pane blurs more, the
  hover target glows accent-bright, and the panel-resize handles light
  up in accent. Layout state (row heights + per-row col widths) is
  persisted per user with a 350ms debounce.
- `src/app/(dashboard)/sessions/page.tsx` — replaced the flat table
  with three sectioned views. Group rows expose **View / Remove /
  Close**; free-terminal rows expose **View / Group… / Logs / Close**
  where Group… opens a picker (existing groups + "New group…").
- `src/components/terminal/GroupMenu.tsx` — floating top-right control
  on `/terminal`. Hidden when the active session is stack-bound or has
  no backend id yet. For free sessions shows existing groups +
  "New group…"; for grouped sessions shows "Open group view" +
  "Remove from group".
- `src/app/(terminal)/terminal/page.tsx` — overlays `<GroupMenu>` on
  the active tab so the user can group/ungroup without leaving the
  terminal.
- `src/components/SidebarLayout.tsx` — `/groups` joins the list of
  routes that own their full content height (no `p-6` from the
  layout).

### Tests / scripts
- `scripts/groups-smoke.ts` — runs the lib helpers against the real
  dev DB end-to-end: create, add, reject-duplicate, reject-stack-bound,
  reorder, layout round-trip, remove, auto-cleanup, idempotent
  cleanup. Self-cleans, safe to re-run.

## Verification performed

1. **TypeScript** — `npx tsc --noEmit` ⇒ no errors.
2. **Lint** — `npx eslint <changed files>` ⇒ no errors. (The repo has
   pre-existing lint errors in unrelated files; none in new code.)
3. **Production build** — `npx next build` ⇒ ✓ compiled, all 6 new
   API routes and `/groups/[id]` page emitted.
4. **Migration** — `npx drizzle-kit migrate` ⇒ ✓ applied; DB now has
   `groups`, `group_layouts`, and the two new columns on `sessions`.
5. **Lib end-to-end** — `npx tsx scripts/groups-smoke.ts` ⇒
   `ALL CHECKS PASSED`.
   - Creates a group with the first member.
   - Adds members 2 + 3.
   - Rejects re-adding the same session (`session_in_other_group`).
   - Rejects adding a stack-bound session (`session_in_stack`).
   - Reorders members; verifies the new order persists with correct
     `groupOrderIndex` values.
   - Saves and reads back a layout payload (round-trip equality).
   - Removes one member; verifies `groupOrderIndex` is repacked to
     `[0, 1]`.
   - Removes the last member; verifies the group row is auto-deleted
     and `getGroup` returns null.
   - `cleanupEmptyGroupIfNeeded` second call is a no-op (idempotent).
   - Idempotent: rerunning the script leaves zero residue.
6. **HTTP smoke** — production server on :3099:
   - `GET /api/groups` ⇒ 401 (auth).
   - `GET /api/groups/<id>` / `layout` ⇒ 401 (auth).
   - `GET /api/groups/<id>/members` and `/order` ⇒ 405 (POST/PUT only,
     as designed).
   - `GET /groups/<id>` ⇒ 200 (page renders).
   - `GET /sessions`, `/terminal`, `/stacks` still 200.

## Behaviour and constraints (locked in)

- **Cap**: 6 members per group, enforced server-side in
  `assertGroupHasRoom`.
- **Stack vs. group**: server-side rejection
  (`GroupConstraintError("session_in_stack")`) at every entry point —
  `addMember` and `createGroupWithFirstMember` both go through
  `assertSessionEligible`.
- **One group per session**: enforced via single `sessions.group_id`
  column (no join table) and the `session_in_other_group` rejection.
- **Auto-delete empty group**: any path that nulls `groupId` calls
  `cleanupEmptyGroupIfNeeded`. Covered: `removeMember` (UI detach),
  `killSession` (session closed/killed). The DB FK on
  `sessions.group_id` is `REFERENCES groups(id)` without ON DELETE
  behaviour, so the explicit cleanup on the application side is
  load-bearing.
- **Layout persistence is per-user**: separate `group_layouts` rows
  keyed `(userId, groupId)`. If the saved shape doesn't match the
  current member count (someone added a terminal since last visit),
  the UI falls back to the equal-split default and overwrites on the
  next drag.

## Known limitations / explicit non-goals

- **No empty groups**: creating a group requires a first member;
  removing the last member auto-deletes it.
- **No description**: groups have `name` only (per spec).
- **No multi-group membership**: a session is in 0 or 1 group at a
  time (per spec).
- **The `sessions.group_id` foreign key** has no `ON DELETE` clause —
  drizzle's ALTER TABLE ADD COLUMN form can't include it in SQLite.
  Cleanup is therefore enforced application-side (see above) rather
  than at the DB layer; the smoke test verifies this works for the
  paths the UI uses.
- **Layout ratios are `defaultSize` on the `Panel` elements**, not
  controlled. `react-resizable-panels` then takes over and emits
  `onLayout` callbacks we persist. This is intentional — the controlled
  form requires a different API and re-renders fight with the live
  drag. Effect: switching member counts (add/remove a terminal) resets
  to the equal-split default for that count, which then gets adjusted
  by the next drag.
- **Drag-and-drop semantics**: drop A onto B swaps positions. We don't
  do "insert before / after" insertion semantics — swap was simpler
  and matched the spec language ("drag and drop a terminal to another
  position").

## Rollback

- `pre-groups-feature` tag on origin/main points at the commit
  immediately before this work.
- The migration `0007_groups.sql` adds tables/columns; rolling back
  the code while leaving the DB schema in place is safe (the extra
  columns are nullable / defaulted).

## What I did NOT touch

- `/stacks` route and stacks lib — unchanged.
- Existing terminal lifecycle (xterm, websocket, reconnect, recovery
  banner) — unchanged; the mosaic re-uses the same `TerminalPane`
  component without modification.
- Auth, RBAC, sidebar nav entries — `/groups/[id]` is reached via
  links from `/sessions` and `/terminal`; no new top-level nav item
  was added (per spec — groups appear inside the Sessions hub).
