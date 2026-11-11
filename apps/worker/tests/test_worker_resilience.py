from __future__ import annotations

import io
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from canvas_api.config import Settings
from canvas_api.database import create_database
from canvas_api.models import (
    AgentRun,
    AgentTask,
    Base,
    Canvas,
    ImageModelConfig,
    Project,
    RunStatus,
    User,
)
from canvas_api.providers.images import GeneratedImage, ImageGenerationRequest
from canvas_api.security import encrypt_secret, hash_password
from canvas_api.storage import LocalObjectStorage
from PIL import Image
from sqlalchemy import select

from canvas_worker import checkpoints
from canvas_worker.main import (
    MAX_AGENT_RUN_ATTEMPTS,
    _execute_generation_run,
    after_job_end,
    reconcile_abandoned_agent_runs,
)


def _sample_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (24, 24), "#c9b39c").save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_checkpointer_runs_setup_once_per_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    class _DummySaver:
        async def setup(self) -> None:
            nonlocal calls
            calls += 1

    class _DummyCtx:
        async def __aenter__(self):
            return _DummySaver()

        async def __aexit__(self, *args):
            return None

    import langgraph.checkpoint.sqlite.aio as lg_sqlite

    monkeypatch.setattr(lg_sqlite.AsyncSqliteSaver, "from_conn_string", lambda _s: _DummyCtx())
    checkpoints._SETUP_READY.clear()

    settings = Settings(
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'cp.db'}",
    )
    async with checkpoints.open_checkpointer(settings):
        pass
    async with checkpoints.open_checkpointer(settings):
        pass
    assert calls == 1


@pytest.mark.asyncio
async def test_worker_generation_routes_selected_image_model_and_recovers_abandoned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "worker_resilience.db"
    settings = Settings(
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{db_path}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
    )
    engine, session_factory = create_database(settings)
    storage = LocalObjectStorage(settings.asset_local_path)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    seen: list[tuple[str, int]] = []

    class _SpyProvider:
        def __init__(self, *, provider: str, base_url: str, api_key: str, default_model: str):
            self.provider = provider
            self.default_model = default_model

        async def generate(self, req: ImageGenerationRequest) -> list[GeneratedImage]:
            seen.append((self.provider, req.max_image_bytes))
            return [
                GeneratedImage(content=_sample_png(), mime_type="image/png", width=24, height=24)
            ]

    monkeypatch.setattr("canvas_api.image_assets.ConfiguredImageProvider", _SpyProvider)

    async with session_factory() as session:
        user = User(username="worker_res_user", password_hash=hash_password("password123"))
        session.add(user)
        await session.flush()
        # Default config is dashscope, secondary config is google-gemini
        session.add(
            ImageModelConfig(
                owner_id=user.id,
                label="Default DashScope",
                provider="dashscope",
                base_url="https://dashscope.aliyuncs.com/api/v1",
                model_name="qwen-image-2.0",
                encrypted_api_key=encrypt_secret("sk-dash-1", settings),
                is_default=True,
            )
        )
        session.add(
            ImageModelConfig(
                owner_id=user.id,
                label="Gemini Nano",
                provider="google-gemini",
                base_url="https://generativelanguage.googleapis.com/v1beta",
                model_name="gemini-2.5-flash-image",
                encrypted_api_key=encrypt_secret("AIza-gem-2", settings),
                is_default=False,
            )
        )
        proj = Project(owner_id=user.id, name="P")
        session.add(proj)
        await session.flush()
        canvas = Canvas(
            project_id=proj.id,
            name="C",
            document={"schema_version": 1, "items": []},
            viewport={"x": 0, "y": 0, "scale": 1},
            schema_version=1,
            revision=0,
        )
        session.add(canvas)
        await session.flush()
        gen_run = AgentRun(
            owner_id=user.id,
            project_id=proj.id,
            canvas_id=canvas.id,
            goal="Nano Banana test",
            reference_asset_ids=[],
            generation_settings={
                "model": "gemini-2.5-flash-image",
                "quality": "auto",
                "width": 1024,
                "height": 1024,
                "align_to_16": True,
                "resolution": "auto",
                "aspect_ratio": "1:1",
                "transparent": False,
                "count": 1,
            },
            context_revision=0,
            status=RunStatus.RUNNING,
        )
        abandoned_run = AgentRun(
            owner_id=user.id,
            project_id=proj.id,
            canvas_id=canvas.id,
            goal="Abandoned queued run",
            reference_asset_ids=[],
            context_revision=0,
            status=RunStatus.QUEUED,
            created_at=datetime.now(UTC) - timedelta(minutes=10),
        )
        end_run = AgentRun(
            owner_id=user.id,
            project_id=proj.id,
            canvas_id=canvas.id,
            goal="Retry exhausted run",
            reference_asset_ids=[],
            context_revision=0,
            status=RunStatus.RUNNING,
        )
        session.add_all([gen_run, abandoned_run, end_run])
        await session.flush()
        session.add_all(
            [
                AgentTask(
                    run_id=gen_run.id,
                    role="Image Creator",
                    sequence=0,
                    task_key="image_creator",
                    title="生成图片",
                    depends_on=[],
                    status=RunStatus.QUEUED,
                ),
                AgentTask(
                    run_id=abandoned_run.id,
                    role="Coordinator",
                    sequence=0,
                    task_key="coordinator",
                    title="拆解",
                    depends_on=[],
                    status=RunStatus.QUEUED,
                ),
                AgentTask(
                    run_id=end_run.id,
                    role="Coordinator",
                    sequence=0,
                    task_key="coordinator",
                    title="拆解",
                    depends_on=[],
                    status=RunStatus.RUNNING,
                ),
            ]
        )
        await session.commit()
        owner_id, gen_id, abandoned_id, end_id = user.id, gen_run.id, abandoned_run.id, end_run.id

    ctx = {"settings": settings, "session_factory": session_factory, "object_storage": storage}
    await _execute_generation_run(
        ctx,
        gen_id,
        owner_id,
        "Nano Banana test",
        [],
        {
            "model": "gemini-2.5-flash-image",
            "quality": "auto",
            "width": 1024,
            "height": 1024,
            "align_to_16": True,
            "resolution": "auto",
            "aspect_ratio": "1:1",
            "transparent": False,
            "count": 1,
        },
        settings.max_upload_bytes,
    )
    assert seen == [("google-gemini", settings.max_upload_bytes)]

    # Verify after_job_end fails run at MAX_AGENT_RUN_ATTEMPTS
    await after_job_end(
        {
            "job_try": MAX_AGENT_RUN_ATTEMPTS,
            "job_id": f"agent-run:{end_id}",
            "session_factory": session_factory,
        }
    )

    # Verify reconcile_abandoned_agent_runs fails old queued run absent from Redis
    class _EmptyRedis:
        async def zscore(self, *_a):
            return None

        async def exists(self, *_a):
            return 0

    await reconcile_abandoned_agent_runs(
        {"session_factory": session_factory, "redis": _EmptyRedis()}
    )

    async with session_factory() as session:
        g_done = await session.get(AgentRun, gen_id)
        e_done = await session.get(AgentRun, end_id)
        a_done = await session.get(AgentRun, abandoned_id)
        assert g_done and g_done.status == RunStatus.SUCCEEDED
        assert e_done and e_done.status == RunStatus.FAILED
        assert a_done and a_done.status == RunStatus.FAILED
        assert (
            await session.scalar(select(AgentTask.status).where(AgentTask.run_id == gen_id))
            == RunStatus.SUCCEEDED
        )
    await engine.dispose()
