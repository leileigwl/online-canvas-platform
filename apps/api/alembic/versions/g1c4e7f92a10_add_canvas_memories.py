"""Add Harness canvas_memories and model max_context_tokens.

Revision ID: g1c4e7f92a10
Revises: f3a8c9d21b04
Create Date: 2026-11-11 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "g1c4e7f92a10"
down_revision: str | None = "f3a8c9d21b04"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    json_doc = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
    op.add_column(
        "model_configs",
        sa.Column("max_context_tokens", sa.Integer(), server_default="32768", nullable=False),
    )
    op.create_table(
        "canvas_memories",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("canvas_id", sa.Uuid(), nullable=False),
        sa.Column("compacted_summary", sa.Text(), nullable=False),
        sa.Column("compacted_run_count", sa.Integer(), nullable=False),
        sa.Column("last_compacted_run_id", sa.Uuid(), nullable=True),
        sa.Column("estimated_tokens", sa.Integer(), nullable=False),
        sa.Column("rejected_feedback", json_doc, nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["canvas_id"], ["canvases.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("canvas_id", name="uq_canvas_memory_canvas"),
    )
    op.create_index(op.f("ix_canvas_memories_canvas_id"), "canvas_memories", ["canvas_id"])
    op.create_index(op.f("ix_canvas_memories_owner_id"), "canvas_memories", ["owner_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_canvas_memories_owner_id"), table_name="canvas_memories")
    op.drop_index(op.f("ix_canvas_memories_canvas_id"), table_name="canvas_memories")
    op.drop_table("canvas_memories")
    op.drop_column("model_configs", "max_context_tokens")
