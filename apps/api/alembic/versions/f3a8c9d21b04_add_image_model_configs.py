"""Add BYOK image_model_configs table.

Revision ID: f3a8c9d21b04
Revises: e814b0279ac4
Create Date: 2026-11-11 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f3a8c9d21b04"
down_revision: str | None = "e814b0279ac4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    json_doc = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
    op.create_table(
        "image_model_configs",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=48), nullable=False),
        sa.Column("base_url", sa.String(length=500), nullable=False),
        sa.Column("model_name", sa.String(length=160), nullable=False),
        sa.Column("encrypted_api_key", sa.Text(), nullable=False),
        sa.Column("default_options", json_doc, nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", name="uq_image_model_config_owner"),
    )
    op.create_index(
        op.f("ix_image_model_configs_owner_id"), "image_model_configs", ["owner_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_image_model_configs_owner_id"), table_name="image_model_configs")
    op.drop_table("image_model_configs")
