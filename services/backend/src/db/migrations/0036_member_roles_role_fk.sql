-- Security audit 2026-10: nothing tied member_roles.role_id to the row's own
-- space, so a role from another space could be attached to a member here
-- (and, before the lookups were scoped, carry that space's Admin flag). The
-- backend now scopes every role lookup; this makes the database refuse such
-- rows outright, drops any that exist, and removes member_roles rows when
-- their role is deleted (previously they were orphaned).

DELETE FROM app.member_roles mr
 WHERE NOT EXISTS (
   SELECT 1 FROM app.space_roles r
    WHERE r.id = mr.role_id AND r.space_id = mr.space_id
 );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'space_roles_id_space_id_key') THEN
    ALTER TABLE app.space_roles ADD CONSTRAINT space_roles_id_space_id_key UNIQUE (id, space_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_roles_role_in_space_fk') THEN
    ALTER TABLE app.member_roles
      ADD CONSTRAINT member_roles_role_in_space_fk
      FOREIGN KEY (role_id, space_id) REFERENCES app.space_roles (id, space_id)
      ON DELETE CASCADE;
  END IF;
END $$;
