"""Add pinned_user_values to agent_sessions and canvas_memories.

Revision ID: n6c9e2f5d8b0
Revises: m5b8e1d4c7a9
Create Date: 2026-11-13 11:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "n6c9e2f5d8b0"
down_revision = "m5b8e1d4c7a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    json_type = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
    op.add_column(
        "agent_sessions",
        sa.Column("pinned_user_values", json_type, nullable=False, server_default="[]"),
    )
    op.add_column(
        "canvas_memories",
        sa.Column("pinned_user_values", json_type, nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("canvas_memories", "pinned_user_values")
    op.drop_column("agent_sessions", "pinned_user_values")
