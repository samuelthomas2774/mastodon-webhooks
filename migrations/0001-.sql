--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

CREATE TABLE webhooks (
    id          INTEGER PRIMARY KEY,
    type        TEXT    NOT NULL,
    url         TEXT    NOT NULL
);

CREATE TABLE webhook_filter_acct (
    id          INTEGER PRIMARY KEY,
    webhook_id  INTEGER NOT NULL,
    acct        TEXT    NOT NULL
);
CREATE TABLE webhook_filter_host (
    id          INTEGER PRIMARY KEY,
    webhook_id  INTEGER NOT NULL,
    host        TEXT    NOT NULL
);

--------------------------------------------------------------------------------
-- Down
--------------------------------------------------------------------------------

DROP TABLE webhooks;
DROP TABLE webhook_filter_acct;
DROP TABLE webhook_filter_host;
