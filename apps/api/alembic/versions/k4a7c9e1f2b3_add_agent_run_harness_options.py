"""Add harness_options on agent_runs for Agent Lab and repair loop configuration.

Revision ID: k4a7c9e1f2b3
Revises: j3f5b8c2d9e1
Create Date: 2026-11-12 16:15:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "k4a7c9e1f2b3"
down_revision = "j3f5b8c2d9e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    json_type = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
    op.add_column("agent_runs", sa.Column("harness_options", json_type, nullable=True))


def downgrade() -> None:
    op.drop_column("agent_runs", "harness_options")
