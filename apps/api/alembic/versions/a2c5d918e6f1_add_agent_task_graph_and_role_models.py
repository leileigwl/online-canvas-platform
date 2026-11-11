"""persist role model mappings and agent task dependencies

Revision ID: a2c5d918e6f1
Revises: 41acb5925e7b
Create Date: 2026-10-31 00:45:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a2c5d918e6f1"
down_revision: str | None = "41acb5925e7b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

json_document = sa.JSON().with_variant(
    postgresql.JSONB(astext_type=sa.Text()), "postgresql"
)


def upgrade() -> None:
    op.add_column(
        "model_configs",
        sa.Column("role_models", json_document, nullable=False, server_default=sa.text("'{}'")),
    )

    op.add_column("agent_tasks", sa.Column("task_key", sa.String(length=48), nullable=True))
    op.add_column("agent_tasks", sa.Column("title", sa.String(length=160), nullable=True))
    op.add_column(
        "agent_tasks",
        sa.Column("depends_on", json_document, nullable=False, server_default=sa.text("'[]'")),
    )
    op.execute(
        "UPDATE agent_tasks SET task_key = 'legacy-' || CAST(sequence AS VARCHAR) "
        "WHERE task_key IS NULL"
    )
    op.execute("UPDATE agent_tasks SET title = role WHERE title IS NULL")
    with op.batch_alter_table("agent_tasks") as batch_op:
        batch_op.alter_column("task_key", nullable=False)
        batch_op.alter_column("title", nullable=False)
        batch_op.create_unique_constraint("uq_agent_task_key", ["run_id", "task_key"])
        batch_op.create_unique_constraint("uq_agent_task_sequence", ["run_id", "sequence"])


def downgrade() -> None:
    with op.batch_alter_table("agent_tasks") as batch_op:
        batch_op.drop_constraint("uq_agent_task_sequence", type_="unique")
        batch_op.drop_constraint("uq_agent_task_key", type_="unique")
        batch_op.drop_column("depends_on")
        batch_op.drop_column("title")
        batch_op.drop_column("task_key")
    op.drop_column("model_configs", "role_models")
