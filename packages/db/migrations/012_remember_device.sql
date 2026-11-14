-- "Remember this device": a signed-in browser can stay signed in for a set number of
-- days (REMEMBER_DEVICE_DAYS) instead of ending after an hour without activity.
-- Each sign-in also keeps a short, non-identifying label ("Chrome on Mac") so the
-- person can see where they're signed in and sign any of them out.
ALTER TABLE user_session
  ADD COLUMN remember_requested boolean NOT NULL DEFAULT false,  -- ticked at sign-in, applied once the code is right
  ADD COLUMN remembered_until   timestamptz,                     -- set: a fixed end, no idle timeout before it
  ADD COLUMN device_label       text;
