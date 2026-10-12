-- ato-expiry-automation local test database schema.
-- Fake data only. Runs automatically on first container start via
-- docker-entrypoint-initdb.d (alongside 02-seed.sql, in filename order).

CREATE TABLE stock (
    sku         char(11) PRIMARY KEY,
    description text NOT NULL,
    qty         int NOT NULL DEFAULT 0
);

CREATE TABLE routing (
    prefix      text PRIMARY KEY,
    stage       text NOT NULL,
    next_step   text NOT NULL,
    check_order int NOT NULL
);
