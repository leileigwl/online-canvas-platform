from __future__ import annotations

import uuid
from pathlib import Path

import httpx
import pytest
from canvas_api.config import Settings
from canvas_api.main import create_app
from canvas_api.models import (
    AgentRun,
    AgentSession,
    AgentTask,
    Canvas,
    Project,
    RunEvent,
    RunStatus,
    User,
)
from canvas_api.security import hash_password, reset_rate_limits
from canvas_api.storage import create_storage
from sqlalchemy import select

from canvas_worker.main import execute_agent_run


@pytest.fixture(autouse=True)
def _reset_limits():
    reset_rate_limits()
    yield
    reset_rate_limits()


@pytest.mark.asyncio
async def test_autonomous_loop_compaction_clear_chat_and_isolated_agent_sessions(
    tmp_path: Path,
) -> None:
    settings = Settings(
        _env_file=None,
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'autonomous_loop.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
        max_agent_model_calls_per_run=20,
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as db:
            user = User(username="auto_user", password_hash=hash_password("password123"))
            db.add(user)
            await db.flush()
            project = Project(owner_id=user.id, name="Autonomous Studio")
            db.add(project)
            await db.flush()
            canvas = Canvas(
                project_id=project.id,
                name="自主循环测试画布",
                document={"schema_version": 1, "items": []},
                viewport={"x": 0, "y": 0, "scale": 1},
                schema_version=1,
                revision=0,
            )
            db.add(canvas)
            await db.commit()
            user_id = user.id
            project_id = project.id
            canvas_id = canvas.id

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            assert (
                await client.post(
                    "/api/auth/login",
                    json={"identifier": "auto_user", "password": "password123"},
                )
            ).status_code == 200

            # 1. Bootstrap default independent Agent #1
            sessions_res = await client.get(f"/api/canvases/{canvas_id}/agent-sessions")
            assert sessions_res.status_code == 200
            session_1_id = uuid.UUID(sessions_res.json()[0]["id"])

            # 2. Run autonomous collision -> self-repair loop in Agent #1
            async with app.state.session_factory() as db:
                run1 = AgentRun(
                    owner_id=user_id,
                    project_id=project_id,
                    canvas_id=canvas_id,
                    session_id=session_1_id,
                    goal="生成陶土极简香氛视觉并自修复碰撞",
                    reference_asset_ids=[],
                    harness_options={
                        "llm_mode": "scripted",
                        "loop_mode": "autonomous",
                        "use_mock_image": True,
                        "lab_scenario": "collision_repair",
                        "max_repair_rounds": 2,
                        "max_loop_steps": 10,
                    },
                    context_revision=0,
                    model_call_budget=20,
                    completion_tokens_per_call=2048,
                    status=RunStatus.QUEUED,
                )
                db.add(run1)
                await db.flush()
                db.add(
                    AgentTask(
                        run_id=run1.id,
                        role="Lead Agent",
                        sequence=0,
                        task_key="lead_agent",
                        title="理解对话并自主循环",
                        depends_on=[],
                        status=RunStatus.QUEUED,
                    )
                )
                await db.commit()
                run1_id = str(run1.id)

            ctx = {
                "settings": settings,
                "session_factory": app.state.session_factory,
                "object_storage": create_storage(settings),
            }
            await execute_agent_run(ctx, run1_id)

            async with app.state.session_factory() as db:
                done_run1 = await db.get(AgentRun, uuid.UUID(run1_id))
                assert done_run1 is not None and done_run1.status == RunStatus.SUCCEEDED
                prop1 = done_run1.proposal or {}
                assert prop1["verifier"]["passed"] is True
                assert len(prop1["repair_history"]) == 2
                assert prop1["repair_history"][0]["verifier_passed"] is False
                assert prop1["repair_history"][1]["verifier_passed"] is True
                assert prop1["reply"]
                assert len(prop1["steps"]) >= 3

            # 3. Second run triggers IN-LOOP auto-compaction & writes to Cloud AgentSession
            async with app.state.session_factory() as db:
                run2 = AgentRun(
                    owner_id=user_id,
                    project_id=project_id,
                    canvas_id=canvas_id,
                    session_id=session_1_id,
                    goal="在上下文超阈值时自动蒸馏云端记忆并新增材质卡片",
                    reference_asset_ids=[],
                    harness_options={
                        "llm_mode": "scripted",
                        "loop_mode": "autonomous",
                        "use_mock_image": True,
                        "lab_scenario": "memory_compaction",
                        "compaction_threshold_pct": 5,
                        "max_loop_steps": 10,
                    },
                    context_revision=0,
                    model_call_budget=20,
                    completion_tokens_per_call=2048,
                    status=RunStatus.QUEUED,
                )
                db.add(run2)
                await db.flush()
                db.add(
                    AgentTask(
                        run_id=run2.id,
                        role="Lead Agent",
                        sequence=0,
                        task_key="lead_agent",
                        title="理解对话并自主循环",
                        depends_on=[],
                        status=RunStatus.QUEUED,
                    )
                )
                await db.commit()
                run2_id = str(run2.id)

            await execute_agent_run(ctx, run2_id)

            async with app.state.session_factory() as db:
                done_run2 = await db.get(AgentRun, uuid.UUID(run2_id))
                assert done_run2 is not None and done_run2.status == RunStatus.SUCCEEDED
                assert (done_run2.proposal or {}).get("compaction_count", 0) >= 1
                evts = list(
                    await db.scalars(
                        select(RunEvent)
                        .where(RunEvent.run_id == uuid.UUID(run2_id))
                        .order_by(RunEvent.sequence)
                    )
                )
                assert any(
                    e.event_type == "context" and e.data.get("compacted") is True for e in evts
                )
                sess1 = await db.get(AgentSession, session_1_id)
                assert sess1 is not None and sess1.compacted_summary
                assert isinstance(sess1.pinned_user_values, list)
                assert len(sess1.pinned_user_values) >= 1

            # 4. Clear chat on Agent #1 -> visible chat turns empty, Cloud Core Memory RETAINED
            clear_res = await client.post(
                f"/api/agent-sessions/{session_1_id}/clear-chat",
                json={"preserve_cloud_memory": True, "llm_mode": "scripted"},
            )
            assert clear_res.status_code == 200
            assert clear_res.json()["compacted_summary"] != ""
            assert clear_res.json()["chat_cleared_at"] is not None
            assert len(clear_res.json()["pinned_user_values"]) >= 1

            visible_runs = await client.get(
                f"/api/agent/runs?canvas_id={canvas_id}&session_id={session_1_id}"
            )
            assert visible_runs.status_code == 200
            assert len(visible_runs.json()) == 0

            # 5. Create brand-new independent Agent #2 -> completely empty memory & isolated chat
            new_agent_res = await client.post(
                f"/api/canvases/{canvas_id}/agent-sessions",
                json={"title": "全新视觉实验 Agent"},
            )
            assert new_agent_res.status_code == 201
            session_2 = new_agent_res.json()
            assert session_2["id"] != str(session_1_id)
            assert session_2["compacted_summary"] == ""
            assert session_2["compacted_run_count"] == 0
            assert session_2["pinned_user_values"] == []

            # Agent #1 still holds its cloud memory intact
            insp1 = await client.post(
                f"/api/canvases/{canvas_id}/harness/inspect",
                json={"operations": [], "session_id": str(session_1_id)},
            )
            assert insp1.status_code == 200
            assert insp1.json()["memory"]["compacted_summary"] != ""
            assert len(insp1.json()["memory"]["pinned_user_values"]) >= 1


@pytest.mark.asyncio
async def test_tiered_context_pinned_values_and_scratchpad_pruning(tmp_path: Path) -> None:
    settings = Settings(
        _env_file=None,
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'tiered_context.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
        max_agent_model_calls_per_run=20,
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as db:
            user = User(username="tiered_user", password_hash=hash_password("pwd123"))
            db.add(user)
            await db.flush()
            project = Project(owner_id=user.id, name="MRI Lab")
            db.add(project)
            await db.flush()
            canvas = Canvas(
                project_id=project.id,
                name="专员情报与分层上下文画布",
                document={"schema_version": 1, "items": []},
                viewport={"x": 0, "y": 0, "scale": 1},
                schema_version=1,
                revision=0,
            )
            db.add(canvas)
            await db.commit()
            user_id = user.id
            project_id = project.id
            canvas_id = canvas.id

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(
                "/api/auth/login",
                json={"identifier": "tiered_user", "password": "pwd123"},
            )
            sessions_res = await client.get(f"/api/canvases/{canvas_id}/agent-sessions")
            session_id = uuid.UUID(sessions_res.json()[0]["id"])

            ctx = {
                "settings": settings,
                "session_factory": app.state.session_factory,
                "object_storage": create_storage(settings),
            }

            # Run 1: user inputs domain opinions and strict aspect ratio
            async with app.state.session_factory() as db:
                run1 = AgentRun(
                    owner_id=user_id,
                    project_id=project_id,
                    canvas_id=canvas_id,
                    session_id=session_id,
                    goal="核磁共振专员要求：对比度增强，色调偏冷灰，比例保持 16:9",
                    reference_asset_ids=[],
                    harness_options={
                        "llm_mode": "scripted",
                        "loop_mode": "autonomous",
                        "use_mock_image": True,
                        "lab_scenario": "memory_compaction",
                        "compaction_threshold_pct": 85,
                        "max_loop_steps": 10,
                    },
                    context_revision=0,
                    model_call_budget=20,
                    completion_tokens_per_call=2048,
                    status=RunStatus.QUEUED,
                )
                db.add(run1)
                await db.flush()
                db.add(
                    AgentTask(
                        run_id=run1.id,
                        role="Lead Agent",
                        sequence=0,
                        task_key="lead_agent",
                        title="专员参数闭环测试",
                        depends_on=[],
                        status=RunStatus.QUEUED,
                    )
                )
                await db.commit()
                run1_id = str(run1.id)

            await execute_agent_run(ctx, run1_id)

            async with app.state.session_factory() as db:
                sess_row = await db.get(AgentSession, session_id)
                assert sess_row is not None
                assert isinstance(sess_row.pinned_user_values, list)
                # Verify that pinned parameters were extracted and preserved
                assert any("16:9" in str(p) for p in sess_row.pinned_user_values)
                assert any("专员情报" in str(p) for p in sess_row.pinned_user_values)
                assert sess_row.compacted_summary != ""


@pytest.mark.asyncio
async def test_progressive_multi_run_85pct_compaction_and_mflux_engine(
    tmp_path: Path,
) -> None:
    settings = Settings(
        _env_file=None,
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'mflux_progressive.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
        max_agent_model_calls_per_run=25,
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as db:
            user = User(username="flux_tester", password_hash=hash_password("pwd123"))
            db.add(user)
            await db.flush()
            project = Project(owner_id=user.id, name="Flux Lab")
            db.add(project)
            await db.flush()
            canvas = Canvas(
                project_id=project.id,
                name="Flux 2 渐进式压测画布",
                document={"schema_version": 1, "items": []},
                viewport={"x": 0, "y": 0, "scale": 1},
                schema_version=1,
                revision=0,
            )
            db.add(canvas)
            await db.commit()
            user_id = user.id
            project_id = project.id
            canvas_id = canvas.id

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(
                "/api/auth/login",
                json={"identifier": "flux_tester", "password": "pwd123"},
            )
            sessions_res = await client.get(f"/api/canvases/{canvas_id}/agent-sessions")
            session_id = uuid.UUID(sessions_res.json()[0]["id"])

            ctx = {
                "settings": settings,
                "session_factory": app.state.session_factory,
                "object_storage": create_storage(settings),
            }

            goals = [
                "一只可爱的小猫，卡通风格，明亮背景，保持 16:9 比例",
                "生成暖象牙极简主图并配右侧便签，保持 16:9 比例",
                "核磁共振专员要求：对比度增强，色调偏冷灰，比例保持 16:9",
            ]

            for i, g in enumerate(goals):
                async with app.state.session_factory() as db:
                    run_obj = AgentRun(
                        owner_id=user_id,
                        project_id=project_id,
                        canvas_id=canvas_id,
                        session_id=session_id,
                        goal=g,
                        reference_asset_ids=[],
                        harness_options={
                            "llm_mode": "scripted",
                            "loop_mode": "autonomous",
                            "image_engine": "local-mflux",
                            "use_mock_image": True,
                            "lab_scenario": "memory_compaction",
                            "compaction_threshold_pct": 85,
                            "force_compact": (i >= 1),
                            "max_loop_steps": 10,
                        },
                        context_revision=0,
                        model_call_budget=20,
                        completion_tokens_per_call=2048,
                        status=RunStatus.QUEUED,
                    )
                    db.add(run_obj)
                    await db.flush()
                    db.add(
                        AgentTask(
                            run_id=run_obj.id,
                            role="Lead Agent",
                            sequence=0,
                            task_key="lead_agent",
                            title=f"压测轮次 #{i+1}",
                            depends_on=[],
                            status=RunStatus.QUEUED,
                        )
                    )
                    await db.commit()
                    run_uuid = str(run_obj.id)

                await execute_agent_run(ctx, run_uuid)

            # Assert progressive retention of Layer 2 pinned user values
            async with app.state.session_factory() as db:
                sess_row = await db.get(AgentSession, session_id)
                assert sess_row is not None
                assert isinstance(sess_row.pinned_user_values, list)
                # Verify that all 3 pinned user values exist without loss
                assert any("16:9" in str(p) for p in sess_row.pinned_user_values)
                assert any("暖象牙" in str(p) for p in sess_row.pinned_user_values)
                assert any("专员情报" in str(p) for p in sess_row.pinned_user_values)
                # Verify causal compaction summary
                assert len(sess_row.compacted_summary) > 0
                assert sess_row.compacted_run_count >= 1
