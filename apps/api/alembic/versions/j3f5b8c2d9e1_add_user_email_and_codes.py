"""Add email/email_verified on users and email_verification_codes table.

Revision ID: j3f5b8c2d9e1
Revises: h2d9e1a4b5c6
Create Date: 2026-11-12 09:50:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "j3f5b8c2d9e1"
down_revision: str | None = "h2d9e1a4b5c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("email", sa.String(length=255), nullable=True))
        batch_op.add_column(
            sa.Column("email_verified", sa.Boolean(), server_default=sa.false(), nullable=False)
        )
        batch_op.create_unique_constraint("uq_users_email", ["email"])
    op.create_index(op.f("ix_users_email"), "users", ["email"], unique=True)

    op.create_table(
        "email_verification_codes",
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_email_verification_codes_email"),
        "email_verification_codes",
        ["email"],
        unique=False,
    )
    op.create_index(
        op.f("ix_email_verification_codes_purpose"),
        "email_verification_codes",
        ["purpose"],
        unique=False,
    )
    op.create_index(
        op.f("ix_email_verification_codes_expires_at"),
        "email_verification_codes",
        ["expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_email_verification_codes_expires_at"),
        table_name="email_verification_codes",
    )
    op.drop_index(
        op.f("ix_email_verification_codes_purpose"),
        table_name="email_verification_codes",
    )
    op.drop_index(
        op.f("ix_email_verification_codes_email"),
        table_name="email_verification_codes",
    )
    op.drop_table("email_verification_codes")
    op.drop_index(op.f("ix_users_email"), table_name="users")
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_constraint("uq_users_email", type_="unique")
        batch_op.drop_column("email_verified")
        batch_op.drop_column("email")
