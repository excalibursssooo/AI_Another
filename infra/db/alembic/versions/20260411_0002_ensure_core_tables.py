from __future__ import annotations

from alembic import op


revision = "20260411_0002"
down_revision = "20260411_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS memory_item (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            agent_id TEXT NOT NULL DEFAULT 'default',
            domain_id TEXT NOT NULL DEFAULT 'default',
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
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS conversation_turn (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS feed_post (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            content TEXT NOT NULL,
            topic_seed TEXT NOT NULL,
            post_type TEXT NOT NULL,
            status TEXT NOT NULL,
            source_task_id TEXT,
            created_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS task_item (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            priority TEXT NOT NULL,
            deadline TEXT,
            subtasks_json TEXT NOT NULL DEFAULT '[]',
            source_message TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS domain_config (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            lore TEXT NOT NULL,
            tone TEXT NOT NULL,
            constraints_json TEXT NOT NULL DEFAULT '[]',
            seed_memories_json TEXT NOT NULL DEFAULT '[]',
            updated_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_log (
            id BIGSERIAL PRIMARY KEY,
            ts TIMESTAMPTZ NOT NULL,
            event TEXT NOT NULL,
            payload_json TEXT NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_profile (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            persona TEXT NOT NULL,
            background TEXT NOT NULL,
            domain_id TEXT NOT NULL DEFAULT 'default',
            world_context TEXT NOT NULL DEFAULT '',
            greeting TEXT NOT NULL DEFAULT '',
            hobbies_json TEXT NOT NULL DEFAULT '[]',
            speaking_style TEXT NOT NULL DEFAULT 'warm',
            status TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
        """
    )

    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_user_created ON memory_item (user_id, agent_id, domain_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversation_user ON conversation_turn (user_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_feed_post_user ON feed_post (user_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_item_user_created ON task_item (user_id, created_at DESC)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (ts DESC)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_profile_domain_status_updated ON agent_profile (domain_id, status, updated_at DESC)"
    )


def downgrade() -> None:
    # Keep downgrade non-destructive because this migration acts as an idempotent schema guard.
    pass
