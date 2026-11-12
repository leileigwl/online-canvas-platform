"""Add independent agent_sessions table and agent_runs.session_id foreign key.

Revision ID: m5b8e1d4c7a9
Revises: k4a7c9e1f2b3
Create Date: 2026-11-12 22:38:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "m5b8e1d4c7a9"
down_revision = "k4a7c9e1f2b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    json_type = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
    op.create_table(
        "agent_sessions",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("owner_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("canvas_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False, server_default="主对话 Agent"),
        sa.Column("compacted_summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("compacted_run_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_compacted_run_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("estimated_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rejected_feedback", json_type, nullable=False, server_default="[]"),
        sa.Column("chat_cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["canvas_id"], ["canvases.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_sessions_owner_id", "agent_sessions", ["owner_id"])
    op.create_index("ix_agent_sessions_canvas_id", "agent_sessions", ["canvas_id"])

    op.add_column("agent_runs", sa.Column("session_id", sa.Uuid(as_uuid=True), nullable=True))
    op.create_index("ix_agent_runs_session_id", "agent_runs", ["session_id"])
    op.create_foreign_key(
        "fk_agent_runs_session_id",
        "agent_runs",
        "agent_sessions",
        ["session_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("fk_agent_runs_session_id", "agent_runs", type_="foreignkey")
    op.drop_index("ix_agent_runs_session_id", table_name="agent_runs")
    op.drop_column("agent_runs", "session_id")
    op.drop_index("ix_agent_sessions_canvas_id", table_name="agent_sessions")
    op.drop_index("ix_agent_sessions_owner_id", table_name="agent_sessions")
    op.drop_table("agent_sessions")
