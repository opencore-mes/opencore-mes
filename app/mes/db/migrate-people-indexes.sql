-- ---- people at a plant's scale (tens of thousands) ----
-- "Which groups is this person in": every role check asks it (store.rolesFor), and People &
-- departments' views; the primary key leads with the group.
CREATE INDEX IF NOT EXISTS group_members_user ON mes.group_members (user_id);
