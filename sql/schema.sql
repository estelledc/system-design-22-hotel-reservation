CREATE TABLE IF NOT EXISTS properties (
  property_id text PRIMARY KEY,
  timezone text NOT NULL,
  intent_digest text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  creation_result jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_days (
  property_id text NOT NULL REFERENCES properties(property_id),
  room_type_id text NOT NULL,
  stay_date date NOT NULL CHECK (stay_date >= DATE '2020-01-01' AND stay_date < DATE '2100-01-01'),
  capacity integer NOT NULL CHECK (capacity >= 0 AND capacity <= 10000),
  oversell_units integer NOT NULL CHECK (oversell_units >= 0 AND oversell_units <= 1000),
  blocked_units integer NOT NULL CHECK (blocked_units >= 0),
  held_units integer NOT NULL DEFAULT 0 CHECK (held_units >= 0),
  booked_units integer NOT NULL DEFAULT 0 CHECK (booked_units >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (property_id, room_type_id, stay_date),
  CONSTRAINT inventory_conservation CHECK (
    held_units + booked_units + blocked_units <= capacity + oversell_units
  )
);

CREATE TABLE IF NOT EXISTS availability_queries (
  query_id uuid PRIMARY KEY,
  principal text NOT NULL,
  intent_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE IF NOT EXISTS holds (
  hold_id uuid PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(property_id),
  room_type_id text NOT NULL,
  check_in_date date NOT NULL,
  check_out_date date NOT NULL,
  units integer NOT NULL CHECK (units BETWEEN 1 AND 5),
  lease_seconds integer NOT NULL CHECK (lease_seconds BETWEEN 1 AND 300),
  intent_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'converted', 'expired')),
  revision bigint NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  creation_result jsonb NOT NULL,
  CHECK (check_out_date > check_in_date)
);

CREATE TABLE IF NOT EXISTS hold_nights (
  hold_id uuid NOT NULL REFERENCES holds(hold_id) ON DELETE RESTRICT,
  property_id text NOT NULL,
  room_type_id text NOT NULL,
  stay_date date NOT NULL,
  units integer NOT NULL CHECK (units BETWEEN 1 AND 5),
  PRIMARY KEY (hold_id, stay_date),
  FOREIGN KEY (property_id, room_type_id, stay_date)
    REFERENCES inventory_days(property_id, room_type_id, stay_date)
);

CREATE TABLE IF NOT EXISTS bookings (
  booking_id uuid PRIMARY KEY,
  hold_id uuid NOT NULL UNIQUE REFERENCES holds(hold_id),
  property_id text NOT NULL REFERENCES properties(property_id),
  room_type_id text NOT NULL,
  check_in_date date NOT NULL,
  check_out_date date NOT NULL,
  units integer NOT NULL CHECK (units BETWEEN 1 AND 5),
  intent_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('confirmed', 'cancelled')),
  revision bigint NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  creation_result jsonb NOT NULL,
  CHECK (check_out_date > check_in_date)
);

CREATE TABLE IF NOT EXISTS booking_nights (
  booking_id uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE RESTRICT,
  property_id text NOT NULL,
  room_type_id text NOT NULL,
  stay_date date NOT NULL,
  units integer NOT NULL CHECK (units BETWEEN 1 AND 5),
  PRIMARY KEY (booking_id, stay_date),
  FOREIGN KEY (property_id, room_type_id, stay_date)
    REFERENCES inventory_days(property_id, room_type_id, stay_date)
);

CREATE TABLE IF NOT EXISTS expiry_assignments (
  shard_id integer PRIMARY KEY CHECK (shard_id = 0),
  worker_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE IF NOT EXISTS mutation_receipts (
  principal text NOT NULL,
  request_key text NOT NULL,
  operation text NOT NULL,
  intent_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, request_key, operation)
);

CREATE INDEX IF NOT EXISTS holds_expiry_index ON holds (expires_at, hold_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS bookings_property_index ON bookings (property_id, created_at, booking_id);
