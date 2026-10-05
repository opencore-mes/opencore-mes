-- The hello suite's table: safe to run again, as every migration is.
CREATE TABLE IF NOT EXISTS mes.hello_notes (
  id      serial PRIMARY KEY,
  text    text NOT NULL,
  by_user text NOT NULL
);
