"""persist generation settings on agent runs and temporary asset state

Revision ID: c9b5d143a2e7
Revises: a2c5d918e6f1
Create Date: 2026-10-31 00:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c9b5d143a2e7"
down_revision: str | None = "a2c5d918e6f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    json_document = sa.JSON().with_variant(
        postgresql.JSONB(astext_type=sa.Text()), "postgresql"
    )
    op.add_column(
        "agent_runs", sa.Column("generation_settings", json_document, nullable=True)
    )
    op.add_column(
        "assets",
        sa.Column("temporary", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_assets_temporary", "assets", ["temporary"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_assets_temporary", table_name="assets")
    op.drop_column("assets", "temporary")
    op.drop_column("agent_runs", "generation_settings")
