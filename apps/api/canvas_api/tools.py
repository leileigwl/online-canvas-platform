from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class _StrictToolParams(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AddNoteParams(_StrictToolParams):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(default="", max_length=2000)
    x: float = Field(ge=-1_000_000, le=1_000_000)
    y: float = Field(ge=-1_000_000, le=1_000_000)
    width: float = Field(default=240, gt=0, le=2000)
    height: float = Field(default=140, gt=0, le=2000)


class AddTextParams(_StrictToolParams):
    content: str = Field(min_length=1, max_length=2000)
    x: float = Field(ge=-1_000_000, le=1_000_000)
    y: float = Field(ge=-1_000_000, le=1_000_000)
    width: float = Field(default=240, gt=0, le=2000)
    height: float = Field(default=56, gt=0, le=1000)
    font_family: Literal["sans", "serif", "mono"] = "sans"
    font_size: float = Field(default=22, ge=10, le=120)
    color: str = Field(default="#141413", max_length=32)


class MoveObjectParams(_StrictToolParams):
    object_id: str = Field(min_length=1, max_length=128)
    x: float = Field(ge=-1_000_000, le=1_000_000)
    y: float = Field(ge=-1_000_000, le=1_000_000)


class ResizeObjectParams(_StrictToolParams):
    object_id: str = Field(min_length=1, max_length=128)
    width: float = Field(gt=16, le=4000)
    height: float = Field(gt=16, le=4000)


class AlignObjectsParams(_StrictToolParams):
    object_ids: list[str] = Field(min_length=2, max_length=30)
    columns: int = Field(default=3, ge=1, le=6)
    gap: float = Field(default=24, ge=0, le=200)


class AddShapeParams(_StrictToolParams):
    shape_kind: Literal["rect", "circle", "frame"] = "rect"
    title: str = Field(default="", max_length=120)
    x: float = Field(ge=-1_000_000, le=1_000_000)
    y: float = Field(ge=-1_000_000, le=1_000_000)
    width: float = Field(default=200, gt=16, le=2000)
    height: float = Field(default=140, gt=16, le=2000)
    color: str = Field(default="#ebe8e0", max_length=32)


class GenerateImageParams(_StrictToolParams):
    prompt: str = Field(min_length=1, max_length=2000)
    x: float = Field(default=0, ge=-1_000_000, le=1_000_000)
    y: float = Field(default=0, ge=-1_000_000, le=1_000_000)
    width: float = Field(default=260, gt=32, le=2000)
    height: float = Field(default=260, gt=32, le=2000)
    aspect_ratio: Literal["auto", "1:1", "3:4", "4:3", "16:9", "9:16"] = "auto"
    reference_object_ids: list[str] = Field(default_factory=list, max_length=3)


class EditImageParams(_StrictToolParams):
    prompt: str = Field(min_length=1, max_length=2000)
    reference_object_ids: list[str] = Field(min_length=1, max_length=3)
    x: float = Field(default=0, ge=-1_000_000, le=1_000_000)
    y: float = Field(default=0, ge=-1_000_000, le=1_000_000)
    width: float = Field(default=260, gt=32, le=2000)
    height: float = Field(default=260, gt=32, le=2000)
    aspect_ratio: Literal["auto", "1:1", "3:4", "4:3", "16:9", "9:16"] = "auto"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    label: str
    description: str
    params: type[BaseModel]


TOOL_SPECS = {
    spec.name: spec
    for spec in (
        ToolSpec("add_note", "添加说明便签", "在画布指定坐标添加一个设计说明卡片。", AddNoteParams),
        ToolSpec("add_text", "添加文字标注", "在画布指定坐标放置纯文字标注图层。", AddTextParams),
        ToolSpec(
            "move_object", "移动对象", "将画布中指定 ID 的对象移动到新坐标。", MoveObjectParams
        ),
        ToolSpec(
            "resize_object", "调整尺寸", "调整画布中指定 ID 对象的宽高尺寸。", ResizeObjectParams
        ),
        ToolSpec(
            "align_objects",
            "局部网格对齐",
            "仅围绕所选 object_ids 自身当前坐标就近网格对齐，不影响未选中对象。",
            AlignObjectsParams,
        ),
        ToolSpec("add_shape", "添加几何画框", "添加参考线框或色块形状。", AddShapeParams),
        ToolSpec(
            "generate_image",
            "AI 文生图上画布",
            "按提示词调用用户配置的生图模型生成新图片并添加到画布。",
            GenerateImageParams,
        ),
        ToolSpec(
            "edit_image",
            "AI 参考图编辑 / 融合",
            "基于画布上已有参考图（reference_object_ids）生成新变体或融合延伸图。",
            EditImageParams,
        ),
    )
}


class PlanValidationError(ValueError):
    pass


def validate_plan(
    raw: object, canvas_items: list[dict], *, allow_result: bool = False
) -> list[dict]:
    """Use the same server registry to constrain model output before it becomes a proposal."""
    if not isinstance(raw, list) or len(raw) > 12:
        raise PlanValidationError("提案操作数量无效")
    items_by_id = {
        item["id"]: item for item in canvas_items if isinstance(item, dict) and item.get("id")
    }
    checked: list[dict] = []
    for operation in raw:
        if not isinstance(operation, dict):
            raise PlanValidationError("提案操作格式无效")
        name = operation.get("tool")
        spec = TOOL_SPECS.get(name)
        if spec is None:
            raise PlanValidationError(f"提案包含未登记的画布操作: {name}")
        try:
            params = spec.params.model_validate(operation.get("params", {})).model_dump(mode="json")
        except ValidationError as error:
            raise PlanValidationError("提案参数不符合画布操作规范") from error

        if name in {"move_object", "resize_object"} and params["object_id"] not in items_by_id:
            raise PlanValidationError("操作引用了当前画布中不存在的对象")
        if name == "align_objects":
            missing = [oid for oid in params["object_ids"] if oid not in items_by_id]
            if missing:
                raise PlanValidationError("局部对齐引用了当前画布中不存在的对象")
        if name in {"generate_image", "edit_image"}:
            for ref_oid in params.get("reference_object_ids", []):
                target = items_by_id.get(ref_oid)
                if not target or target.get("type") != "image" or not target.get("asset_id"):
                    raise PlanValidationError("生图参考对象必须是画布上已落盘的图片素材")

        validated: dict = {"tool": name, "params": params}
        if allow_result and isinstance(operation.get("result"), dict):
            validated["result"] = operation["result"]
        checked.append(validated)
    return checked


def apply_canvas_operation(items: list[dict], operation: dict, *, new_id: str) -> None:
    """Apply a validated server-side operation in-place to canvas items."""
    name = operation["tool"]
    params = operation["params"]
    if name == "add_note":
        items.append(
            {
                "id": new_id,
                "type": "note",
                "x": params["x"],
                "y": params["y"],
                "width": params["width"],
                "height": params["height"],
                "title": params["title"],
                "content": params["content"],
                "visible": True,
            }
        )
    elif name == "add_text":
        items.append(
            {
                "id": new_id,
                "type": "text",
                "x": params["x"],
                "y": params["y"],
                "width": params["width"],
                "height": params["height"],
                "title": params["content"][:24],
                "content": params["content"],
                "font_family": params["font_family"],
                "font_size": params["font_size"],
                "color": params["color"],
                "visible": True,
            }
        )
    elif name == "add_shape":
        items.append(
            {
                "id": new_id,
                "type": "shape",
                "shape_kind": params["shape_kind"],
                "x": params["x"],
                "y": params["y"],
                "width": params["width"],
                "height": params["height"],
                "title": params["title"] or params["shape_kind"],
                "color": params["color"],
                "visible": True,
            }
        )
    elif name == "move_object":
        for item in items:
            if item["id"] == params["object_id"]:
                item["x"], item["y"] = params["x"], params["y"]
                break
    elif name == "resize_object":
        for item in items:
            if item["id"] == params["object_id"]:
                item["width"], item["height"] = params["width"], params["height"]
                break
    elif name == "align_objects":
        target_ids = params["object_ids"]
        targets = [item for item in items if item["id"] in target_ids]
        if len(targets) >= 2:
            order_map = {oid: idx for idx, oid in enumerate(target_ids)}
            targets.sort(key=lambda it: order_map.get(it["id"], 0))
            start_x = min(it["x"] for it in targets)
            start_y = min(it["y"] for it in targets)
            cols = max(1, min(params["columns"], len(targets)))
            gap = params["gap"]
            col_w = max(it["width"] for it in targets) + gap
            row_h = max(it["height"] for it in targets) + gap
            for idx, it in enumerate(targets):
                it["x"] = round(start_x + (idx % cols) * col_w, 2)
                it["y"] = round(start_y + (idx // cols) * row_h, 2)
    elif name in {"generate_image", "edit_image"}:
        result = operation.get("result") or {}
        asset_id = result.get("asset_id")
        if not asset_id:
            raise PlanValidationError("生图操作尚未生成有效素材")
        items.append(
            {
                "id": new_id,
                "type": "image",
                "x": params["x"],
                "y": params["y"],
                "width": params["width"],
                "height": params["height"],
                "title": result.get("title") or params["prompt"][:32],
                "asset_id": asset_id,
                "src": f"/api/assets/{asset_id}/content",
                "visible": True,
            }
        )


def public_tool_specs() -> list[dict]:
    return [
        {
            "name": spec.name,
            "label": spec.label,
            "description": spec.description,
            "parameters": spec.params.model_json_schema(),
        }
        for spec in TOOL_SPECS.values()
    ]
