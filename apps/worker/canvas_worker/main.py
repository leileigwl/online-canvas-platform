from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

from arq import cron
from arq.connections import RedisSettings
from arq.constants import default_queue_name, in_progress_key_prefix
from canvas_api.config import Settings, get_settings
from canvas_api.database import create_database
from canvas_api.image_assets import persist_generated_images, resolve_user_image_provider
from canvas_api.models import (
    AgentRun,
    AgentTask,
    Asset,
    Canvas,
    CanvasMemory,
    ModelConfig,
    RunEvent,
    RunStatus,
)
from canvas_api.providers.chat import OpenAICompatibleChatProvider, ProviderError
from canvas_api.providers.images import (
    ImageGenerationRequest,
    ImageProviderError,
    ImageProviderNotConfigured,
    ReferenceImage,
    UnconfiguredImageProvider,
)
from canvas_api.security import decrypt_secret
from canvas_api.storage import ObjectStorage, create_storage
from canvas_api.tools import TOOL_SPECS, PlanValidationError, validate_plan
from langgraph.types import StreamWriter
from sqlalchemy import and_, func, or_, select, update

from canvas_worker.checkpoints import open_checkpointer
from canvas_worker.orchestration import AgentState, build_agent_graph

COORDINATOR_PROMPT = "\n".join(
    (
        "你是 FlowCanvas Coordinator。分析目标并拆成最多 3 个可审阅的画布创作或生图子任务。",
        (
            '只返回 JSON：{"summary":"中文提案概述","thinking":"1-2句简明拆解思路","subtasks":'
            '[{"id":"task-1","title":"任务标题","goal":"明确工作目标","depends_on":[]}]}。'
        ),
        "按顺序使用 task-1、task-2、task-3 作为 id；依赖只填写已有的前置子任务 id。",
        (
            "将可独立完成的工作拆开，让 Canvas Editor 并行处理；"
            "如先生成新图再排版的任务用 depends_on 声明先后。"
        ),
        "参考当前画布和用户授权的参考图片元数据，不编造图片内容。",
        (
            "如提供 harness_memory（含核心记忆 core_summary、近期轮次 recent_turns 与否决记录 "
            "rejected_patterns），需自然承接上下文指代并避免重复已否决方案。"
        ),
        "不要直接输出工具 JSON，不要输出代码或任意外部链接。",
    )
)
COMPACTOR_PROMPT = "\n".join(
    (
        "你是 FlowCanvas Harness Memory Compactor（类似 Cursor/Devin 上下文压缩器）。",
        "将较早的画布对话轮次与现有 core_summary 蒸馏压缩为 500 字以内的高密度核心记忆。",
        (
            "必须保留：视觉风格偏好、配色光线要求、核心参考图 ID/角色对应、"
            "以及用户拒绝/回退的原因；剔除冗余过程。"
        ),
        '只返回 JSON：{"core_memory":"紧凑的结构化中文核心记忆"}。',
    )
)
PLANNER_PROMPT = "\n".join(
    (
        "你是 FlowCanvas Planner。为 Coordinator 提供的每个子任务制定简洁画布执行方案。",
        (
            '只返回 JSON：{"thinking":"1-2句规划逻辑",'
            '"plans":[{"task_id":"task-1","plan":"具体布局、文案或生图建议"}]}。'
        ),
        "每个输入子任务必须且只能对应一个方案，task_id 必须原样返回。",
        "对齐任务只需局部围绕目标对象整理（align_objects），绝不整体打乱无关元素。",
    )
)
EDITOR_PROMPT = "\n".join(
    (
        (
            "你是 FlowCanvas Canvas Editor。根据分配的子任务和 Planner 方案，"
            "提出最多 12 个受白名单校验的画布工具操作。"
        ),
        (
            '只返回 JSON：{"thinking":"简短执行思考",'
            '"operations":[{"tool":"add_note","params":{...}}]}。'
        ),
        (
            "允许的 tool 严格限于：add_note, add_text, move_object, resize_object, "
            "align_objects, add_shape, generate_image, edit_image。"
        ),
        (
            "关键参数：add_note(title,content,x,y,width,height)；"
            "add_text(content,x,y,width,height,font_family,font_size,color)；"
        ),
        (
            "move_object(object_id,x,y)；resize_object(object_id,width,height)；"
            "align_objects(object_ids,columns,gap)；"
        ),
        (
            "add_shape(shape_kind,title,x,y,width,height,color)；"
            "generate_image(prompt,x,y,width,height,aspect_ratio,reference_object_ids)；"
        ),
        "edit_image(prompt,reference_object_ids,x,y,width,height,aspect_ratio)。",
        (
            "所有 object_id 必须来自当前画布中真实存在的 id；不得输出 URL、base64 "
            "或未登记工具。信息不足时返回空 operations。"
        ),
    )
)
REVIEWER_PROMPT = "\n".join(
    (
        "你是 FlowCanvas Reviewer。检查提案是否符合用户目标、Planner 方案和白名单工具规范。",
        '只返回 JSON：{"approved":true,"thinking":"审阅要点","feedback":"简短中文审阅意见"}。',
        "仅当所有操作属于 8 个白名单画布/生图工具且未越权移动无关对象时 approved 才为 true。",
    )
)
logger = logging.getLogger(__name__)
MAX_AGENT_RUN_ATTEMPTS = 3
MAX_SUBTASKS = 3
MAX_PARALLEL_SUBTASKS = 3
MAX_PROPOSAL_OPERATIONS = 12


def _model_for_role(config: dict, role: str) -> str:
    return (config.get("role_models") or {}).get(role) or config["model"]


def _validate_subtasks(raw: object) -> tuple[str, list[dict]]:
    if not isinstance(raw, dict):
        raise ProviderError("Coordinator 没有返回有效任务分解")
    summary = raw.get("summary")
    subtasks = raw.get("subtasks")
    if not isinstance(summary, str) or not summary.strip():
        raise ProviderError("Coordinator 没有返回提案摘要")
    if not isinstance(subtasks, list) or not 1 <= len(subtasks) <= MAX_SUBTASKS:
        raise ProviderError("Coordinator 子任务数量必须为 1 到 3 个")
    checked: list[dict] = []
    ids = set()
    for index, task in enumerate(subtasks, start=1):
        if not isinstance(task, dict) or task.get("id") != f"task-{index}":
            raise ProviderError("Coordinator 子任务 id 必须按 task-1、task-2、task-3 排列")
        title = task.get("title")
        goal = task.get("goal")
        dependencies = task.get("depends_on", [])
        if not isinstance(title, str) or not title.strip() or len(title.strip()) > 80:
            raise ProviderError("Coordinator 子任务标题无效")
        if not isinstance(goal, str) or not goal.strip() or len(goal.strip()) > 1200:
            raise ProviderError("Coordinator 子任务目标无效")
        if not isinstance(dependencies, list) or len(dependencies) > MAX_SUBTASKS:
            raise ProviderError("Coordinator 子任务依赖格式无效")
        if any(
            not isinstance(dep, str) or dep not in ids or dep == task["id"] for dep in dependencies
        ):
            raise ProviderError("Coordinator 子任务只能依赖较早的已定义任务")
        checked.append(
            {
                "id": task["id"],
                "title": title.strip(),
                "goal": goal.strip(),
                "depends_on": list(dict.fromkeys(dependencies)),
            }
        )
        ids.add(task["id"])
    return summary.strip()[:2000], checked


def _validate_plans(raw: object, subtasks: list[dict]) -> dict[str, str]:
    plans = raw.get("plans") if isinstance(raw, dict) else None
    expected_ids = [task["id"] for task in subtasks]
    if not isinstance(plans, list) or len(plans) != len(expected_ids):
        raise ProviderError("Planner 返回的方案数量与子任务不一致")
    result: dict[str, str] = {}
    for plan in plans:
        if not isinstance(plan, dict):
            raise ProviderError("Planner 子任务方案格式无效")
        task_id = plan.get("task_id")
        text = plan.get("plan")
        if task_id not in expected_ids or task_id in result:
            raise ProviderError("Planner 返回了未知或重复的子任务方案")
        if not isinstance(text, str) or not text.strip():
            raise ProviderError("Planner 子任务方案不能为空")
        result[task_id] = text.strip()[:3000]
    if set(result) != set(expected_ids):
        raise ProviderError("Planner 没有覆盖全部子任务")
    return result


def _editor_waves(subtasks: list[dict]) -> list[list[dict]]:
    completed: set[str] = set()
    remaining = list(subtasks)
    waves: list[list[dict]] = []
    while remaining:
        wave = [task for task in remaining if set(task["depends_on"]).issubset(completed)]
        if not wave:
            raise ProviderError("Coordinator 子任务依赖中存在循环")
        waves.append(wave[:MAX_PARALLEL_SUBTASKS])
        completed.update(task["id"] for task in wave)
        wave_ids = {task["id"] for task in wave}
        remaining = [task for task in remaining if task["id"] not in wave_ids]
    return waves


async def _task_record(session_factory, run_id: uuid.UUID, sequence: int) -> dict | None:
    async with session_factory() as session:
        task = await session.scalar(
            select(AgentTask).where(AgentTask.run_id == run_id, AgentTask.sequence == sequence)
        )
        if task is None:
            return None
        return {
            "status": _status_value(task.status),
            "output": task.output,
            "task_key": task.task_key,
        }


async def _ensure_role_tasks(session_factory, run_id: uuid.UUID, subtasks: list[dict]) -> None:
    editor_keys = {task["id"]: f"editor-{task['id']}" for task in subtasks}
    definitions = [
        {
            "role": "Planner",
            "sequence": 1,
            "task_key": "planner",
            "title": "制定子任务方案",
            "depends_on": ["coordinator"],
        }
    ]
    for index, task in enumerate(subtasks, start=2):
        definitions.append(
            {
                "role": "Canvas Editor",
                "sequence": index,
                "task_key": editor_keys[task["id"]],
                "title": task["title"],
                "depends_on": ["planner", *[editor_keys[dep] for dep in task["depends_on"]]],
            }
        )
    definitions.append(
        {
            "role": "Reviewer",
            "sequence": len(subtasks) + 2,
            "task_key": "reviewer",
            "title": "审阅合并提案",
            "depends_on": [editor_keys[task["id"]] for task in subtasks],
        }
    )
    async with session_factory() as session:
        run = await session.scalar(select(AgentRun).where(AgentRun.id == run_id).with_for_update())
        if run is None or _status_value(run.status) != RunStatus.RUNNING:
            raise RunCanceled
        existing = {
            task.task_key: task
            for task in await session.scalars(select(AgentTask).where(AgentTask.run_id == run_id))
        }
        added = []
        for definition in definitions:
            if definition["task_key"] in existing:
                continue
            task = AgentTask(run_id=run_id, **definition, status=RunStatus.QUEUED)
            session.add(task)
            added.append(task)
        if added:
            await session.flush()
            for task in added:
                await _append_event(
                    session,
                    run_id,
                    "task_created",
                    {
                        "sequence": task.sequence,
                        "task_key": task.task_key,
                        "title": task.title,
                        "role": task.role,
                        "depends_on": task.depends_on,
                        "status": _status_value(task.status),
                    },
                )
        await session.commit()


class RunCanceled(Exception):
    pass


async def _reserve_agent_model_call(session_factory, run_id: uuid.UUID) -> None:
    """Atomically consume one chat request from the durable AgentRun allowance."""
    async with session_factory() as session:
        reservation = await session.execute(
            update(AgentRun)
            .where(
                AgentRun.id == run_id,
                AgentRun.status == RunStatus.RUNNING,
                AgentRun.model_calls_used < AgentRun.model_call_budget,
            )
            .values(model_calls_used=AgentRun.model_calls_used + 1)
        )
        if not reservation.rowcount:
            run = await session.get(AgentRun, run_id)
            if run and _status_value(run.status) == RunStatus.CANCELED:
                raise RunCanceled
            raise ProviderError("本次运行已达到模型调用上限")
        await session.commit()


async def _append_event(session, run_id, event_type: str, data: dict) -> None:
    await session.scalar(select(AgentRun.id).where(AgentRun.id == run_id).with_for_update())
    last = await session.scalar(
        select(func.max(RunEvent.sequence)).where(RunEvent.run_id == run_id)
    )
    session.add(RunEvent(run_id=run_id, sequence=(last or 0) + 1, event_type=event_type, data=data))


def _status_value(status: RunStatus | str) -> str:
    return status.value if isinstance(status, RunStatus) else status


async def _set_task_state(
    session_factory,
    run_id: uuid.UUID,
    sequence: int,
    status: RunStatus,
    output: dict | None = None,
    error: str | None = None,
) -> bool:
    async with session_factory() as session:
        run = await session.scalar(select(AgentRun).where(AgentRun.id == run_id).with_for_update())
        if run is None or _status_value(run.status) in {
            RunStatus.CANCELED,
            RunStatus.SUCCEEDED,
            RunStatus.FAILED,
        }:
            return False
        task = await session.scalar(
            select(AgentTask).where(AgentTask.run_id == run_id, AgentTask.sequence == sequence)
        )
        if task is None:
            raise RuntimeError(f"Agent task sequence {sequence} is missing")
        task.status = status
        task.output = output
        task.error = error
        await _append_event(
            session,
            run_id,
            "task_updated",
            {
                "sequence": sequence,
                "task_key": task.task_key,
                "title": task.title,
                "role": task.role,
                "depends_on": task.depends_on or [],
                "status": _status_value(status),
                "output": output,
                "error": error,
            },
        )
        await session.commit()
        return True


def _asset_payload(asset: Asset) -> dict:
    return {
        "id": str(asset.id),
        "name": asset.name,
        "mime_type": asset.mime_type,
        "size_bytes": asset.size_bytes,
        "width": asset.width,
        "height": asset.height,
        "favorite": asset.favorite,
        "temporary": asset.temporary,
        "src": f"/api/assets/{asset.id}/content",
        "created_at": asset.created_at.isoformat(),
    }


async def _complete_generation_run(
    session_factory,
    run_id: uuid.UUID,
    summary: str,
    generated_assets: list[Asset],
) -> None:
    assets = [_asset_payload(asset) for asset in generated_assets]
    proposal = {
        "operations": [],
        "applied": False,
        "reviewed": True,
        "generated_assets": assets,
    }
    async with session_factory() as session:
        run = await session.get(AgentRun, run_id)
        if run is None:
            return
        completed = await session.execute(
            update(AgentRun)
            .where(AgentRun.id == run_id, AgentRun.status == RunStatus.RUNNING)
            .values(status=RunStatus.SUCCEEDED, summary=summary, proposal=proposal, error=None)
        )
        if not completed.rowcount:
            return
        await _append_event(
            session,
            run_id,
            "succeeded",
            {"status": "succeeded", "summary": summary, "proposal": proposal},
        )
        await session.commit()


async def _execute_generation_run(
    ctx: dict,
    run_id: uuid.UUID,
    owner_id: uuid.UUID,
    goal: str,
    reference_asset_ids: list[str],
    generation_settings: dict,
    max_upload_bytes: int,
) -> None:
    session_factory = ctx["session_factory"]
    settings: Settings = ctx.get("settings") or get_settings()
    storage: ObjectStorage = ctx.get("object_storage") or create_storage(settings)
    fallback_provider = ctx.get("image_provider") or UnconfiguredImageProvider()
    task = await _task_record(session_factory, run_id, 0)
    generated_assets: list[Asset] = []

    try:
        if task and task["status"] == RunStatus.SUCCEEDED and task["output"]:
            asset_ids = [uuid.UUID(item["id"]) for item in task["output"].get("images", [])]
            if not asset_ids:
                raise ImageProviderError("已生成的图片结果不完整，请重新提交目标")
            async with session_factory() as session:
                stored_assets = list(
                    await session.scalars(
                        select(Asset).where(Asset.owner_id == owner_id, Asset.id.in_(asset_ids))
                    )
                )
            if len(stored_assets) != len(asset_ids):
                raise ImageProviderError("已生成的图片结果不完整，请重新提交目标")
            assets_by_id = {asset.id: asset for asset in stored_assets}
            generated_assets = [assets_by_id[asset_id] for asset_id in asset_ids]
        else:
            if not await _set_task_state(session_factory, run_id, 0, RunStatus.RUNNING):
                raise RunCanceled
            reference_assets: list[Asset] = []
            async with session_factory() as session:
                provider = await resolve_user_image_provider(
                    session, owner_id, settings, fallback=fallback_provider
                )
                if reference_asset_ids:
                    rows = list(
                        await session.scalars(
                            select(Asset).where(
                                Asset.owner_id == owner_id,
                                Asset.id.in_([uuid.UUID(item) for item in reference_asset_ids]),
                            )
                        )
                    )
                    if len(rows) != len(set(reference_asset_ids)):
                        raise ImageProviderError("部分参考图片已不存在或无权访问")
                    asset_map = {asset.id: asset for asset in rows}
                    reference_assets = [asset_map[uuid.UUID(item)] for item in reference_asset_ids]
            reference_images = []
            for asset in reference_assets:
                reference_images.append(
                    ReferenceImage(
                        asset_id=asset.id,
                        mime_type=asset.mime_type,
                        content=await storage.get(asset.object_key),
                    )
                )
            request = ImageGenerationRequest(
                user_id=owner_id,
                prompt=goal,
                model=generation_settings["model"],
                reference_asset_ids=tuple(asset.id for asset in reference_assets),
                quality=generation_settings["quality"],
                width=generation_settings["width"],
                height=generation_settings["height"],
                align_to_16=generation_settings["align_to_16"],
                resolution=generation_settings["resolution"],
                aspect_ratio=generation_settings["aspect_ratio"],
                transparent=generation_settings["transparent"],
                count=generation_settings["count"],
                reference_images=tuple(reference_images),
                input_fidelity=generation_settings.get("input_fidelity", "high"),
            )
            generated = await provider.generate(request)
            if not generated or len(generated) > request.count:
                raise ImageProviderError("生图服务返回的图片数量无效")
            async with session_factory() as session:
                try:
                    generated_assets = await persist_generated_images(
                        session,
                        storage,
                        owner_id,
                        generated,
                        max_upload_bytes,
                        temporary=True,
                        commit=False,
                    )
                    run = await session.scalar(
                        select(AgentRun).where(AgentRun.id == run_id).with_for_update()
                    )
                    task_record = await session.scalar(
                        select(AgentTask).where(AgentTask.run_id == run_id, AgentTask.sequence == 0)
                    )
                    if (
                        run is None
                        or _status_value(run.status) != RunStatus.RUNNING
                        or task_record is None
                    ):
                        await session.rollback()
                        for asset in generated_assets:
                            await storage.delete(asset.object_key)
                        raise RunCanceled
                    task_record.status = RunStatus.SUCCEEDED
                    task_record.output = {
                        "images": [_asset_payload(asset) for asset in generated_assets]
                    }
                    task_record.error = None
                    await _append_event(
                        session,
                        run_id,
                        "task_updated",
                        {
                            "sequence": task_record.sequence,
                            "task_key": task_record.task_key,
                            "title": task_record.title,
                            "role": task_record.role,
                            "depends_on": task_record.depends_on or [],
                            "status": RunStatus.SUCCEEDED,
                            "output": task_record.output,
                            "error": None,
                        },
                    )
                    await session.commit()
                except RunCanceled:
                    raise
                except Exception:
                    await session.rollback()
                    for asset in generated_assets:
                        await storage.delete(asset.object_key)
                    raise

        await _complete_generation_run(
            session_factory,
            run_id,
            f"已生成 {len(generated_assets)} 张图片，等待你预览后保存或加入画布。",
            generated_assets,
        )
    except RunCanceled:
        return
    except ImageProviderNotConfigured as error:
        await _fail_run_by_id(session_factory, run_id, str(error))
    except ImageProviderError as error:
        await _fail_run_by_id(session_factory, run_id, str(error)[:500])
    except Exception as error:
        logger.error(
            "image generation failed run_id=%s error_type=%s",
            run_id,
            type(error).__name__,
        )
        await _fail_run_by_id(session_factory, run_id, "生图任务失败，请检查服务配置后重试。")


def _canvas_summary(items: list[dict]) -> list[dict]:
    summary = []
    for item in items[:200]:
        row = {
            key: item.get(key)
            for key in ("id", "type", "title", "x", "y", "width", "height", "color")
        }
        if item.get("content"):
            row["content"] = str(item["content"])[:600]
        summary.append(row)
    return summary


async def execute_agent_run(ctx: dict, run_id: str) -> None:
    """Run a persisted, checkpointed role graph and leave all canvas writes for user review."""
    settings: Settings = ctx.get("settings") or get_settings()
    session_factory = ctx["session_factory"]
    run_uuid = uuid.UUID(run_id)

    async with session_factory() as session:
        run = await session.get(AgentRun, run_uuid)
        if run is None or _status_value(run.status) in {
            RunStatus.CANCELED,
            RunStatus.SUCCEEDED,
            RunStatus.FAILED,
        }:
            return
        initial_status = _status_value(run.status)
        started = await session.execute(
            update(AgentRun)
            .where(
                AgentRun.id == run_uuid,
                AgentRun.status.in_((RunStatus.QUEUED, RunStatus.RUNNING)),
            )
            .values(status=RunStatus.RUNNING, error=None)
        )
        if not started.rowcount:
            return
        await session.refresh(run)
        generation_settings = run.generation_settings
        completion_tokens_per_call = run.completion_tokens_per_call
        model_config = await session.scalar(
            select(ModelConfig).where(ModelConfig.owner_id == run.owner_id)
        )
        if model_config is None and generation_settings is None:
            message = "尚未配置语言模型，请先完成 Agent 设置。"
            await _fail_run(session, run, message)
            return

        canvas = await session.get(Canvas, run.canvas_id)
        if canvas is None:
            await _fail_run(session, run, "目标画布已不存在。")
            return
        if canvas.revision != run.context_revision:
            await _fail_run(session, run, "画布已更新，请基于最新版本重新提交目标。")
            return

        owner_id = run.owner_id
        canvas_uuid = run.canvas_id
        goal = run.goal
        context_revision = run.context_revision
        reference_asset_ids = list(run.reference_asset_ids or [])
        canvas_items = canvas.document.get("items", []) if isinstance(canvas.document, dict) else []
        max_context_tokens = 32768
        model_config_data = None
        if model_config is not None:
            max_context_tokens = model_config.max_context_tokens or 32768
            model_config_data = {
                "base_url": model_config.base_url,
                "model": model_config.model_name,
                "role_models": model_config.role_models or {},
                "api_key": decrypt_secret(model_config.encrypted_api_key, settings),
            }
        if initial_status == RunStatus.QUEUED:
            await _append_event(session, run.id, "running", {"status": "running"})
        await session.commit()

    references = []
    if reference_asset_ids:
        async with session_factory() as session:
            assets = await session.scalars(
                select(Asset).where(
                    Asset.owner_id == owner_id,
                    Asset.id.in_([uuid.UUID(asset_id) for asset_id in reference_asset_ids]),
                )
            )
            references = [
                {
                    "id": str(asset.id),
                    "name": asset.name,
                    "width": asset.width,
                    "height": asset.height,
                }
                for asset in assets
            ]

    if generation_settings is not None:
        await _execute_generation_run(
            ctx,
            run_uuid,
            owner_id,
            goal,
            reference_asset_ids,
            generation_settings,
            settings.max_upload_bytes,
        )
        return

    storage: ObjectStorage = ctx.get("object_storage") or create_storage(settings)
    fallback_img_provider = ctx.get("image_provider") or UnconfiguredImageProvider()
    provider = OpenAICompatibleChatProvider()
    task_state_lock = asyncio.Lock()

    def _summarize_turn(prior: AgentRun) -> dict:
        prop = prior.proposal or {}
        state_tag = (
            "reverted"
            if prop.get("reverted")
            else "rejected"
            if prop.get("rejected")
            else "applied"
            if prop.get("applied")
            else "proposed"
        )
        ops_brief = [
            {
                "tool": op.get("tool"),
                "title": (op.get("result") or {}).get("title")
                or (op.get("params") or {}).get("title")
                or (op.get("params") or {}).get("prompt", "")[:40],
            }
            for op in (prop.get("operations") or [])[:6]
        ]
        return {
            "goal": prior.goal[:300],
            "summary": (prior.summary or "")[:300],
            "decision": state_tag,
            "operations": ops_brief,
        }

    # Build Harness persistent + compacted multi-turn memory for this canvas
    async with session_factory() as mem_session:
        memory = await mem_session.scalar(
            select(CanvasMemory).where(
                CanvasMemory.owner_id == owner_id, CanvasMemory.canvas_id == canvas_uuid
            )
        )
        prior_runs = list(
            await mem_session.scalars(
                select(AgentRun)
                .where(
                    AgentRun.owner_id == owner_id,
                    AgentRun.canvas_id == canvas_uuid,
                    AgentRun.id != run_uuid,
                    AgentRun.status == RunStatus.SUCCEEDED,
                )
                .order_by(AgentRun.created_at.asc())
            )
        )
    anchor_id = memory.last_compacted_run_id if memory else None
    recent_runs = prior_runs
    if anchor_id:
        anchor_idx = next((idx for idx, item in enumerate(prior_runs) if item.id == anchor_id), -1)
        if anchor_idx >= 0:
            recent_runs = prior_runs[anchor_idx + 1 :]
    compacted_summary = memory.compacted_summary if memory else ""
    rejected_patterns = list(memory.rejected_feedback or []) if memory else []
    recent_payload = [_summarize_turn(r) for r in recent_runs]
    canvas_brief = _canvas_summary(canvas_items)
    approx_tokens = (
        len(compacted_summary)
        + len(json.dumps(recent_payload, ensure_ascii=False))
        + len(json.dumps(canvas_brief, ensure_ascii=False))
    ) // 3
    compact_threshold = int(max_context_tokens * 0.65)

    user_context = {
        "goal": goal,
        "context_revision": context_revision,
        "canvas": canvas_brief,
        "authorized_reference_image_metadata": references,
        "harness_memory": {
            "core_summary": compacted_summary,
            "rejected_patterns": rejected_patterns,
            "recent_turns": recent_payload,
        },
    }

    async def materialize_image_op(operation: dict) -> dict:
        params = operation["params"]
        ref_object_ids = params.get("reference_object_ids", [])
        items_by_id = {item["id"]: item for item in canvas_items if isinstance(item, dict)}
        ordered_asset_ids = [
            uuid.UUID(str(items_by_id[oid]["asset_id"]))
            for oid in ref_object_ids
            if items_by_id.get(oid) and items_by_id[oid].get("asset_id")
        ]
        async with session_factory() as session:
            img_provider = await resolve_user_image_provider(
                session, owner_id, settings, fallback=fallback_img_provider
            )
            ref_images: list[ReferenceImage] = []
            if ordered_asset_ids:
                rows = list(
                    await session.scalars(
                        select(Asset).where(
                            Asset.owner_id == owner_id, Asset.id.in_(ordered_asset_ids)
                        )
                    )
                )
                asset_map = {asset.id: asset for asset in rows}
                for aid in ordered_asset_ids:
                    if aid not in asset_map:
                        raise ImageProviderError("引用的画布参考图片不存在")
                    asset = asset_map[aid]
                    ref_images.append(
                        ReferenceImage(
                            asset_id=asset.id,
                            mime_type=asset.mime_type,
                            content=await storage.get(asset.object_key),
                        )
                    )
        req = ImageGenerationRequest(
            user_id=owner_id,
            prompt=params["prompt"],
            model="auto",
            reference_asset_ids=tuple(ordered_asset_ids),
            quality="auto",
            width=1024,
            height=1024,
            align_to_16=True,
            resolution="auto",
            aspect_ratio=params.get("aspect_ratio", "auto"),
            transparent=False,
            count=1,
            reference_images=tuple(ref_images),
        )
        generated = await img_provider.generate(req)
        if not generated:
            raise ImageProviderError("Agent 生图工具未返回有效图片")
        async with session_factory() as session:
            saved_assets = await persist_generated_images(
                session,
                storage,
                owner_id,
                generated[:1],
                settings.max_upload_bytes,
                temporary=True,
                name_prefix=params["prompt"][:24] or "Agent 生成图",
            )
        asset = saved_assets[0]
        return {
            **operation,
            "result": {
                "asset_id": str(asset.id),
                "src": f"/api/assets/{asset.id}/content",
                "width": asset.width,
                "height": asset.height,
                "title": asset.name,
            },
        }

    async def call_model(*, model: str, system: str, user: str) -> dict:
        # Reserve before contacting the provider so ARQ retries and Worker restarts
        # consume the same durable per-run allowance.
        await _reserve_agent_model_call(session_factory, run_uuid)

        response = await provider.complete_json(
            base_url=model_config_data["base_url"],
            api_key=model_config_data["api_key"],
            model=model,
            system=system,
            user=user,
            max_output_tokens=completion_tokens_per_call,
            token_limit_field=settings.chat_completion_token_limit_field,
        )
        if response.completion_tokens is not None:
            async with session_factory() as session:
                recorded = await session.execute(
                    update(AgentRun)
                    .where(AgentRun.id == run_uuid)
                    .values(
                        completion_tokens_used=(
                            AgentRun.completion_tokens_used + response.completion_tokens
                        ),
                        completion_usage_reports=AgentRun.completion_usage_reports + 1,
                    )
                )
                await session.commit()
                if not recorded.rowcount:
                    raise RunCanceled
            if response.completion_tokens > completion_tokens_per_call:
                raise ProviderError("模型服务返回内容超过单次输出 token 上限")
        return response.content

    async def _maybe_compact_harness_memory(writer: StreamWriter) -> None:
        nonlocal compacted_summary, approx_tokens
        should_compact = len(recent_runs) > 2 and (
            len(recent_runs) >= 6 or approx_tokens >= compact_threshold
        )
        if not should_compact:
            return
        head_runs = recent_runs[:-2]
        tail_payload = [_summarize_turn(r) for r in recent_runs[-2:]]
        writer(
            {
                "kind": "thinking",
                "role": "Harness Memory",
                "title": "上下文接近模型窗口阈值，自动触发压缩",
                "text": (
                    f"当前上下文约 {approx_tokens} tokens（阈值 {compact_threshold}），"
                    f"正在将较早的 {len(head_runs)} 轮交互蒸馏为核心记忆，并保留最近 2 轮完整对话。"
                ),
            }
        )
        compacted = await call_model(
            model=_model_for_role(model_config_data, "Coordinator"),
            system=COMPACTOR_PROMPT,
            user=json.dumps(
                {
                    "previous_core_memory": compacted_summary,
                    "rejected_patterns": rejected_patterns,
                    "turns_to_compact": [_summarize_turn(r) for r in head_runs],
                },
                ensure_ascii=False,
            ),
        )
        new_core = str(compacted.get("core_memory") or compacted_summary).strip()[:1200]
        compacted_summary = new_core
        approx_tokens = (
            len(compacted_summary)
            + len(json.dumps(tail_payload, ensure_ascii=False))
            + len(json.dumps(canvas_brief, ensure_ascii=False))
        ) // 3
        async with session_factory() as mem_save:
            row = await mem_save.scalar(
                select(CanvasMemory).where(
                    CanvasMemory.owner_id == owner_id, CanvasMemory.canvas_id == canvas_uuid
                )
            )
            if row is None:
                row = CanvasMemory(
                    owner_id=owner_id,
                    canvas_id=canvas_uuid,
                    compacted_summary=compacted_summary,
                    compacted_run_count=len(head_runs),
                    last_compacted_run_id=head_runs[-1].id,
                    estimated_tokens=approx_tokens,
                    rejected_feedback=rejected_patterns,
                )
                mem_save.add(row)
            else:
                row.compacted_summary = compacted_summary
                row.compacted_run_count = (row.compacted_run_count or 0) + len(head_runs)
                row.last_compacted_run_id = head_runs[-1].id
                row.estimated_tokens = approx_tokens
            await mem_save.commit()
        user_context["harness_memory"] = {
            "core_summary": compacted_summary,
            "rejected_patterns": rejected_patterns,
            "recent_turns": tail_payload,
        }

    async def set_task_state(sequence: int, status: RunStatus, output: dict | None = None) -> bool:
        async with task_state_lock:
            return await _set_task_state(session_factory, run_uuid, sequence, status, output)

    async def coordinator(state: AgentState, writer: StreamWriter) -> dict:
        existing = await _task_record(session_factory, run_uuid, 0)
        output = (
            existing["output"] if existing and existing["status"] == RunStatus.SUCCEEDED else None
        )
        if output is None:
            if not await set_task_state(0, RunStatus.RUNNING):
                raise RunCanceled
            await _maybe_compact_harness_memory(writer)
            writer(
                {
                    "kind": "thinking",
                    "role": "Coordinator",
                    "title": "理解创作目标与画布上下文",
                    "text": f"正在分析目标「{goal[:80]}」与当前 {len(canvas_items)} 个画布对象...",
                }
            )
            response = await call_model(
                model=_model_for_role(model_config_data, "Coordinator"),
                system=COORDINATOR_PROMPT,
                user=json.dumps(user_context, ensure_ascii=False),
            )
            summary, subtasks = _validate_subtasks(response)
            thinking = str(response.get("thinking") or "").strip()
            if thinking:
                writer(
                    {
                        "kind": "thinking",
                        "role": "Coordinator",
                        "title": "任务拆解结论",
                        "text": thinking[:400],
                    }
                )
            output = {"summary": summary, "subtasks": subtasks}
            if not await set_task_state(0, RunStatus.SUCCEEDED, output):
                raise RunCanceled
        summary, subtasks = _validate_subtasks(output)
        async with task_state_lock:
            await _ensure_role_tasks(session_factory, run_uuid, subtasks)
        coordination = {
            "delegated_roles": ["Planner", "Canvas Editor", "Reviewer"],
            "max_operations": MAX_PROPOSAL_OPERATIONS,
            "max_parallel_subtasks": MAX_PARALLEL_SUBTASKS,
            "canvas_revision": context_revision,
        }
        return {"coordination": coordination, "summary": summary, "subtasks": subtasks}

    async def planner(state: AgentState, writer: StreamWriter) -> dict:
        existing = await _task_record(session_factory, run_uuid, 1)
        output = (
            existing["output"] if existing and existing["status"] == RunStatus.SUCCEEDED else None
        )
        if output is None:
            if not await set_task_state(1, RunStatus.RUNNING):
                raise RunCanceled
            writer(
                {
                    "kind": "thinking",
                    "role": "Planner",
                    "title": "制定分步空间与创作方案",
                    "text": f"正在为 {len(state['subtasks'])} 个子任务规划坐标与视觉策略...",
                }
            )
            response = await call_model(
                model=_model_for_role(model_config_data, "Planner"),
                system=PLANNER_PROMPT,
                user=json.dumps(
                    {**user_context, "subtasks": state["subtasks"]}, ensure_ascii=False
                ),
            )
            plans = _validate_plans(response, state["subtasks"])
            thinking = str(response.get("thinking") or "").strip()
            if thinking:
                writer(
                    {
                        "kind": "thinking",
                        "role": "Planner",
                        "title": "方案规划思路",
                        "text": thinking[:400],
                    }
                )
            output = {"plans": plans}
            if not await set_task_state(1, RunStatus.SUCCEEDED, output):
                raise RunCanceled
        saved_plans = [{"task_id": key, "plan": value} for key, value in output["plans"].items()]
        plans = _validate_plans({"plans": saved_plans}, state["subtasks"])
        return {"plans": plans}

    async def canvas_editor(state: AgentState, writer: StreamWriter) -> dict:
        async def run_editor(
            task: dict,
            sequence: int,
            prior_outputs: dict[str, list[dict]],
        ) -> tuple[str, list[dict]]:
            existing = await _task_record(session_factory, run_uuid, sequence)
            if existing and existing["status"] == RunStatus.SUCCEEDED:
                saved = existing["output"] or {}
                operations = validate_plan(
                    saved.get("operations", []), canvas_items, allow_result=True
                )
                return task["id"], operations
            if not await set_task_state(sequence, RunStatus.RUNNING):
                raise RunCanceled
            edit_context = {
                **user_context,
                "subtask": task,
                "planner_plan": state["plans"][task["id"]],
                "completed_dependency_operations": {
                    dep: prior_outputs.get(dep, []) for dep in task["depends_on"]
                },
            }
            response = await call_model(
                model=_model_for_role(model_config_data, "Canvas Editor"),
                system=EDITOR_PROMPT,
                user=json.dumps(edit_context, ensure_ascii=False),
            )
            thinking = str(response.get("thinking") or "").strip()
            if thinking:
                writer(
                    {
                        "kind": "thinking",
                        "role": "Canvas Editor",
                        "title": task["title"],
                        "text": thinking[:400],
                    }
                )
            operations = validate_plan(response.get("operations", []), canvas_items)
            finalized_ops: list[dict] = []
            for op in operations:
                spec = TOOL_SPECS[op["tool"]]
                if op["tool"] in {"generate_image", "edit_image"}:
                    writer(
                        {
                            "kind": "tool_call",
                            "tool": op["tool"],
                            "label": spec.label,
                            "params": op["params"],
                            "status": "running",
                        }
                    )
                    op = await materialize_image_op(op)
                    writer(
                        {
                            "kind": "tool_call",
                            "tool": op["tool"],
                            "label": spec.label,
                            "params": op["params"],
                            "result": op.get("result"),
                            "status": "created",
                        }
                    )
                else:
                    writer(
                        {
                            "kind": "tool_call",
                            "tool": op["tool"],
                            "label": spec.label,
                            "params": op["params"],
                            "status": "pending",
                        }
                    )
                finalized_ops.append(op)
            if not await set_task_state(
                sequence,
                RunStatus.SUCCEEDED,
                {"operation_count": len(finalized_ops), "operations": finalized_ops},
            ):
                raise RunCanceled
            return task["id"], finalized_ops

        task_sequences = {
            task["id"]: index for index, task in enumerate(state["subtasks"], start=2)
        }
        editor_outputs: dict[str, list[dict]] = {}
        for wave in _editor_waves(state["subtasks"]):
            results = await asyncio.gather(
                *(run_editor(task, task_sequences[task["id"]], editor_outputs) for task in wave),
                return_exceptions=True,
            )
            errors = [result for result in results if isinstance(result, BaseException)]
            if errors:
                raise errors[0]
            editor_outputs.update(
                dict(result for result in results if not isinstance(result, BaseException))
            )

        operations = []
        mutated_ids: set[str] = set()
        for task in state["subtasks"]:
            task_operations = editor_outputs[task["id"]]
            for operation in task_operations:
                if operation["tool"] in {"move_object", "resize_object"}:
                    object_id = operation["params"]["object_id"]
                    if object_id in mutated_ids:
                        raise PlanValidationError("并行子任务对同一画布对象提出了冲突修改")
                    mutated_ids.add(object_id)
            operations.extend(task_operations)
        if len(operations) > MAX_PROPOSAL_OPERATIONS:
            raise PlanValidationError("合并提案超过 12 个画布操作")
        return {"operations": operations, "editor_outputs": editor_outputs}

    async def reviewer(state: AgentState, writer: StreamWriter) -> dict:
        sequence = len(state["subtasks"]) + 2
        existing = await _task_record(session_factory, run_uuid, sequence)
        output = (
            existing["output"] if existing and existing["status"] == RunStatus.SUCCEEDED else None
        )
        if output is not None:
            return {"review": output}
        if not await set_task_state(sequence, RunStatus.RUNNING):
            raise RunCanceled
        writer(
            {
                "kind": "thinking",
                "role": "Reviewer",
                "title": "安全与质量审阅",
                "text": f"正在核验 {len(state['operations'])} 项画布操作提案...",
            }
        )
        review_context = {
            **user_context,
            "subtasks": state["subtasks"],
            "planner_plans": state["plans"],
            "editor_outputs": state["editor_outputs"],
            "operations": state["operations"],
        }
        response = await call_model(
            model=_model_for_role(model_config_data, "Reviewer"),
            system=REVIEWER_PROMPT,
            user=json.dumps(review_context, ensure_ascii=False),
        )
        approved = response.get("approved")
        feedback = response.get("feedback", "")
        if not isinstance(approved, bool):
            raise ProviderError("Reviewer 没有返回有效审阅结果")
        if not approved:
            raise ProviderError(str(feedback or "Reviewer 未通过本次提案")[:500])
        review = {"approved": True, "feedback": str(feedback)[:500]}
        if not await set_task_state(sequence, RunStatus.SUCCEEDED, review):
            raise RunCanceled
        return {"review": review}

    nodes = {
        "coordinator": coordinator,
        "planner": planner,
        "canvas_editor": canvas_editor,
        "reviewer": reviewer,
    }
    try:
        result: dict = {}
        async with open_checkpointer(settings) as checkpointer:
            graph = build_agent_graph(nodes, checkpointer)
            async for chunk in graph.astream(
                {
                    "run_id": run_id,
                    "goal": goal,
                    "context_revision": context_revision,
                    "canvas_items": _canvas_summary(canvas_items),
                    "references": references,
                },
                {"configurable": {"thread_id": run_id}},
                stream_mode=["updates", "custom"],
                version="v2",
            ):
                if chunk["type"] == "custom" and isinstance(chunk["data"], dict):
                    payload_data = chunk["data"]
                    evt_kind = str(payload_data.get("kind") or "thinking")
                    async with task_state_lock:
                        async with session_factory() as evt_session:
                            await _append_event(evt_session, run_uuid, evt_kind, payload_data)
                            await evt_session.commit()
                elif chunk["type"] == "updates" and isinstance(chunk["data"], dict):
                    for node_patch in chunk["data"].values():
                        if isinstance(node_patch, dict):
                            result.update(node_patch)
        async with session_factory() as session:
            run = await session.get(AgentRun, run_uuid)
            if run is None:
                return
            proposal = {
                "operations": result["operations"],
                "applied": False,
                "reviewed": True,
                "review": result["review"],
            }
            completed = await session.execute(
                update(AgentRun)
                .where(AgentRun.id == run_uuid, AgentRun.status == RunStatus.RUNNING)
                .values(
                    status=RunStatus.SUCCEEDED,
                    summary=result["summary"],
                    proposal=proposal,
                    error=None,
                )
            )
            if not completed.rowcount:
                return
            await _append_event(
                session,
                run.id,
                "succeeded",
                {"status": "succeeded", "summary": result["summary"], "proposal": proposal},
            )
            await session.commit()
    except RunCanceled:
        return
    except (ProviderError, PlanValidationError, ValueError) as error:
        await _fail_run_by_id(session_factory, run_uuid, str(error)[:500])
    except Exception as error:
        logger.error(
            "agent graph failed run_id=%s error_type=%s",
            run_id,
            type(error).__name__,
        )
        await _fail_run_by_id(session_factory, run_uuid, "Agent 执行失败，请检查模型配置后重试。")


async def _fail_run(session, run: AgentRun, message: str) -> None:
    failed = await session.execute(
        update(AgentRun)
        .where(
            AgentRun.id == run.id,
            AgentRun.status.in_((RunStatus.QUEUED, RunStatus.RUNNING)),
        )
        .values(status=RunStatus.FAILED, error=message)
    )
    if not failed.rowcount:
        return
    await session.execute(
        update(AgentTask)
        .where(
            AgentTask.run_id == run.id,
            AgentTask.status.in_((RunStatus.QUEUED, RunStatus.RUNNING)),
        )
        .values(status=RunStatus.FAILED, error=message)
    )
    await _append_event(session, run.id, "failed", {"status": "failed", "error": message})
    await session.commit()


async def _fail_run_by_id(session_factory, run_id: uuid.UUID, message: str) -> None:
    async with session_factory() as session:
        run = await session.get(AgentRun, run_id)
        if run is None:
            return
        await _fail_run(session, run, message)


async def after_job_end(ctx: dict) -> None:
    """Mark a run failed when its final executed attempt returns without a terminal state."""
    if int(ctx.get("job_try", 0)) < MAX_AGENT_RUN_ATTEMPTS:
        return
    job_id = str(ctx.get("job_id", ""))
    if not job_id.startswith("agent-run:"):
        return
    try:
        run_id = uuid.UUID(job_id.removeprefix("agent-run:"))
    except ValueError:
        logger.warning("Ignoring malformed Agent ARQ job id=%s", job_id)
        return
    await _fail_run_by_id(
        ctx["session_factory"],
        run_id,
        "Agent 连续中断，已停止自动恢复。检查模型或 Worker 后可重试。",
    )


async def reconcile_abandoned_agent_runs(ctx: dict) -> None:
    """Fail active runs whose ARQ record disappeared after retry exhaustion or Redis loss."""
    cutoff = datetime.now(UTC) - timedelta(minutes=2)
    try:
        async with ctx["session_factory"]() as session:
            runs = list(
                await session.scalars(
                    select(AgentRun).where(
                        or_(
                            AgentRun.status == RunStatus.RUNNING,
                            and_(
                                AgentRun.status == RunStatus.QUEUED,
                                AgentRun.created_at < cutoff,
                            ),
                        )
                    )
                )
            )
            for run in runs:
                job_id = f"agent-run:{run.id}"
                queued = await ctx["redis"].zscore(default_queue_name, job_id)
                in_progress = await ctx["redis"].exists(f"{in_progress_key_prefix}{job_id}")
                if queued is not None or in_progress:
                    continue
                logger.warning("Failing abandoned Agent run run_id=%s", run.id)
                await _fail_run(
                    session,
                    run,
                    "Agent 任务已中断，后台队列记录已丢失。检查 Worker 或 Redis 后可重试。",
                )
    except Exception as error:
        logger.error("Agent recovery sweep failed error_type=%s", type(error).__name__)


async def startup(ctx: dict) -> None:
    settings = get_settings()
    engine, session_factory = create_database(settings)
    ctx["engine"] = engine
    ctx["session_factory"] = session_factory
    ctx["settings"] = settings
    ctx["object_storage"] = create_storage(settings)
    ctx["image_provider"] = UnconfiguredImageProvider()


async def shutdown(ctx: dict) -> None:
    await ctx["engine"].dispose()


class WorkerSettings:
    functions = [execute_agent_run]
    cron_jobs = [
        cron(
            reconcile_abandoned_agent_runs,
            minute=set(range(60)),
            run_at_startup=True,
            job_id="flowcanvas:reconcile-abandoned-agent-runs",
            timeout=30,
        )
    ]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    on_startup = startup
    on_shutdown = shutdown
    after_job_end = after_job_end
    max_jobs = 4
    job_timeout = 300
    max_tries = MAX_AGENT_RUN_ATTEMPTS
    keep_result = 3600
    allow_abort_jobs = True
