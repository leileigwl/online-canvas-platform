"""Allow multiple BYOK image_model_configs per user with label and is_default.

Revision ID: h2d9e1a4b5c6
Revises: g1c4e7f92a10
Create Date: 2026-11-11 23:50:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "h2d9e1a4b5c6"
down_revision: str | None = "g1c4e7f92a10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("image_model_configs") as batch_op:
        batch_op.drop_constraint("uq_image_model_config_owner", type_="unique")
        batch_op.add_column(
            sa.Column("label", sa.String(length=80), server_default="", nullable=False)
        )
        batch_op.add_column(
            sa.Column("is_default", sa.Boolean(), server_default=sa.true(), nullable=False)
        )


def downgrade() -> None:
    with op.batch_alter_table("image_model_configs") as batch_op:
        batch_op.drop_column("is_default")
        batch_op.drop_column("label")
        batch_op.create_unique_constraint("uq_image_model_config_owner", ["owner_id"])
