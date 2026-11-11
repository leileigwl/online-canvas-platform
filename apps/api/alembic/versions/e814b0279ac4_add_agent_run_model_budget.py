"""Persist per-run chat model call and output token budgets.

Revision ID: e814b0279ac4
Revises: d7e4c1b9a6f2
Create Date: 2026-10-31 00:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e814b0279ac4"
down_revision: str | None = "d7e4c1b9a6f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column("model_calls_used", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "agent_runs",
        sa.Column("model_call_budget", sa.Integer(), server_default="12", nullable=False),
    )
    op.add_column(
        "agent_runs",
        sa.Column("completion_tokens_used", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "agent_runs",
        sa.Column("completion_usage_reports", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "agent_runs",
        sa.Column("completion_tokens_per_call", sa.Integer(), server_default="2048", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("agent_runs", "completion_tokens_per_call")
    op.drop_column("agent_runs", "completion_usage_reports")
    op.drop_column("agent_runs", "completion_tokens_used")
    op.drop_column("agent_runs", "model_call_budget")
    op.drop_column("agent_runs", "model_calls_used")
