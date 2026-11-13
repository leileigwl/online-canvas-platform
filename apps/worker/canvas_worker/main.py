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
    AgentSession,
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
    MockImageProvider,
    ReferenceImage,
    UnconfiguredImageProvider,
)
from canvas_api.security import decrypt_secret
from canvas_api.storage import ObjectStorage, create_storage
from canvas_api.tools import (
    TOOL_SPECS,
    PlanValidationError,
    validate_plan,
    verify_proposal_layout,
)
from langgraph.types import StreamWriter
from sqlalchemy import and_, func, or_, select, update

from canvas_worker.checkpoints import ensure_checkpointer_ready, open_checkpointer
from canvas_worker.orchestration import (
    AgentState,
    AutonomousAgentState,
    build_agent_graph,
    build_autonomous_graph,
)

AUTONOMOUS_LEAD_PROMPT = "\n".join(
    (
        (
            "你是 FlowCanvas 的自主主创作 Agent。你直接与用户对话，"
            "并在一个自由多步循环内按需决定思考、任务拆解、查看画布或执行设计。"
        ),
        "每轮只返回一个纯 JSON 对象，必须包含 action 字段，可选行动如下：",
        '1. {"action":"think","label":"简短过程标签","thought":"1-3句自由思考推理"}',
        (
            '2. {"action":"plan","layout_note":"构图与安全坐标说明",'
            '"tasks":["子步骤1","子步骤2"]}'
        ),
        '3. {"action":"inspect_canvas","reason":"查看画布对象与参考素材原因"}',
        (
            '4. {"action":"design_canvas","summary":"本轮操作概要",'
            '"operations":[{"tool":"add_note","params":{...}}]}'
        ),
        '5. {"action":"respond","summary":"一句总结","reply":"面向用户的自然简洁中文回复"}',
        (
            "设计工具白名单：add_note(title,content,x,y,width,height)；"
            "add_text(content,x,y,width,height,font_family,font_size,color)；"
            "move_object(object_id,x,y)；resize_object(object_id,width,height)；"
            "align_objects(object_ids,columns,gap)；"
            "add_shape(shape_kind,title,x,y,width,height,color)；"
            "generate_image(prompt,x,y,width,height,aspect_ratio,reference_object_ids)；"
            "edit_image(prompt,reference_object_ids,x,y,width,height,aspect_ratio)。"
        ),
        (
            "aspect_ratio 可选：auto,1:1,2:3,3:2,4:3,3:4,4:5,5:4,16:9,9:16,21:9,9:21。"
            "新增视觉与卡片请优先从 layout_anchors.right_clear_x 起步，保留 >=32px 间距，"
            "不要移动用户无关已有内容（如画笔涂鸦）。"
        ),
        (
            "强约束基准：若上下文中存在 pinned_user_values（不可压缩核心观点与硬参数，"
            "如专员情报、16:9比例、明确色彩尺寸、禁止事项等），"
            "这是最高优先级真值源，绝不可违背或擅自简化。"
        ),
        (
            "规则：简单问答可直接 respond；需要画布改动时调用 design_canvas，"
            "系统会自动执行确定性几何碰撞校验并把结果返回到你下一轮循环中。"
            "若校验失败，你必须再次调用 design_canvas 修正坐标后才可 respond。"
        ),
    )
)

COORDINATOR_PROMPT = "\n".join(
    (
        "你是 FlowCanvas Coordinator。分析目标并拆成最多 3 个可审阅的画布创作或生图子任务。",
        (
            '只返回 JSON：{"summary":"中文提案概述","thinking":"1-2句简明拆解思路","subtasks":'
            '[{"id":"task-1","title":"任务标题","goal":"明确工作目标","depends_on":[]}]}。'
        ),
        "按顺序使用 task-1、task-2、task-3 作为 id；依赖只填写已有的前置子任务 id。",
        (
            "文字说明卡片请用 add_note/add_text 工具，勿当作生图任务。"
            "新生成对象需直接确定最终无重叠坐标，不要再额外拆出『移动新生成对象』的后置任务。"
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
        "你是 FlowCanvas 上下文精炼与分离压缩器（类似 Claude Code / Devin 内存工程架构）。",
        "在上下文达到高阈值时，将历史输入与中间试错严格剥离为两个互斥模块：",
        (
            "1. pinned_user_values（不可压缩观点与硬参数）：从用户输入提取核心观点、"
            "专员情报、明确比例/色值/尺寸；执行语义融合与冲突覆写（新覆盖旧，去重合并），"
            "输出紧凑的黄金准则列表。"
        ),
        (
            "2. core_memory（因果经验与修剪摘要）：语义化修剪中间碰撞重算与冗长过程，"
            "提炼为高密度的因果决策简报（300字以内），保留最终修复经验。"
        ),
        '只返回纯 JSON：{"pinned_user_values":["准则1: ..."],"core_memory":"因果经验"}。',
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
        (
            "对齐/移动工具仅能针对当前画布已存在对象；若无明确要求不要挪动现有画笔涂鸦。"
            "新增图片与说明便签（add_note）请从上下文 layout_anchors.right_clear_x "
            "开始由左向右间隔 >=32px 排布。"
        ),
    )
)
EDITOR_PROMPT = "\n".join(
    (
        (
            "你是 FlowCanvas Canvas Editor。只负责完成当前分配给你的单个 subtask，"
            "严格不得替其他 subtask 生成重复图片或挪动无关对象，提出最多 12 个画布工具操作。"
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
            "关键参数（严禁多传未知字段）："
            "add_note(title,content,x,y,width,height)；"
            "add_text(content,x,y,width,height,font_family,font_size,color)；"
        ),
        (
            "move_object(object_id,x,y)；resize_object(object_id,width,height)；"
            "align_objects(object_ids,columns,gap)；"
        ),
        (
            "add_shape(shape_kind,title,x,y,width,height,color)；"
            "generate_image(prompt,x,y,width,height,aspect_ratio,reference_object_ids)；"
            "edit_image(prompt,reference_object_ids,x,y,width,height,aspect_ratio)。"
        ),
        (
            "aspect_ratio 可选: auto,1:1,2:3,3:2,4:3,3:4,4:5,5:4,16:9,9:16,21:9,9:21。"
            "说明/注释卡片请直接用 add_note，勿用 generate_image。"
        ),
        (
            "坐标放置必须避开 layout_anchors.existing_bounds 以及 already_placed_this_round"
            "（若提供 suggested_next_x，请优先从 suggested_next_x 起放置）。"
            "所有 object_id 必须来自 canvas 中真实已存在的 id；不得输出 URL、base64 或未登记工具。"
        ),
    )
)
REVIEWER_PROMPT = "\n".join(
    (
        (
            "你是 FlowCanvas Reviewer。结合确定性几何校验报告（verifier_report）、"
            "用户目标、layout_anchors 与 Planner 方案，审核本次提案。"
        ),
        '只返回 JSON：{"approved":true,"thinking":"审阅要点","feedback":"简短中文审阅意见"}。',
        (
            "裁决分工原则：verifier_report 是坐标重叠、最小间距与画布边界的唯一权威裁决。"
            "当 verifier_report.passed 为 true 时，严禁主观猜测“可能重叠/越界”而驳回，"
            "你只需检查是否偏离用户目标、文案/提示词质量、以及是否越权移动或删改无关已有对象；"
            "若语义与范围均合理，必须返回 approved=true。"
        ),
        (
            "仅当 verifier_report.passed 为 false，或明显偏离用户目标、"
            "越权移动/改动无关对象、生成内容严重违背要求时，"
            "返回 approved=false 并给出可执行的修改意见。"
        ),
    )
)
logger = logging.getLogger(__name__)
MAX_AGENT_RUN_ATTEMPTS = 3
MAX_SUBTASKS = 3
MAX_PARALLEL_SUBTASKS = 3
MAX_PROPOSAL_OPERATIONS = 12


def _model_for_role(config: dict | None, role: str) -> str:
    if not config:
        return "scripted-harness"
    return (config.get("role_models") or {}).get(role) or config["model"]


def _scripted_model_response(*, system: str, user: str, lab_scenario: str) -> dict:
    payload = json.loads(user)
    if "Memory Compactor" in system or "分离压缩器" in system:
        turns = payload.get("turns_to_compact") or []
        loop_steps = payload.get("loop_steps_to_compact") or []
        prev = str(payload.get("previous_core_memory") or "").strip()
        rejected = payload.get("rejected_patterns") or []
        pinned = list(payload.get("previous_pinned_user_values") or [])
        cur_g = str(payload.get("current_goal") or "")
        all_goals = ([cur_g] if cur_g else []) + [str(t.get("goal") or "") for t in turns]
        for g in all_goals:
            if not g:
                continue
            if "16:9" in g and "比例参数：保持 16:9 比例" not in pinned:
                pinned.append("比例参数：保持 16:9 比例")
            if "暖象牙" in g and "视觉偏好：极简暖象牙调 (#F5E8D0)" not in pinned:
                pinned.append("视觉偏好：极简暖象牙调 (#F5E8D0)")
            if ("核磁共振" in g or "专员" in g) and (
                "专员情报：关注对比度与严谨边界排布" not in pinned
            ):
                pinned.append("专员情报：关注对比度与严谨边界排布")
            if "猫" in g and not any("猫" in p for p in pinned):
                pinned.append("主体设定：卡通小猫/萌宠元素")
        if not pinned and all_goals:
            pinned.append(f"核心目标约束：{str(all_goals[-1])[:60]}")

        summary_lines = [
            f"[{t.get('decision', 'proposed')}] {str(t.get('goal', ''))[:60]}"
            for t in turns[-4:]
        ]
        if loop_steps:
            summary_lines.extend(
                f"[因果记录] {str(s.get('action', 'step'))}: {str(s.get('content', ''))[:50]}"
                for s in loop_steps[-3:]
            )
        if prev:
            summary_lines.insert(0, prev[:200])
        if rejected:
            summary_lines.append("规避否决: " + "; ".join(str(x)[:40] for x in rejected[-3:]))
        return {
            "pinned_user_values": pinned[:8],
            "core_memory": " | ".join(summary_lines)[:500] or "已完成历史试错修剪与因果蒸馏",
        }

    if "自主主创作 Agent" in system:
        goal = str(payload.get("goal") or "创意排版与生图")
        step = int(payload.get("step") or 0)
        canvas_items = payload.get("canvas") or []
        anchors = payload.get("layout_anchors") or {}
        base_x = float(anchors.get("right_clear_x") or -120.0)
        suggested_y = float(anchors.get("suggested_y") or -120.0)
        ref_ids = [
            it["id"] for it in canvas_items if it.get("type") == "image" and it.get("id")
        ][:1]
        verifier_report = payload.get("verifier_report") or {}

        if step == 0:
            return {
                "action": "think",
                "label": "理解需求与检查上下文",
                "thought": (
                    f"先结合云端记忆与画布现状理解用户意图：「{goal[:80]}」，"
                    f"确定新内容安全起笔坐标 x={base_x}。"
                ),
            }

        if lab_scenario == "memory_compaction":
            if step == 1:
                return {
                    "action": "plan",
                    "layout_note": (
                        f"从右侧安全位置 x={base_x} 起排列主图与便签，保留 >=32px 呼吸感"
                    ),
                    "tasks": ["分析历史记忆延续视觉语调", "右侧无碰撞排版视觉主图与设计说明"],
                }
            if step == 2:
                return {
                    "action": "inspect_canvas",
                    "reason": "补充检查已有对象属性并触发多轮上下文累积观测",
                }
            if step == 3:
                return {
                    "action": "design_canvas",
                    "summary": f"延续记忆生成并排布：{goal[:36]}",
                    "operations": [
                        {
                            "tool": "edit_image" if ref_ids else "generate_image",
                            "params": {
                                "prompt": goal[:300],
                                **({"reference_object_ids": ref_ids} if ref_ids else {}),
                                "x": base_x,
                                "y": suggested_y,
                                "width": 240,
                                "height": 320,
                                "aspect_ratio": "3:4",
                            },
                        },
                        {
                            "tool": "add_note",
                            "params": {
                                "title": "延续设计说明",
                                "content": f"响应需求：{goal[:80]}（已继承云端记忆并避开碰撞）",
                                "x": round(base_x + 280, 1),
                                "y": suggested_y,
                                "width": 220,
                                "height": 140,
                            },
                        },
                    ],
                }
            return {
                "action": "respond",
                "summary": f"已按记忆上下文完成「{goal[:32]}」排布",
                "reply": (
                    "我已在循环过程中自动将较早上下文蒸馏写入云端记忆，"
                    f"并在右侧安全区（x={base_x} 起）为你生成了视觉主图与设计说明卡（无重叠）。"
                ),
            }

        if lab_scenario == "collision_repair":
            if step == 1:
                return {
                    "action": "design_canvas",
                    "summary": f"首轮探索布局：{goal[:30]}",
                    "operations": [
                        {
                            "tool": "edit_image" if ref_ids else "generate_image",
                            "params": {
                                "prompt": goal[:300],
                                **({"reference_object_ids": ref_ids} if ref_ids else {}),
                                "x": 0,
                                "y": -80,
                                "width": 260,
                                "height": 320,
                                "aspect_ratio": "3:4",
                            },
                        },
                        {
                            "tool": "add_note",
                            "params": {
                                "title": "设计说明",
                                "content": f"响应需求：{goal[:80]}",
                                "x": 40,
                                "y": -20,
                                "width": 240,
                                "height": 160,
                            },
                        },
                    ],
                }
            if step == 2 and verifier_report.get("passed") is False:
                return {
                    "action": "design_canvas",
                    "summary": f"已自动避让重排：{goal[:30]}",
                    "operations": [
                        {
                            "tool": "edit_image" if ref_ids else "generate_image",
                            "params": {
                                "prompt": goal[:300],
                                **({"reference_object_ids": ref_ids} if ref_ids else {}),
                                "x": base_x,
                                "y": suggested_y,
                                "width": 240,
                                "height": 320,
                                "aspect_ratio": "3:4",
                            },
                        },
                        {
                            "tool": "add_note",
                            "params": {
                                "title": "设计说明",
                                "content": f"响应需求：{goal[:80]}",
                                "x": round(base_x + 280, 1),
                                "y": suggested_y,
                                "width": 220,
                                "height": 140,
                            },
                        },
                    ],
                }
            return {
                "action": "respond",
                "summary": f"完成碰撞自动修复并生成「{goal[:30]}」",
                "reply": (
                    "首轮检测到元素碰撞，我已根据确定性几何反馈在循环内自行将卡片移至右侧安全间距"
                    f"（x={base_x} 与 x={round(base_x + 280, 1)}），现已通过校验。"
                ),
            }

        # Default normal scenario in autonomous loop
        if step == 1:
            return {
                "action": "design_canvas",
                "summary": f"生成并排版：{goal[:36]}",
                "operations": [
                    {
                        "tool": "edit_image" if ref_ids else "generate_image",
                        "params": {
                            "prompt": goal[:300],
                            **({"reference_object_ids": ref_ids} if ref_ids else {}),
                            "x": base_x,
                            "y": suggested_y,
                            "width": 240,
                            "height": 320,
                            "aspect_ratio": "3:4",
                        },
                    },
                    {
                        "tool": "add_note",
                        "params": {
                            "title": "设计说明",
                            "content": f"围绕「{goal[:60]}」构图排版，留出 40px 间距。",
                            "x": round(base_x + 280, 1),
                            "y": suggested_y,
                            "width": 220,
                            "height": 140,
                        },
                    },
                ],
            }
        return {
            "action": "respond",
            "summary": f"完成「{goal[:32]}」设计提案",
            "reply": (
                f"我已经围绕「{goal[:50]}」在画布右侧安全区域完成了图像生成与说明卡片排布，"
                "并通过了无碰撞校验，你可以直接预览或一键应用到画布。"
            ),
        }

    if "FlowCanvas Coordinator" in system:
        goal = str(payload.get("goal") or "创意排版与生图")
        return {
            "summary": f"协同生成并排版：{goal[:40]}",
            "thinking": (
                f"按设计目标拆分为「生图生成」与「注释排版」两个有序子任务"
                f"（场景：{lab_scenario}）。"
            ),
            "subtasks": [
                {
                    "id": "task-1",
                    "title": "生成视觉主图",
                    "goal": f"根据目标生成核心视觉图像：{goal[:180]}",
                    "depends_on": [],
                },
                {
                    "id": "task-2",
                    "title": "补充版式说明便签",
                    "goal": "在生成主图右侧生成配套设计说明便签，保持间距与构图呼吸感。",
                    "depends_on": ["task-1"],
                },
            ],
        }

    if "FlowCanvas Planner" in system:
        subtasks = payload.get("subtasks") or []
        return {
            "thinking": (
                "先定位当前画布空余右缘区域，主图采用 3:4 比例，"
                "说明卡片保留 32px 水平安全间距。"
            ),
            "plans": [
                {
                    "task_id": t["id"],
                    "plan": (
                        "在安全空位生成 240x320 主图"
                        if t["id"] == "task-1"
                        else "在主图右侧保留 >=32px 间距摆放 240x160 说明便签"
                    ),
                }
                for t in subtasks
            ],
        }

    if "FlowCanvas Canvas Editor" in system:
        subtask = payload.get("subtask") or {}
        attempt = int(payload.get("attempt") or 0)
        canvas_items = payload.get("canvas") or []
        existing_max_x = max(
            (float(it.get("x", 0)) + float(it.get("width", 0)) for it in canvas_items),
            default=-120.0,
        )
        base_x = round(existing_max_x + 48, 1) if canvas_items else -120.0
        task_id = subtask.get("id", "task-1")
        ref_ids = [
            it["id"]
            for it in canvas_items
            if it.get("type") == "image" and it.get("id")
        ][:1]

        if task_id == "task-1":
            if lab_scenario == "collision_repair" and attempt == 0:
                return {
                    "thinking": (
                        "尝试第 1 轮先在基准坐标 (0, -80) 放置主图，"
                        "等待 Verifier 与 Reviewer 检查边界。"
                    ),
                    "operations": [
                        {
                            "tool": "edit_image" if ref_ids else "generate_image",
                            "params": {
                                "prompt": str(payload.get("goal") or "Warm editorial still life"),
                                **({"reference_object_ids": ref_ids} if ref_ids else {}),
                                "x": 0,
                                "y": -80,
                                "width": 260,
                                "height": 320,
                                "aspect_ratio": "3:4",
                            },
                        }
                    ],
                }
            return {
                "thinking": (
                    f"第 {attempt + 1} 轮根据校验反馈将主图安全放置于 x={base_x} 空闲画廊区域。"
                ),
                "operations": [
                    {
                        "tool": "edit_image" if ref_ids else "generate_image",
                        "params": {
                            "prompt": str(payload.get("goal") or "Warm editorial still life"),
                            **({"reference_object_ids": ref_ids} if ref_ids else {}),
                            "x": base_x,
                            "y": -140,
                            "width": 240,
                            "height": 320,
                            "aspect_ratio": "3:4",
                        },
                    }
                ],
            }

        # task-2 note placement
        if lab_scenario == "collision_repair" and attempt == 0:
            return {
                "thinking": (
                    "第 1 轮故意在 (40, -20) 放置便签，"
                    "测试确定性几何校验器能否拦截重叠冲突。"
                ),
                "operations": [
                    {
                        "tool": "add_note",
                        "params": {
                            "title": "设计企划注释",
                            "content": f"响应目标：{str(payload.get('goal') or '')[:80]}",
                            "x": 40,
                            "y": -20,
                            "width": 240,
                            "height": 160,
                        },
                    }
                ],
            }
        dep_ops = (payload.get("completed_dependency_operations") or {}).get("task-1") or []
        anchor_x = base_x
        if dep_ops:
            dp = dep_ops[0].get("params") or {}
            anchor_x = float(dp.get("x", base_x)) + float(dp.get("width", 240)) + 32
        return {
            "thinking": (
                f"第 {attempt + 1} 轮读取前置生成图边界"
                f"并在 x={round(anchor_x, 1)} 无重叠摆放说明便签。"
            ),
            "operations": [
                {
                    "tool": "add_note",
                    "params": {
                        "title": "Harness 闭环设计说明",
                        "content": (
                            f"目标：{str(payload.get('goal') or '')[:80]}\n"
                            f"闭环轮次：第 {attempt + 1} 轮（无重叠碰撞）"
                        ),
                        "x": round(anchor_x, 1),
                        "y": -140,
                        "width": 240,
                        "height": 160,
                    },
                }
            ],
        }

    # Reviewer role
    verifier_report = payload.get("verifier_report") or {"passed": True, "issues": []}
    if not verifier_report.get("passed", True):
        issues = verifier_report.get("issues") or []
        msg = "；".join(str(it.get("message") or "") for it in issues[:2])
        suggestion = "；".join(str(it.get("suggestion") or "") for it in issues[:2])
        return {
            "approved": False,
            "thinking": f"确定性几何校验器发现 {len(issues)} 处布局问题，打回 Canvas Editor 修复。",
            "feedback": f"检测到布局碰撞：{msg}。{suggestion}",
        }
    return {
        "approved": True,
        "thinking": "确定性几何校验与白名单工具审阅均通过，无元素重叠或越界。",
        "feedback": "布局间距合理、工具契约合规，审阅通过。",
    }


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
            raw_cid = generation_settings.get("config_id")
            try:
                gen_config_id = uuid.UUID(str(raw_cid)) if raw_cid else None
            except ValueError:
                gen_config_id = None
            async with session_factory() as session:
                provider = await resolve_user_image_provider(
                    session,
                    owner_id,
                    settings,
                    fallback=fallback_provider,
                    requested_model=str(generation_settings.get("model") or ""),
                    config_id=gen_config_id,
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
                max_image_bytes=max_upload_bytes,
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
        harness_options = dict(run.harness_options or {})
        session_uuid = run.session_id
        llm_mode = str(harness_options.get("llm_mode") or "real")
        loop_mode = str(
            harness_options.get("loop_mode")
            or (
                "autonomous"
                if session_uuid is not None or "loop_mode" in harness_options
                else "pipeline"
            )
        )
        use_mock_image = bool(harness_options.get("use_mock_image", False))
        image_engine = str(
            harness_options.get("image_engine")
            or ("mock" if use_mock_image else "local-mflux")
        )
        if image_engine == "mock":
            use_mock_image = True
        elif image_engine == "local-mflux":
            use_mock_image = False
        lab_scenario = str(harness_options.get("lab_scenario") or "normal")
        force_compact = bool(harness_options.get("force_compact", False))
        max_repair_rounds = max(0, min(3, int(harness_options.get("max_repair_rounds", 2))))
        max_loop_steps = max(2, min(16, int(harness_options.get("max_loop_steps", 10))))
        compaction_threshold_pct = max(
            5, min(95, int(harness_options.get("compaction_threshold_pct", 85)))
        )
        completion_tokens_per_call = run.completion_tokens_per_call
        model_config = await session.scalar(
            select(ModelConfig).where(ModelConfig.owner_id == run.owner_id)
        )
        if model_config is None and generation_settings is None and llm_mode != "scripted":
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

    # Build persistent + compacted multi-turn memory (isolated per AgentSession when set)
    async with session_factory() as mem_session:
        if session_uuid is not None:
            session_mem = await mem_session.scalar(
                select(AgentSession).where(
                    AgentSession.id == session_uuid, AgentSession.owner_id == owner_id
                )
            )
            run_stmt = select(AgentRun).where(
                AgentRun.owner_id == owner_id,
                AgentRun.session_id == session_uuid,
                AgentRun.id != run_uuid,
                AgentRun.status.in_((RunStatus.SUCCEEDED, RunStatus.FAILED)),
            )
            if session_mem is not None and session_mem.chat_cleared_at is not None:
                run_stmt = run_stmt.where(AgentRun.created_at > session_mem.chat_cleared_at)
            prior_runs = list(
                await mem_session.scalars(run_stmt.order_by(AgentRun.created_at.asc()))
            )
            memory_source = session_mem
        else:
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
                        AgentRun.status.in_((RunStatus.SUCCEEDED, RunStatus.FAILED)),
                    )
                    .order_by(AgentRun.created_at.asc())
                )
            )
            memory_source = memory
    anchor_id = memory_source.last_compacted_run_id if memory_source else None
    recent_runs = prior_runs
    if anchor_id:
        anchor_idx = next((idx for idx, item in enumerate(prior_runs) if item.id == anchor_id), -1)
        if anchor_idx >= 0:
            recent_runs = prior_runs[anchor_idx + 1 :]
    compacted_summary = memory_source.compacted_summary if memory_source else ""
    rejected_patterns = list(memory_source.rejected_feedback or []) if memory_source else []
    pinned_user_values = (
        list(memory_source.pinned_user_values or []) if memory_source else []
    )
    recent_payload = [_summarize_turn(r) for r in recent_runs]
    canvas_brief = _canvas_summary(canvas_items)
    visible_boxes = [
        it
        for it in canvas_brief
        if isinstance(it.get("x"), (int, float))
        and isinstance(it.get("y"), (int, float))
        and isinstance(it.get("width"), (int, float))
        and isinstance(it.get("height"), (int, float))
    ]
    if visible_boxes:
        min_x = round(min(float(it["x"]) for it in visible_boxes), 1)
        min_y = round(min(float(it["y"]) for it in visible_boxes), 1)
        max_x = round(max(float(it["x"]) + float(it["width"]) for it in visible_boxes), 1)
        max_y = round(max(float(it["y"]) + float(it["height"]) for it in visible_boxes), 1)
    else:
        min_x, min_y, max_x, max_y = 0.0, 0.0, 0.0, 0.0
    layout_anchors = {
        "existing_bounds": {"min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y},
        "right_clear_x": round(max_x + 48, 1) if visible_boxes else -160.0,
        "suggested_y": round(max(-160.0, min(min_y, 0.0)), 1) if visible_boxes else -120.0,
        "below_clear_y": round(max_y + 48, 1) if visible_boxes else 160.0,
    }
    system_prompts_tokens = 620
    pinned_tokens = len(json.dumps(pinned_user_values, ensure_ascii=False)) // 3
    canvas_tokens = len(json.dumps(canvas_brief, ensure_ascii=False)) // 3
    core_memory_tokens = (
        len(compacted_summary) + len(json.dumps(rejected_patterns, ensure_ascii=False))
    ) // 3
    recent_turns_tokens = len(json.dumps(recent_payload, ensure_ascii=False)) // 3
    approx_tokens = (
        system_prompts_tokens
        + pinned_tokens
        + canvas_tokens
        + core_memory_tokens
        + recent_turns_tokens
    )
    compact_threshold = int(max_context_tokens * (compaction_threshold_pct / 100.0))

    user_context = {
        "goal": goal,
        "pinned_user_values": pinned_user_values,
        "context_revision": context_revision,
        "canvas": canvas_brief,
        "layout_anchors": layout_anchors,
        "authorized_reference_image_metadata": references,
        "harness_memory": {
            "pinned_user_values": pinned_user_values,
            "core_summary": compacted_summary,
            "rejected_patterns": rejected_patterns,
            "recent_turns": recent_payload,
        },
    }

    materialized_cache: dict[tuple, dict] = {}

    async def materialize_image_op(operation: dict) -> dict:
        params = operation["params"]
        ref_object_ids = params.get("reference_object_ids", [])
        cache_key = (
            operation["tool"],
            params["prompt"],
            tuple(str(oid) for oid in ref_object_ids),
            params.get("aspect_ratio", "auto"),
        )
        if cache_key in materialized_cache:
            return {**operation, "result": materialized_cache[cache_key]}
        items_by_id = {item["id"]: item for item in canvas_items if isinstance(item, dict)}
        ordered_asset_ids = [
            uuid.UUID(str(items_by_id[oid]["asset_id"]))
            for oid in ref_object_ids
            if items_by_id.get(oid) and items_by_id[oid].get("asset_id")
        ]
        async with session_factory() as session:
            if use_mock_image:
                img_provider = MockImageProvider(latency_ms=80)
            else:
                img_provider = await resolve_user_image_provider(
                    session,
                    owner_id,
                    settings,
                    fallback=fallback_img_provider,
                    requested_model=(
                        "RunPod/FLUX.2-klein-4B-mflux-4bit"
                        if image_engine == "local-mflux"
                        else None
                    ),
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
            max_image_bytes=settings.max_upload_bytes,
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
        result_meta = {
            "asset_id": str(asset.id),
            "src": f"/api/assets/{asset.id}/content",
            "width": asset.width,
            "height": asset.height,
            "title": asset.name,
        }
        materialized_cache[cache_key] = result_meta
        return {**operation, "result": result_meta}

    async def call_model_with_meta(*, model: str, system: str, user: str) -> tuple[dict, dict]:
        # Reserve before contacting the provider so ARQ retries and Worker restarts
        # consume the same durable per-run allowance.
        await _reserve_agent_model_call(session_factory, run_uuid)
        started_at = asyncio.get_running_loop().time()

        if llm_mode == "scripted" or model_config_data is None:
            content = _scripted_model_response(
                system=system, user=user, lab_scenario=lab_scenario
            )
            elapsed_ms = max(1, round((asyncio.get_running_loop().time() - started_at) * 1000))
            return content, {
                "model": "scripted-harness",
                "prompt_tokens": len(system + user) // 3,
                "completion_tokens": len(json.dumps(content, ensure_ascii=False)) // 3,
                "duration_ms": elapsed_ms,
            }

        response = await provider.complete_json(
            base_url=model_config_data["base_url"],
            api_key=model_config_data["api_key"],
            model=model,
            system=system,
            user=user,
            max_output_tokens=completion_tokens_per_call,
            token_limit_field=settings.chat_completion_token_limit_field,
        )
        elapsed_ms = max(1, round((asyncio.get_running_loop().time() - started_at) * 1000))
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
        return response.content, {
            "model": model,
            "prompt_tokens": response.prompt_tokens or (len(system + user) // 3),
            "completion_tokens": response.completion_tokens
            or (len(json.dumps(response.content, ensure_ascii=False)) // 3),
            "duration_ms": elapsed_ms,
        }

    async def call_model(*, model: str, system: str, user: str) -> dict:
        content, _ = await call_model_with_meta(model=model, system=system, user=user)
        return content

    def _emit_context_snapshot(
        writer: StreamWriter,
        *,
        phase: str,
        compacted: bool,
        live_loop_tokens: int = 0,
        saved_tokens: int = 0,
    ) -> None:
        current_pinned_tokens = (
            len(json.dumps(pinned_user_values, ensure_ascii=False)) // 3
        )
        current_core_tokens = (
            len(compacted_summary) + len(json.dumps(rejected_patterns, ensure_ascii=False))
        ) // 3
        current_recent_tokens = (
            len(json.dumps(user_context["harness_memory"]["recent_turns"], ensure_ascii=False))
            // 3
        )
        total_tok = (
            system_prompts_tokens
            + current_pinned_tokens
            + canvas_tokens
            + current_core_tokens
            + current_recent_tokens
            + live_loop_tokens
        )
        writer(
            {
                "kind": "context",
                "role": "Harness Context",
                "phase": phase,
                "compacted": compacted,
                "compacted_saved_tokens": saved_tokens,
                "title": (
                    f"上下文快照（{phase} · {total_tok}/{max_context_tokens} tokens）"
                ),
                "text": (
                    f"系统 ~{system_prompts_tokens} · 观点/参数 ~{current_pinned_tokens} · "
                    f"画布 ~{canvas_tokens} · 云端记忆 ~{current_core_tokens} · "
                    f"近期对话 ~{current_recent_tokens}"
                    + (f" · 循环过程 ~{live_loop_tokens}" if live_loop_tokens else "")
                    + " tok"
                ),
                "breakdown": {
                    "system_prompts_tokens": system_prompts_tokens,
                    "pinned_values_tokens": current_pinned_tokens,
                    "canvas_brief_tokens": canvas_tokens,
                    "core_memory_tokens": current_core_tokens,
                    "recent_turns_tokens": current_recent_tokens,
                    "live_run_tokens": live_loop_tokens,
                    "total_estimated_tokens": total_tok,
                    "compaction_threshold_tokens": compact_threshold,
                    "compaction_threshold_pct": compaction_threshold_pct,
                    "max_context_tokens": max_context_tokens,
                },
                "memory_preview": user_context["harness_memory"],
            }
        )

    async def _save_compacted_row(
        mem_save,
        *,
        new_summary: str,
        compacted_delta: int,
        last_run_id: uuid.UUID | None,
        est_tokens: int,
        pinned_values: list[str] | None = None,
    ) -> None:
        if session_uuid is not None:
            sess_row = await mem_save.scalar(
                select(AgentSession)
                .where(AgentSession.id == session_uuid, AgentSession.owner_id == owner_id)
                .with_for_update()
            )
            if sess_row is not None:
                sess_row.compacted_summary = new_summary
                sess_row.compacted_run_count = (
                    sess_row.compacted_run_count or 0
                ) + compacted_delta
                if last_run_id is not None:
                    sess_row.last_compacted_run_id = last_run_id
                sess_row.estimated_tokens = est_tokens
                if pinned_values is not None:
                    sess_row.pinned_user_values = pinned_values
            return
        row = await mem_save.scalar(
            select(CanvasMemory)
            .where(CanvasMemory.owner_id == owner_id, CanvasMemory.canvas_id == canvas_uuid)
            .with_for_update()
        )
        if row is None:
            row = CanvasMemory(
                owner_id=owner_id,
                canvas_id=canvas_uuid,
                compacted_summary=new_summary,
                compacted_run_count=compacted_delta,
                last_compacted_run_id=last_run_id,
                estimated_tokens=est_tokens,
                rejected_feedback=rejected_patterns,
                pinned_user_values=pinned_values or [],
            )
            mem_save.add(row)
        else:
            row.compacted_summary = new_summary
            row.compacted_run_count = (row.compacted_run_count or 0) + compacted_delta
            if last_run_id is not None:
                row.last_compacted_run_id = last_run_id
            row.estimated_tokens = est_tokens
            if pinned_values is not None:
                row.pinned_user_values = pinned_values

    async def _maybe_compact_harness_memory(writer: StreamWriter) -> None:
        nonlocal compacted_summary, approx_tokens, pinned_user_values
        should_compact = (
            (force_compact and len(recent_runs) >= 1)
            or (lab_scenario == "memory_compaction" and len(recent_runs) >= 1)
            or (
                len(recent_runs) > 2
                and (len(recent_runs) >= 6 or approx_tokens >= compact_threshold)
            )
        )
        if not should_compact:
            if force_compact and len(recent_runs) == 0:
                writer(
                    {
                        "kind": "thinking",
                        "role": "Harness Memory",
                        "title": "Harness 记忆预检",
                        "text": "当前画布尚无历史完成轮次，本轮结果将在结束后进入近期记忆窗口。",
                    }
                )
            return
        keep_tail = (
            1
            if (force_compact or lab_scenario == "memory_compaction") and len(recent_runs) <= 2
            else 2
        )
        head_runs = recent_runs[:-keep_tail] if len(recent_runs) > keep_tail else recent_runs
        tail_runs = recent_runs[-keep_tail:] if len(recent_runs) > keep_tail else []
        tail_payload = [_summarize_turn(r) for r in tail_runs]
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
                    "current_goal": goal,
                    "previous_pinned_user_values": pinned_user_values,
                    "previous_core_memory": compacted_summary,
                    "rejected_patterns": rejected_patterns,
                    "turns_to_compact": [_summarize_turn(r) for r in head_runs],
                },
                ensure_ascii=False,
            ),
        )
        ext_pinned = compacted.get("pinned_user_values")
        if isinstance(ext_pinned, list) and ext_pinned:
            pinned_user_values = [str(x).strip() for x in ext_pinned if str(x).strip()][:15]
        new_core = str(compacted.get("core_memory") or compacted_summary).strip()[:1200]
        compacted_summary = new_core
        approx_tokens = (
            len(compacted_summary)
            + len(json.dumps(pinned_user_values, ensure_ascii=False))
            + len(json.dumps(tail_payload, ensure_ascii=False))
            + len(json.dumps(canvas_brief, ensure_ascii=False))
        ) // 3
        async with session_factory() as mem_save:
            await _save_compacted_row(
                mem_save,
                new_summary=compacted_summary,
                compacted_delta=len(head_runs),
                last_run_id=head_runs[-1].id,
                est_tokens=approx_tokens,
                pinned_values=pinned_user_values,
            )
            await mem_save.commit()
        user_context["pinned_user_values"] = pinned_user_values
        user_context["harness_memory"] = {
            "pinned_user_values": pinned_user_values,
            "core_summary": compacted_summary,
            "rejected_patterns": rejected_patterns,
            "recent_turns": tail_payload,
        }
        _emit_context_snapshot(writer, phase="记忆压缩后", compacted=True)

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
            _emit_context_snapshot(writer, phase="初始注入", compacted=False)
            await _maybe_compact_harness_memory(writer)
            writer(
                {
                    "kind": "thinking",
                    "role": "Coordinator",
                    "title": "理解创作目标与画布上下文",
                    "text": f"正在分析目标「{goal[:80]}」与当前 {len(canvas_items)} 个画布对象...",
                }
            )
            response, coord_meta = await call_model_with_meta(
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
            output = {"summary": summary, "subtasks": subtasks, "_meta": coord_meta}
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
            response, plan_meta = await call_model_with_meta(
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
            output = {"plans": plans, "_meta": plan_meta}
            if not await set_task_state(1, RunStatus.SUCCEEDED, output):
                raise RunCanceled
        saved_plans = [{"task_id": key, "plan": value} for key, value in output["plans"].items()]
        plans = _validate_plans({"plans": saved_plans}, state["subtasks"])
        return {"plans": plans}

    async def canvas_editor(state: AgentState, writer: StreamWriter) -> dict:
        attempt = int(state.get("attempt") or 0)
        review_feedback = str(state.get("review_feedback") or "")
        verifier_issues = list((state.get("verifier_report") or {}).get("issues") or [])
        prior_round_by_task = dict(state.get("editor_outputs") or {})
        placed_this_round: list[dict] = []

        def _record_placed(ops_list: list[dict]) -> None:
            for op in ops_list:
                p = op.get("params") or {}
                if "x" in p and "y" in p:
                    placed_this_round.append(
                        {
                            "tool": op["tool"],
                            "x": p.get("x"),
                            "y": p.get("y"),
                            "width": p.get("width", 220),
                            "height": p.get("height", 140),
                        }
                    )

        async def run_editor(
            task: dict,
            sequence: int,
            prior_outputs: dict[str, list[dict]],
        ) -> tuple[str, list[dict]]:
            existing = await _task_record(session_factory, run_uuid, sequence)
            if attempt == 0 and existing and existing["status"] == RunStatus.SUCCEEDED:
                saved = existing["output"] or {}
                operations = validate_plan(
                    saved.get("operations", []), canvas_items, allow_result=True
                )
                return task["id"], operations
            if not await set_task_state(sequence, RunStatus.RUNNING):
                raise RunCanceled
            right_x = float(layout_anchors["right_clear_x"])
            if placed_this_round:
                right_x = max(
                    right_x,
                    max(
                        float(b["x"]) + float(b["width"]) + 32
                        for b in placed_this_round
                    ),
                )
            edit_context = {
                **user_context,
                "subtask": task,
                "planner_plan": state["plans"][task["id"]],
                "attempt": attempt,
                "review_feedback": review_feedback,
                "verifier_issues": verifier_issues,
                "my_previous_operations": prior_round_by_task.get(task["id"], []),
                "already_placed_this_round": list(placed_this_round),
                "suggested_next_x": round(right_x, 1),
                "completed_dependency_operations": {
                    dep: prior_outputs.get(dep, []) for dep in task["depends_on"]
                },
            }
            response, editor_meta = await call_model_with_meta(
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
            try:
                operations = validate_plan(response.get("operations", []), canvas_items)
            except PlanValidationError as schema_err:
                writer(
                    {
                        "kind": "thinking",
                        "role": "Canvas Editor",
                        "title": f"{task['title']}（参数自修复重试）",
                        "text": (
                            f"工具参数未通过白名单校验：{schema_err}，"
                            "正携带精确错误信息原地重写..."
                        ),
                    }
                )
                repair_ctx = {
                    **edit_context,
                    "schema_repair_error": str(schema_err),
                    "previous_invalid_operations": response.get("operations"),
                }
                response, editor_meta = await call_model_with_meta(
                    model=_model_for_role(model_config_data, "Canvas Editor"),
                    system=EDITOR_PROMPT,
                    user=json.dumps(repair_ctx, ensure_ascii=False),
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
                {
                    "operation_count": len(finalized_ops),
                    "operations": finalized_ops,
                    "_meta": editor_meta,
                },
            ):
                raise RunCanceled
            return task["id"], finalized_ops

        task_sequences = {
            task["id"]: index for index, task in enumerate(state["subtasks"], start=2)
        }
        editor_outputs: dict[str, list[dict]] = {}
        for wave in _editor_waves(state["subtasks"]):
            if attempt > 0 and len(wave) > 1:
                for task in wave:
                    tid, task_ops = await run_editor(
                        task, task_sequences[task["id"]], editor_outputs
                    )
                    editor_outputs[tid] = task_ops
                    _record_placed(task_ops)
            else:
                results = await asyncio.gather(
                    *(
                        run_editor(task, task_sequences[task["id"]], editor_outputs)
                        for task in wave
                    ),
                    return_exceptions=True,
                )
                errors = [result for result in results if isinstance(result, BaseException)]
                if errors:
                    raise errors[0]
                for tid, task_ops in results:  # type: ignore[misc]
                    editor_outputs[tid] = task_ops
                    _record_placed(task_ops)

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

    async def verifier(state: AgentState, writer: StreamWriter) -> dict:
        attempt = int(state.get("attempt") or 0)
        report = verify_proposal_layout(canvas_items, state["operations"])
        summary_report = {k: v for k, v in report.items() if k != "preview_items"}
        issues = summary_report.get("issues") or []
        writer(
            {
                "kind": "verifier",
                "role": "Verifier",
                "attempt": attempt + 1,
                "title": (
                    f"第 {attempt + 1} 轮几何与契约校验通过"
                    if summary_report["passed"]
                    else f"第 {attempt + 1} 轮发现 {len(issues)} 项布局问题"
                ),
                "text": (
                    "无碰撞重叠与越界，准许进入 Reviewer 终审。"
                    if summary_report["passed"]
                    else "；".join(str(it.get("message") or "") for it in issues[:3])
                ),
                **summary_report,
            }
        )
        return {"verifier_report": summary_report}

    async def reviewer(state: AgentState, writer: StreamWriter) -> dict:
        attempt = int(state.get("attempt") or 0)
        max_repairs = int(
            state.get("max_repair_rounds")
            if state.get("max_repair_rounds") is not None
            else max_repair_rounds
        )
        sequence = len(state["subtasks"]) + 2
        existing = await _task_record(session_factory, run_uuid, sequence)
        output = (
            existing["output"]
            if attempt == 0 and existing and existing["status"] == RunStatus.SUCCEEDED
            else None
        )
        if output is not None:
            return {"review": {**output, "needs_repair": False}}
        if not await set_task_state(sequence, RunStatus.RUNNING):
            raise RunCanceled
        verifier_report = state.get("verifier_report") or {"passed": True, "issues": []}
        writer(
            {
                "kind": "thinking",
                "role": "Reviewer",
                "title": f"安全与质量审阅（第 {attempt + 1} 轮）",
                "text": f"正在结合确定性几何报告核验 {len(state['operations'])} 项画布操作...",
            }
        )
        review_context = {
            **user_context,
            "attempt": attempt,
            "subtasks": state["subtasks"],
            "planner_plans": state["plans"],
            "editor_outputs": state["editor_outputs"],
            "operations": state["operations"],
            "verifier_report": verifier_report,
        }
        response, review_meta = await call_model_with_meta(
            model=_model_for_role(model_config_data, "Reviewer"),
            system=REVIEWER_PROMPT,
            user=json.dumps(review_context, ensure_ascii=False),
        )
        approved = response.get("approved")
        feedback = str(response.get("feedback") or "")
        if not isinstance(approved, bool):
            raise ProviderError("Reviewer 没有返回有效审阅结果")
        if not verifier_report.get("passed", True):
            approved = False
            issue_text = "；".join(
                str(it.get("message") or "") + " " + str(it.get("suggestion") or "")
                for it in (verifier_report.get("issues") or [])[:3]
            ).strip()
            if issue_text and not any(
                str(it.get("message") or "")[:12] in feedback
                for it in (verifier_report.get("issues") or [])[:1]
            ):
                feedback = f"{feedback} {issue_text}".strip()

        next_history = [
            *(state.get("repair_history") or []),
            {
                "round": attempt + 1,
                "verifier_passed": bool(verifier_report.get("passed", True)),
                "issue_count": int(verifier_report.get("issue_count", 0)),
                "approved": approved,
                "feedback": feedback[:300],
            },
        ]
        if not approved and attempt < max_repairs:
            writer(
                {
                    "kind": "thinking",
                    "role": "Reviewer",
                    "title": f"第 {attempt + 1} 轮驳回，触发自动自修复闭环",
                    "text": feedback[:400] or "发现布局或规则问题，打回 Canvas Editor 重试。",
                }
            )
            return {
                "attempt": attempt + 1,
                "review_feedback": feedback[:500],
                "repair_history": next_history,
                "review": {
                    "approved": False,
                    "needs_repair": True,
                    "feedback": feedback[:500],
                    "verifier_issues": verifier_report.get("issues") or [],
                },
            }

        review_summary = {
            "approved": bool(approved),
            "passed_verifier": bool(verifier_report.get("passed", True)),
            "attempt_count": attempt + 1,
            "needs_manual_review": not bool(approved),
            "feedback": feedback[:500],
            "verifier_issues": verifier_report.get("issues") or [],
            "_meta": review_meta,
        }
        if not await set_task_state(sequence, RunStatus.SUCCEEDED, review_summary):
            raise RunCanceled
        return {
            "repair_history": next_history,
            "review": {**review_summary, "needs_repair": False},
        }

    auto_totals = {"prompt_tokens": 0, "completion_tokens": 0, "duration_ms": 0}
    auto_model_name = _model_for_role(model_config_data, "Lead Agent")

    def _current_auto_tokens(loop_msgs: list[dict]) -> tuple[int, int, int, int]:
        cur_pinned = len(json.dumps(pinned_user_values, ensure_ascii=False)) // 3
        cur_core = (
            len(compacted_summary) + len(json.dumps(rejected_patterns, ensure_ascii=False))
        ) // 3
        cur_recent = (
            len(json.dumps(user_context["harness_memory"]["recent_turns"], ensure_ascii=False))
            // 3
        )
        cur_loop = (len(json.dumps(loop_msgs, ensure_ascii=False)) // 3) + auto_totals[
            "completion_tokens"
        ]
        total = (
            system_prompts_tokens
            + cur_pinned
            + canvas_tokens
            + cur_core
            + cur_recent
            + cur_loop
        )
        return cur_core, cur_recent, cur_loop, total

    async def auto_lead_agent(state: AutonomousAgentState, writer: StreamWriter) -> dict:
        nonlocal compacted_summary, recent_runs, approx_tokens, pinned_user_values
        step = int(state.get("step") or 0)
        cur_loop = list(state.get("loop_messages") or [])
        cur_ops = list(state.get("operations") or [])
        cur_verifier = state.get("verifier_report")
        steps_log = list(state.get("steps_log") or [])
        compaction_count = int(state.get("compaction_count") or 0)

        if step == 0:
            if not await set_task_state(0, RunStatus.RUNNING):
                raise RunCanceled
            _, _, init_loop_tok, _ = _current_auto_tokens(cur_loop)
            _emit_context_snapshot(
                writer,
                phase="初始对话上下文",
                compacted=False,
                live_loop_tokens=init_loop_tok,
            )

        _, _, live_loop_tok, total_live = _current_auto_tokens(cur_loop)
        has_compactable_turns = len(recent_runs) >= 1
        has_compactable_loop = len(cur_loop) >= 2
        should_compact = (
            (total_live >= compact_threshold and (has_compactable_turns or has_compactable_loop))
            or (step == 0 and force_compact and has_compactable_turns)
            or (
                lab_scenario == "memory_compaction"
                and (has_compactable_turns or (len(cur_loop) >= 2 and compaction_count == 0))
            )
        )
        if should_compact:
            if step == 0 and len(recent_runs) > 2 and not force_compact:
                turns_to_compact = recent_runs[:-1]
                remaining_turns = recent_runs[-1:]
            else:
                turns_to_compact = list(recent_runs)
                remaining_turns = []
            keep_tail = 1 if len(cur_loop) <= 2 else 2
            head_loop = cur_loop[:-keep_tail] if cur_loop else []
            tail_loop = cur_loop[-keep_tail:] if cur_loop else []
            writer(
                {
                    "kind": "thinking",
                    "role": "Memory",
                    "action": "compact",
                    "title": f"自动精炼压缩（约 {total_live}/{compact_threshold} tok）",
                    "text": (
                        f"正在将 {len(turns_to_compact)} 轮历史与 {len(head_loop)} 步试错"
                        "剥离为置顶核心准则与因果记忆..."
                    ),
                }
            )
            compacted_res = await call_model(
                model=auto_model_name,
                system=COMPACTOR_PROMPT,
                user=json.dumps(
                    {
                        "current_goal": goal,
                        "previous_pinned_user_values": pinned_user_values,
                        "previous_core_memory": compacted_summary,
                        "rejected_patterns": rejected_patterns,
                        "turns_to_compact": [_summarize_turn(r) for r in turns_to_compact],
                        "loop_steps_to_compact": head_loop,
                    },
                    ensure_ascii=False,
                ),
            )
            ext_pinned = compacted_res.get("pinned_user_values")
            if isinstance(ext_pinned, list) and ext_pinned:
                pinned_user_values = [
                    str(x).strip() for x in ext_pinned if str(x).strip()
                ][:15]
            new_core = str(compacted_res.get("core_memory") or compacted_summary).strip()[:1200]
            compacted_summary = new_core
            recent_runs = remaining_turns
            tail_payload = [_summarize_turn(r) for r in remaining_turns]
            user_context["pinned_user_values"] = pinned_user_values
            user_context["harness_memory"] = {
                "pinned_user_values": pinned_user_values,
                "core_summary": compacted_summary,
                "rejected_patterns": rejected_patterns,
                "recent_turns": tail_payload,
            }
            cur_loop = (
                [
                    {
                        "step": step,
                        "role": "compactor",
                        "action": "cloud_memory_sync",
                        "content": (
                            f"[已剥离固化观点与硬参数并同步云端] "
                            f"准则: {len(pinned_user_values)} 条 | 摘要: {compacted_summary[:160]}"
                        ),
                    },
                    *tail_loop,
                ]
                if head_loop or tail_loop
                else cur_loop
            )
            approx_tokens = (
                len(compacted_summary)
                + len(json.dumps(pinned_user_values, ensure_ascii=False))
                + len(json.dumps(tail_payload, ensure_ascii=False))
                + len(json.dumps(canvas_brief, ensure_ascii=False))
            ) // 3
            async with session_factory() as mem_save:
                await _save_compacted_row(
                    mem_save,
                    new_summary=compacted_summary,
                    compacted_delta=len(turns_to_compact) + (1 if head_loop else 0),
                    last_run_id=turns_to_compact[-1].id if turns_to_compact else None,
                    est_tokens=approx_tokens,
                    pinned_values=pinned_user_values,
                )
                await mem_save.commit()
            compaction_count += 1
            _, _, post_loop_tok, post_total = _current_auto_tokens(cur_loop)
            saved_tok = max(0, total_live - post_total)
            steps_log.append(
                {
                    "step": step + 1,
                    "action": "compact",
                    "label": "自动压缩并保存云端记忆",
                    "detail": (
                        f"上下文从 {total_live} 降至 {post_total} tokens"
                        f"（释放 {saved_tok} tok）"
                    ),
                }
            )
            _emit_context_snapshot(
                writer,
                phase=f"第 {compaction_count} 次自动压缩后",
                compacted=True,
                live_loop_tokens=post_loop_tok,
                saved_tokens=saved_tok,
            )

        if step >= max_loop_steps:
            fallback_reply = (
                f"已完成 {step} 步自主探索与设计"
                + ("，几何校验通过。" if (cur_verifier or {}).get("passed") else "。")
            )
            return {
                "done": True,
                "loop_messages": cur_loop,
                "compaction_count": compaction_count,
                "steps_log": steps_log,
                "reply": fallback_reply,
                "summary": state.get("summary") or f"完成「{goal[:32]}」",
            }

        lead_payload = {
            **user_context,
            "step": step,
            "max_steps": max_loop_steps,
            "loop_messages": cur_loop,
            "current_operations": cur_ops,
            "verifier_report": cur_verifier,
        }
        response, meta = await call_model_with_meta(
            model=auto_model_name,
            system=AUTONOMOUS_LEAD_PROMPT,
            user=json.dumps(lead_payload, ensure_ascii=False),
        )
        auto_totals["prompt_tokens"] += int(meta.get("prompt_tokens") or 0)
        auto_totals["completion_tokens"] += int(meta.get("completion_tokens") or 0)
        auto_totals["duration_ms"] += int(meta.get("duration_ms") or 0)

        action = str(response.get("action") or "").strip().lower()
        if not action:
            if response.get("operations"):
                action = "design_canvas"
            elif response.get("reply"):
                action = "respond"
            else:
                action = "think"
            response["action"] = action

        if action == "respond":
            if (
                cur_ops
                and cur_verifier is not None
                and not cur_verifier.get("passed", True)
                and int(state.get("repair_rounds_used") or 0) < max_repair_rounds
                and step + 1 < max_loop_steps
            ):
                cur_loop.append(
                    {
                        "step": step + 1,
                        "role": "verifier",
                        "action": "repair_required",
                        "content": (
                            "系统拦截：当前画布操作存在几何碰撞或越界，请先调用 "
                            "design_canvas 调整坐标后再回复用户。"
                        ),
                    }
                )
                return {
                    "step": step + 1,
                    "loop_messages": cur_loop,
                    "compaction_count": compaction_count,
                    "steps_log": steps_log,
                    "pending_action": {
                        "action": "think",
                        "label": "准备修正坐标冲突",
                        "thought": "根据校验结果重排",
                    },
                    "done": False,
                }
            final_reply = str(
                response.get("reply") or response.get("summary") or f"已为你处理「{goal[:40]}」。"
            ).strip()
            final_summary = str(
                response.get("summary") or state.get("summary") or final_reply[:80]
            ).strip()
            return {
                "done": True,
                "loop_messages": cur_loop,
                "compaction_count": compaction_count,
                "steps_log": steps_log,
                "reply": final_reply,
                "summary": final_summary,
            }

        return {
            "step": step,
            "loop_messages": cur_loop,
            "compaction_count": compaction_count,
            "steps_log": steps_log,
            "pending_action": response,
            "done": False,
        }

    async def auto_tool_executor(state: AutonomousAgentState, writer: StreamWriter) -> dict:
        step = int(state.get("step") or 0)
        pending = dict(state.get("pending_action") or {})
        action = str(pending.get("action") or "think").strip().lower()
        cur_loop = list(state.get("loop_messages") or [])
        steps_log = list(state.get("steps_log") or [])
        cur_ops = list(state.get("operations") or [])
        cur_verifier = state.get("verifier_report")
        cur_summary = str(state.get("summary") or "")
        cur_repair_history = list(state.get("repair_history") or [])
        repair_rounds_used = int(state.get("repair_rounds_used") or 0)

        if action == "think":
            label = str(pending.get("label") or "思考推理")[:60]
            thought = str(pending.get("thought") or "梳理意图与构图策略。")[:500]
            writer(
                {
                    "kind": "thinking",
                    "role": "Lead Agent",
                    "action": "think",
                    "title": label,
                    "text": thought,
                }
            )
            cur_loop.append(
                {"step": step + 1, "role": "assistant", "action": "think", "content": thought}
            )
            steps_log.append(
                {"step": step + 1, "action": "think", "label": label, "detail": thought}
            )

        elif action == "plan":
            layout_note = str(pending.get("layout_note") or "")[:300]
            tasks = [str(t)[:120] for t in (pending.get("tasks") or [])[:4]]
            plan_text = "；".join(tasks) + (f"（{layout_note}）" if layout_note else "")
            writer(
                {
                    "kind": "thinking",
                    "role": "Lead Agent",
                    "action": "plan",
                    "title": "按需拆解任务",
                    "text": plan_text or layout_note,
                }
            )
            cur_loop.append(
                {
                    "step": step + 1,
                    "role": "assistant",
                    "action": "plan",
                    "content": {"tasks": tasks, "layout_note": layout_note},
                }
            )
            steps_log.append(
                {"step": step + 1, "action": "plan", "label": "任务拆解", "detail": plan_text}
            )

        elif action == "inspect_canvas":
            reason = str(pending.get("reason") or "确认当前画布对象与空位")[:200]
            right_x = layout_anchors["right_clear_x"]
            writer(
                {
                    "kind": "thinking",
                    "role": "Lead Agent",
                    "action": "inspect_canvas",
                    "title": "读取画布状态",
                    "text": (
                        f"{reason} · 当前共 {len(canvas_brief)} 个对象，右侧空位 x={right_x}"
                    ),
                }
            )
            cur_loop.append(
                {
                    "step": step + 1,
                    "role": "tool",
                    "action": "inspect_canvas",
                    "content": {
                        "reason": reason,
                        "item_count": len(canvas_brief),
                        "layout_anchors": layout_anchors,
                        "items": canvas_brief[:16],
                        "references": references,
                    },
                }
            )
            steps_log.append(
                {
                    "step": step + 1,
                    "action": "inspect_canvas",
                    "label": "查看画布上下文",
                    "detail": f"共 {len(canvas_brief)} 个对象，右侧安全坐标 x={right_x}",
                }
            )

        elif action == "design_canvas":
            raw_ops = pending.get("operations") or []
            cur_summary = str(
                pending.get("summary") or cur_summary or f"设计更新：{goal[:36]}"
            )[:240]
            try:
                validated_ops = validate_plan(raw_ops, canvas_items)
            except PlanValidationError as error:
                err_text = str(error)[:300]
                writer(
                    {
                        "kind": "thinking",
                        "role": "Lead Agent",
                        "action": "design_error",
                        "title": "工具参数校验未通过，准备自修复",
                        "text": err_text,
                    }
                )
                cur_loop.append(
                    {
                        "step": step + 1,
                        "role": "tool",
                        "action": "design_canvas_error",
                        "content": f"工具参数校验失败：{err_text}。请修正字段与类型后重试。",
                    }
                )
                steps_log.append(
                    {
                        "step": step + 1,
                        "action": "repair",
                        "label": "参数校验未通过",
                        "detail": err_text,
                    }
                )
            else:
                materialized_ops: list[dict] = []
                for op in validated_ops:
                    if op["tool"] in {"generate_image", "edit_image"}:
                        op = await materialize_image_op(op)
                    materialized_ops.append(op)
                    writer(
                        {
                            "kind": "tool_call",
                            "tool": op["tool"],
                            "label": TOOL_SPECS[op["tool"]].label,
                            "params": op["params"],
                            "status": "prepared",
                            "result": op.get("result"),
                        }
                    )
                report = verify_proposal_layout(canvas_items, materialized_ops)
                summary_report = {k: v for k, v in report.items() if k != "preview_items"}
                passed = bool(summary_report.get("passed", True))
                issues = summary_report.get("issues") or []
                cur_ops = materialized_ops
                cur_verifier = summary_report
                round_num = len(cur_repair_history) + 1
                if round_num > 1 or not passed:
                    repair_rounds_used += 1
                issue_msg = "；".join(
                    f"{it.get('message', '')} {it.get('suggestion', '')}".strip()
                    for it in issues[:3]
                )
                cur_repair_history.append(
                    {
                        "round": round_num,
                        "verifier_passed": passed,
                        "issue_count": int(summary_report.get("issue_count", 0)),
                        "approved": passed,
                        "feedback": "无碰撞通过" if passed else issue_msg[:300],
                    }
                )
                writer(
                    {
                        "kind": "verifier",
                        "role": "Verifier",
                        "attempt": round_num,
                        "title": (
                            f"第 {round_num} 次画布设计几何校验通过"
                            if passed
                            else f"第 {round_num} 次设计发现 {len(issues)} 项碰撞/边界问题"
                        ),
                        "text": "0 碰撞且在安全间距内。" if passed else issue_msg,
                        **summary_report,
                    }
                )
                hint = (
                    "设计已通过几何校验，可直接调用 respond 回复用户。"
                    if passed
                    else (
                        "检测到碰撞，请调整坐标（参考 "
                        f"right_clear_x={layout_anchors['right_clear_x']}）后重试 design_canvas。"
                    )
                )
                cur_loop.append(
                    {
                        "step": step + 1,
                        "role": "tool",
                        "action": "design_canvas_result",
                        "content": {
                            "operation_count": len(materialized_ops),
                            "verifier_passed": passed,
                            "issues": issues[:4],
                            "hint": hint,
                        },
                    }
                )
                steps_log.append(
                    {
                        "step": step + 1,
                        "action": "design_canvas",
                        "label": f"画布设计（{len(materialized_ops)} 项操作）",
                        "detail": (
                            "几何校验通过（0 碰撞）" if passed else f"需修复：{issue_msg[:120]}"
                        ),
                    }
                )

        _, _, post_loop_tok, _ = _current_auto_tokens(cur_loop)
        _emit_context_snapshot(
            writer,
            phase=f"第 {step + 1} 步执行后",
            compacted=False,
            live_loop_tokens=post_loop_tok,
        )
        return {
            "step": step + 1,
            "loop_messages": cur_loop,
            "steps_log": steps_log,
            "operations": cur_ops,
            "verifier_report": cur_verifier,
            "summary": cur_summary,
            "repair_history": cur_repair_history,
            "repair_rounds_used": repair_rounds_used,
        }

    if loop_mode == "autonomous":
        auto_nodes = {
            "lead_agent": auto_lead_agent,
            "tool_executor": auto_tool_executor,
        }
        try:
            auto_result: dict = {}
            async with open_checkpointer(settings) as checkpointer:
                graph = build_autonomous_graph(auto_nodes, checkpointer)
                async for chunk in graph.astream(
                    {
                        "run_id": run_id,
                        "goal": goal,
                        "step": 0,
                        "max_steps": max_loop_steps,
                        "compaction_count": 0,
                        "loop_messages": [],
                        "operations": [],
                        "repair_rounds_used": 0,
                        "repair_history": [],
                        "steps_log": [],
                        "done": False,
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
                                auto_result.update(node_patch)
            final_ops = list(auto_result.get("operations") or [])
            final_verifier = auto_result.get("verifier_report") or (
                verify_proposal_layout(canvas_items, final_ops)
                if final_ops
                else {"passed": True, "issue_count": 0, "issues": []}
            )
            final_repair_history = list(auto_result.get("repair_history") or [])
            final_steps = list(auto_result.get("steps_log") or [])
            final_reply = str(auto_result.get("reply") or f"已完成「{goal[:40]}」。").strip()
            final_summary = str(auto_result.get("summary") or final_reply[:80]).strip()
            lead_output = {
                "reply": final_reply,
                "summary": final_summary,
                "steps": final_steps,
                "compaction_count": int(auto_result.get("compaction_count") or 0),
                "_meta": {
                    "model": auto_model_name,
                    "prompt_tokens": auto_totals["prompt_tokens"],
                    "completion_tokens": auto_totals["completion_tokens"],
                    "duration_ms": auto_totals["duration_ms"],
                },
            }
            if not await set_task_state(0, RunStatus.SUCCEEDED, lead_output):
                raise RunCanceled
            proposal = {
                "operations": final_ops,
                "applied": False,
                "reviewed": True,
                "reply": final_reply,
                "steps": final_steps,
                "compaction_count": int(auto_result.get("compaction_count") or 0),
                "review": {
                    "approved": bool((final_verifier or {}).get("passed", True)),
                    "passed_verifier": bool((final_verifier or {}).get("passed", True)),
                    "attempt_count": len(final_repair_history) or (1 if final_ops else 0),
                    "feedback": final_reply[:300],
                },
                "verifier": {
                    k: v for k, v in (final_verifier or {}).items() if k != "preview_items"
                },
                "repair_history": final_repair_history,
                "attempt_count": len(final_repair_history) or (1 if final_ops else 0),
            }
            async with session_factory() as session:
                run = await session.get(AgentRun, run_uuid)
                if run is None:
                    return
                completed = await session.execute(
                    update(AgentRun)
                    .where(AgentRun.id == run_uuid, AgentRun.status == RunStatus.RUNNING)
                    .values(
                        status=RunStatus.SUCCEEDED,
                        summary=final_summary,
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
                    {"status": "succeeded", "summary": final_summary, "proposal": proposal},
                )
                await session.commit()
        except RunCanceled:
            return
        except (ProviderError, PlanValidationError, ValueError) as error:
            await _fail_run_by_id(session_factory, run_uuid, str(error)[:500])
        except Exception as error:
            logger.error(
                "autonomous agent loop failed run_id=%s error_type=%s",
                run_id,
                type(error).__name__,
            )
            await _fail_run_by_id(
                session_factory, run_uuid, "Agent 执行失败，请检查模型配置后重试。"
            )
        return

    nodes = {
        "coordinator": coordinator,
        "planner": planner,
        "canvas_editor": canvas_editor,
        "verifier": verifier,
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
                    "attempt": 0,
                    "max_repair_rounds": max_repair_rounds,
                    "repair_history": [],
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
                "verifier": result.get("verifier_report"),
                "repair_history": result.get("repair_history") or [],
                "attempt_count": int(result.get("attempt") or 0) + 1,
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
    await ensure_checkpointer_ready(settings)


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
