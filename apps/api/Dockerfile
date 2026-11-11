FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.10.11 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/apps/api:/app/apps/worker

WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker

RUN uv sync --frozen --no-dev --all-packages

EXPOSE 8000
