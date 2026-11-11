from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import uuid
from pathlib import Path

from PIL import Image
from sqlalchemy import func, select

from canvas_api.config import get_settings
from canvas_api.database import create_database
from canvas_api.models import Asset, Canvas, Project, User
from canvas_api.security import hash_password
from canvas_api.storage import create_storage


def _default_assets_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "web" / "public" / "assets"


async def seed_demo_workspace(username: str, password: str, assets_dir: Path) -> None:
    settings = get_settings()
    engine, session_factory = create_database(settings)
    storage = create_storage(settings)

    sample_specs = [
        ("sample-perfume.jpg", "01 / 琥珀香氛主视觉", False),
        ("sample-architecture.jpg", "02 / 混凝土光影空间", False),
        ("sample-linen.jpg", "03 / 燕麦亚麻肌理", False),
        ("sample-ceramic.jpg", "04 / 素陶静物底座", False),
    ]

    try:
        async with session_factory() as session:
            norm_user = username.lower()
            user = await session.scalar(select(User).where(func.lower(User.username) == norm_user))
            if user is None:
                user = User(username=norm_user, password_hash=hash_password(password))
                session.add(user)
                await session.flush()

            project = await session.scalar(
                select(Project).where(Project.owner_id == user.id, Project.name == "演示作品集")
            )
            if project is None:
                project = Project(owner_id=user.id, name="演示作品集")
                session.add(project)
                await session.flush()

            existing_assets = {
                asset.name: asset
                for asset in await session.scalars(select(Asset).where(Asset.owner_id == user.id))
            }
            created_assets: list[Asset] = []
            for filename, label, temporary in sample_specs:
                if label in existing_assets:
                    created_assets.append(existing_assets[label])
                    continue
                img_path = assets_dir / filename
                if not img_path.exists():
                    raise FileNotFoundError(f"缺少示例素材文件: {img_path}")
                raw = img_path.read_bytes()
                with Image.open(io.BytesIO(raw)) as im:
                    width, height = im.size
                object_key = f"{user.id}/{uuid.uuid4()}.jpg"
                await storage.put(object_key, raw, "image/jpeg")
                asset = Asset(
                    owner_id=user.id,
                    name=label,
                    object_key=object_key,
                    mime_type="image/jpeg",
                    size_bytes=len(raw),
                    sha256=hashlib.sha256(raw).hexdigest(),
                    width=width,
                    height=height,
                    favorite=True,
                    temporary=temporary,
                )
                session.add(asset)
                created_assets.append(asset)
            await session.flush()

            a1, a2, a3, a4 = created_assets
            existing_canvases = {
                canvas.name: canvas
                for canvas in await session.scalars(
                    select(Canvas).where(Canvas.project_id == project.id)
                )
            }
            if "Amber & Concrete 企划" not in existing_canvases:
                session.add(
                    Canvas(
                        project_id=project.id,
                        name="Amber & Concrete 企划",
                        document={
                            "schema_version": 1,
                            "items": [
                                {
                                    "id": "demo-n1",
                                    "type": "image",
                                    "x": -345,
                                    "y": -175,
                                    "width": 205,
                                    "height": 260,
                                    "title": a1.name,
                                    "asset_id": str(a1.id),
                                    "src": f"/api/assets/{a1.id}/content",
                                    "visible": True,
                                },
                                {
                                    "id": "demo-n2",
                                    "type": "image",
                                    "x": -115,
                                    "y": -175,
                                    "width": 240,
                                    "height": 145,
                                    "title": a2.name,
                                    "asset_id": str(a2.id),
                                    "src": f"/api/assets/{a2.id}/content",
                                    "visible": True,
                                },
                                {
                                    "id": "demo-n3",
                                    "type": "image",
                                    "x": 150,
                                    "y": -175,
                                    "width": 215,
                                    "height": 145,
                                    "title": a3.name,
                                    "asset_id": str(a3.id),
                                    "src": f"/api/assets/{a3.id}/content",
                                    "visible": True,
                                },
                                {
                                    "id": "demo-n4",
                                    "type": "note",
                                    "x": -115,
                                    "y": -10,
                                    "width": 480,
                                    "height": 124,
                                    "title": "AMBER & CONCRETE",
                                    "content": (
                                        "• 晨光石材与温润玻璃材质呼应\n"
                                        "• 三栏留白画廊排版节奏\n"
                                        "• 点选画布图片即可静默加入底栏参考，不弹出参数遮挡"
                                    ),
                                    "visible": True,
                                },
                            ],
                        },
                        viewport={"x": 0, "y": 0, "scale": 1},
                        schema_version=1,
                        revision=1,
                    )
                )
            if "建筑光影与空间美学调研" not in existing_canvases:
                session.add(
                    Canvas(
                        project_id=project.id,
                        name="建筑光影与空间美学调研",
                        document={
                            "schema_version": 1,
                            "items": [
                                {
                                    "id": "demo-arch-1",
                                    "type": "image",
                                    "x": -220,
                                    "y": -130,
                                    "width": 260,
                                    "height": 170,
                                    "title": a2.name,
                                    "asset_id": str(a2.id),
                                    "src": f"/api/assets/{a2.id}/content",
                                    "visible": True,
                                },
                                {
                                    "id": "demo-arch-2",
                                    "type": "image",
                                    "x": 70,
                                    "y": -130,
                                    "width": 220,
                                    "height": 170,
                                    "title": a4.name,
                                    "asset_id": str(a4.id),
                                    "src": f"/api/assets/{a4.id}/content",
                                    "visible": True,
                                },
                            ],
                        },
                        viewport={"x": 0, "y": 0, "scale": 1},
                        schema_version=1,
                        revision=1,
                    )
                )
            await session.commit()
            print(f"Seeded demo workspace for user={norm_user} project={project.id}")
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed FlowCanvas editorial demo showcase data.")
    parser.add_argument("--username", required=True, help="Demo account username (3-24 chars)")
    parser.add_argument("--password", required=True, help="Demo account password (>=8 chars)")
    parser.add_argument(
        "--assets-dir",
        type=Path,
        default=_default_assets_dir(),
        help="Directory containing sample-*.jpg",
    )
    args = parser.parse_args()
    asyncio.run(seed_demo_workspace(args.username, args.password, args.assets_dir))


if __name__ == "__main__":
    main()
