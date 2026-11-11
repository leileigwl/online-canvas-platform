from __future__ import annotations

import io
import json
import uuid
from pathlib import Path

import pytest
from canvas_api.config import Settings
from canvas_api.database import create_database
from canvas_api.main import create_app
from canvas_api.models import (
    AgentRun,
    AgentTask,
    Asset,
    Base,
    Canvas,
    ModelConfig,
    Project,
    RunEvent,
    RunStatus,
    User,
)
from canvas_api.providers.chat import ChatCompletionResult
from canvas_api.providers.images import GeneratedImage, ImageGenerationRequest
from canvas_api.security import encrypt_secret, hash_password
from canvas_api.storage import LocalObjectStorage
from httpx import ASGITransport, AsyncClient
from PIL import Image
from sqlalchemy import select

from canvas_worker.main import execute_agent_run


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), "#e4d8c8").save(buf, format="PNG")
    return buf.getvalue()


class _FakeChatProvider:
    async def complete_json(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        system: str,
        user: str,
        max_output_tokens: int = 2048,
        token_limit_field: str = "max_tokens",
    ) -> ChatCompletionResult:
        del base_url, api_key, model, max_output_tokens, token_limit_field
        if "Memory Compactor" in system:
            return ChatCompletionResult(
                content={"core_memory": "核心风格：暖象牙晨光；避开此前被回退的文案卡片布局。"},
                completion_tokens=60,
            )
        if "FlowCanvas Coordinator" in system:
            return ChatCompletionResult(
                content={
                    "summary": "延伸图1风格生成陶土静物场景并添加说明便签",
                    "thinking": "识别画布中存在参考图 img-ref-1，先编辑延伸再补说明卡。",
                    "subtasks": [
                        {
                            "id": "task-1",
                            "title": "生成场景延伸图与说明卡",
                            "goal": "基于 img-ref-1 生成延伸图并添加说明",
                            "depends_on": [],
                        }
                    ],
                },
                completion_tokens=120,
            )
        if "FlowCanvas Planner" in system:
            return ChatCompletionResult(
                content={
                    "thinking": "将新图放在 x=360，并补充暖晨光材质说明便签。",
                    "plans": [{"task_id": "task-1", "plan": "调用 edit_image 与 add_note"}],
                },
                completion_tokens=90,
            )
        if "FlowCanvas Canvas Editor" in system:
            parsed = json.loads(user)
            ref_id = parsed["canvas"][0]["id"]
            return ChatCompletionResult(
                content={
                    "thinking": "引用画布参考图生成延伸场景并生成说明卡。",
                    "operations": [
                        {
                            "tool": "edit_image",
                            "params": {
                                "prompt": "素陶底座晨光延伸场景",
                                "reference_object_ids": [ref_id],
                                "x": 360,
                                "y": -100,
                                "width": 240,
                                "height": 240,
                                "aspect_ratio": "1:1",
                            },
                        },
                        {
                            "tool": "add_note",
                            "params": {
                                "title": "光影方案说明",
                                "content": "延续晨间侧逆光与石灰岩暖调。",
                                "x": 360,
                                "y": 170,
                                "width": 240,
                                "height": 120,
                            },
                        },
                    ],
                },
                completion_tokens=180,
            )
        return ChatCompletionResult(
            content={
                "approved": True,
                "thinking": "所有操作均为白名单工具且引用有效画布对象。",
                "feedback": "通过审阅",
            },
            completion_tokens=40,
        )


class _FakeImgProvider:
    async def generate(self, request: ImageGenerationRequest) -> list[GeneratedImage]:
        assert len(request.reference_images) == 1
        return [GeneratedImage(content=_png_bytes(), mime_type="image/png", width=32, height=32)]

    async def edit(self, request: ImageGenerationRequest) -> list[GeneratedImage]:
        return await self.generate(request)


@pytest.mark.asyncio
async def test_worker_streams_thinking_tool_calls_and_applies_generated_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "worker_test.db"
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

    raw_png = _png_bytes()
    async with session_factory() as session:
        user = User(username="agent_tester", password_hash=hash_password("password123"))
        session.add(user)
        await session.flush()

        obj_key = f"{user.id}/ref.png"
        await storage.put(obj_key, raw_png, "image/png")
        asset = Asset(
            owner_id=user.id,
            name="香氛主图",
            object_key=obj_key,
            mime_type="image/png",
            size_bytes=len(raw_png),
            sha256="abc",
            width=32,
            height=32,
        )
        session.add(asset)
        session.add(
            ModelConfig(
                owner_id=user.id,
                provider="openai-compatible",
                base_url="https://api.example.com/v1",
                model_name="deepseek-chat",
                encrypted_api_key=encrypt_secret("sk-chat-key-123456", settings),
                role_models={},
            )
        )
        project = Project(owner_id=user.id, name="测试空间")
        session.add(project)
        await session.flush()

        canvas = Canvas(
            project_id=project.id,
            name="测试画布",
            document={
                "schema_version": 1,
                "items": [
                    {
                        "id": "img-ref-1",
                        "type": "image",
                        "x": 0,
                        "y": 0,
                        "width": 200,
                        "height": 200,
                        "title": "香氛主图",
                        "asset_id": str(asset.id),
                        "src": f"/api/assets/{asset.id}/content",
                        "visible": True,
                    }
                ],
            },
            viewport={"x": 0, "y": 0, "scale": 1},
            schema_version=1,
            revision=0,
        )
        session.add(canvas)
        await session.flush()

        run = AgentRun(
            owner_id=user.id,
            project_id=project.id,
            canvas_id=canvas.id,
            goal="延伸场景图并添加光影便签",
            reference_asset_ids=[str(asset.id)],
            context_revision=0,
            status=RunStatus.QUEUED,
        )
        session.add(run)
        await session.flush()
        session.add(
            AgentTask(
                run_id=run.id,
                role="Coordinator",
                sequence=0,
                task_key="coordinator",
                title="拆解创作目标",
                depends_on=[],
                status=RunStatus.QUEUED,
            )
        )
        await session.commit()
        run_id = run.id
        canvas_id = canvas.id

    monkeypatch.setattr("canvas_worker.main.OpenAICompatibleChatProvider", _FakeChatProvider)
    ctx = {
        "settings": settings,
        "session_factory": session_factory,
        "object_storage": storage,
        "image_provider": _FakeImgProvider(),
    }
    await execute_agent_run(ctx, str(run_id))

    async with session_factory() as session:
        done_run = await session.get(AgentRun, run_id)
        assert done_run is not None
        assert done_run.status == RunStatus.SUCCEEDED, f"error={done_run.error}"
        assert done_run.proposal is not None
        ops = done_run.proposal["operations"]
        assert ops[0]["tool"] == "edit_image"
        generated_asset_id = uuid.UUID(ops[0]["result"]["asset_id"])
        events = list(
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.sequence)
            )
        )
        event_types = [e.event_type for e in events]
        assert "thinking" in event_types
        assert "tool_call" in event_types
        assert "succeeded" in event_types
    await engine.dispose()

    # Now apply via API endpoint to verify end-to-end canvas write & ownership validation
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            login_res = await client.post(
                "/api/auth/login", json={"username": "agent_tester", "password": "password123"}
            )
            assert login_res.status_code == 200
            apply_res = await client.post(
                f"/api/agent/runs/{run_id}/apply", json={"base_revision": 0}
            )
            assert apply_res.status_code == 200
            applied_items = apply_res.json()["document"]["items"]
            assert apply_res.json()["id"] == str(canvas_id)
            assert len(applied_items) == 3
            assert any(
                it["type"] == "image" and it["asset_id"] == str(generated_asset_id)
                for it in applied_items
            )
            assert any(
                it["type"] == "note" and it["title"] == "光影方案说明" for it in applied_items
            )

            # User drags img-ref-1 to (50, 80), THEN clicks revert on THAT specific proposal:
            for item in applied_items:
                if item["id"] == "img-ref-1":
                    item["x"], item["y"] = 50, 80
            manual_save = await client.put(
                f"/api/canvases/{canvas_id}",
                json={
                    "base_revision": 1,
                    "document": {"schema_version": 1, "items": applied_items},
                    "viewport": {"x": 0, "y": 0, "scale": 1},
                },
            )
            assert manual_save.status_code == 200
            revert_res = await client.post(
                f"/api/agent/runs/{run_id}/revert", json={"base_revision": 2}
            )
            assert revert_res.status_code == 200
            reverted_items = revert_res.json()["document"]["items"]
            assert len(reverted_items) == 1
            assert reverted_items[0]["id"] == "img-ref-1"
            assert (reverted_items[0]["x"], reverted_items[0]["y"]) == (50, 80)

            mem_res = await client.get(f"/api/canvases/{canvas_id}/memory")
            assert mem_res.status_code == 200
            assert len(mem_res.json()["rejected_feedback"]) == 1

    # Seed 5 additional completed runs so uncompacted count reaches 6 -> triggers Harness compaction
    engine2, sf2 = create_database(settings)
    try:
        async with sf2() as session:
            c_obj = await session.get(Canvas, canvas_id)
            owner_uuid = await session.scalar(select(User.id))
            assert c_obj is not None and owner_uuid is not None
            for idx in range(5):
                session.add(
                    AgentRun(
                        owner_id=owner_uuid,
                        project_id=c_obj.project_id,
                        canvas_id=canvas_id,
                        goal=f"历史迭代 {idx}",
                        reference_asset_ids=[],
                        context_revision=c_obj.revision,
                        status=RunStatus.SUCCEEDED,
                        summary=f"完成第 {idx} 轮微调",
                        proposal={"operations": [], "applied": True},
                    )
                )
            next_run = AgentRun(
                owner_id=owner_uuid,
                project_id=c_obj.project_id,
                canvas_id=canvas_id,
                goal="基于记忆做新一轮构图",
                reference_asset_ids=[],
                context_revision=c_obj.revision,
                status=RunStatus.QUEUED,
            )
            session.add(next_run)
            await session.flush()
            session.add(
                AgentTask(
                    run_id=next_run.id,
                    role="Coordinator",
                    sequence=0,
                    task_key="coordinator",
                    title="拆解创作目标",
                    depends_on=[],
                    status=RunStatus.QUEUED,
                )
            )
            await session.commit()
            next_run_id = next_run.id

        await execute_agent_run(
            {
                "settings": settings,
                "session_factory": sf2,
                "object_storage": storage,
                "image_provider": _FakeImgProvider(),
            },
            str(next_run_id),
        )
        async with sf2() as session:
            evts = list(
                await session.scalars(
                    select(RunEvent)
                    .where(RunEvent.run_id == next_run_id)
                    .order_by(RunEvent.sequence)
                )
            )
            assert any(
                e.event_type == "thinking" and e.data.get("role") == "Harness Memory" for e in evts
            )
    finally:
        await engine2.dispose()
