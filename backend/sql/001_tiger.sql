-- Explicitly installed by flask init-tiger; never run during ordinary startup.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE IF NOT EXISTS meadow_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 document jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0, instance text NOT NULL
);
CREATE TABLE IF NOT EXISTS meadow_org_members (
 org_id text NOT NULL, user_id text NOT NULL, role text NOT NULL,
 PRIMARY KEY(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS meadow_busy_slots (
 user_id text NOT NULL, slot_start timestamptz NOT NULL, PRIMARY KEY(user_id,slot_start)
);
CREATE TABLE IF NOT EXISTS meadow_messages (
 id text NOT NULL, org_id text, channel text NOT NULL, user_id text,
 body text NOT NULL, source text NOT NULL, payload jsonb, created_at timestamptz NOT NULL,
 PRIMARY KEY(id,created_at)
);
CREATE TABLE IF NOT EXISTS meadow_presence_events (
 user_id text NOT NULL, org_id text NOT NULL, observed_at timestamptz NOT NULL,
 presence text NOT NULL, PRIMARY KEY(user_id,org_id,observed_at)
);
CREATE TABLE IF NOT EXISTS meadow_checkins (
 event_id text NOT NULL, user_id text NOT NULL, org_id text NOT NULL,
 checked_at timestamptz NOT NULL, PRIMARY KEY(event_id,user_id,checked_at)
);
SELECT create_hypertable('meadow_busy_slots',by_range('slot_start'),if_not_exists=>true);
SELECT create_hypertable('meadow_messages',by_range('created_at'),if_not_exists=>true);
SELECT create_hypertable('meadow_presence_events',by_range('observed_at'),if_not_exists=>true);
SELECT create_hypertable('meadow_checkins',by_range('checked_at'),if_not_exists=>true);
CREATE INDEX IF NOT EXISTS meadow_messages_org_time ON meadow_messages(org_id,created_at DESC);
CREATE INDEX IF NOT EXISTS meadow_presence_org_time ON meadow_presence_events(org_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS meadow_checkins_org_time ON meadow_checkins(org_id,checked_at DESC);
CREATE MATERIALIZED VIEW IF NOT EXISTS meadow_message_hourly
 WITH(timescaledb.continuous) AS
 SELECT org_id,time_bucket(INTERVAL '1 hour',created_at) AS bucket,count(*) AS message_count
 FROM meadow_messages WHERE org_id IS NOT NULL GROUP BY org_id,bucket WITH NO DATA;
CREATE MATERIALIZED VIEW IF NOT EXISTS meadow_presence_hourly
 WITH(timescaledb.continuous) AS
 SELECT org_id,time_bucket(INTERVAL '1 hour',observed_at) AS bucket,count(*) AS presence_count
 FROM meadow_presence_events GROUP BY org_id,bucket WITH NO DATA;
SELECT add_continuous_aggregate_policy('meadow_message_hourly',start_offset=>INTERVAL '30 days',end_offset=>INTERVAL '1 hour',schedule_interval=>INTERVAL '15 minutes',if_not_exists=>true);
SELECT add_continuous_aggregate_policy('meadow_presence_hourly',start_offset=>INTERVAL '30 days',end_offset=>INTERVAL '1 hour',schedule_interval=>INTERVAL '15 minutes',if_not_exists=>true);
-- Mutable busy slots remain rowstore. Archive tables compress after 30 days.
ALTER TABLE meadow_messages SET(timescaledb.enable_columnstore=true,timescaledb.segmentby='org_id',timescaledb.orderby='created_at DESC');
ALTER TABLE meadow_presence_events SET(timescaledb.enable_columnstore=true,timescaledb.segmentby='org_id',timescaledb.orderby='observed_at DESC');
ALTER TABLE meadow_checkins SET(timescaledb.enable_columnstore=true,timescaledb.segmentby='org_id',timescaledb.orderby='checked_at DESC');
CALL add_columnstore_policy('meadow_messages',after=>INTERVAL '30 days',if_not_exists=>true);
CALL add_columnstore_policy('meadow_presence_events',after=>INTERVAL '30 days',if_not_exists=>true);
CALL add_columnstore_policy('meadow_checkins',after=>INTERVAL '30 days',if_not_exists=>true);
