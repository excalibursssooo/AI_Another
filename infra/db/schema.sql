CREATE TABLE IF NOT EXISTS memory_item (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT 'default',
    subject TEXT NOT NULL DEFAULT 'user',
    memory_type TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    importance DOUBLE PRECISION NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    conflict_state TEXT NOT NULL DEFAULT 'none',
    created_at TIMESTAMPTZ NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ
);

ALTER TABLE memory_item
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE memory_item
ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE memory_item
ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT 'user';

ALTER TABLE memory_item
ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE memory_item
ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

ALTER TABLE memory_item
ADD COLUMN IF NOT EXISTS conflict_state TEXT NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS idx_memory_user_created
ON memory_item (user_id, agent_id, created_at DESC);
