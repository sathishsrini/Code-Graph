-- ============================================================================
-- Fixture for CTX-S9 (tests/ddl.test.ts). Mirrors the shape of the corpus
-- file 41-kri-engine/migrations/001_init.sql: raw Postgres DDL, no ORM. It is
-- NOT that file; the corpus is not in this repository.
--
-- It carries what the extractor must not mistake for columns (table-level
-- constraints), an ALTER TABLE ADD COLUMN, two statements it must skip without
-- a gap (CREATE EXTENSION, CREATE INDEX), and one it cannot parse
-- (CREATE TABLE ... AS), which must be stored as a gap. This comment holds a
-- semicolon; it must not split a statement.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id SERIAL,
    po_number VARCHAR(64) NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_po_number UNIQUE (po_number),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE purchase_orders ADD COLUMN approved_by INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS mail_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(64) NOT NULL,
    payload JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_user ON purchase_orders(user_id);

CREATE TABLE po_archive AS SELECT * FROM purchase_orders WHERE status = 'closed';
