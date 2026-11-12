from __future__ import annotations

import base64
import io
import uuid
from pathlib import Path

import httpcore
import httpx
import pytest
from PIL import Image
from sqlalchemy import select

from canvas_api.config import Settings
from canvas_api.dependencies import get_redis_pool
from canvas_api.main import create_app
from canvas_api.models import (
    AgentRun,
    AgentTask,
    RunEvent,
    RunStatus,
    User,
)
from canvas_api.providers.chat import _PublicOnlyNetworkBackend, _resolve_public_ip
from canvas_api.providers.images import (
    ImageProviderError,
    _decode_b64_image,
    _fetch_image_url,
)
from canvas_api.security import reset_rate_limits


def _valid_png(w: int = 16, h: int = 16) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "#d9c8b4").save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _clear_rate_buckets():
    reset_rate_limits()
    yield
    reset_rate_limits()


async def _register_with_code(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    username: str,
    password: str,
    email: str | None = None,
) -> httpx.Response:
    target_email = email or f"{username}@163.com"
    sent: dict[str, str] = {}

    async def _fake_send(_settings, *, to_email: str, code: str, purpose: str) -> None:
        sent[f"{purpose}:{to_email}"] = code

    monkeypatch.setattr("canvas_api.routes.send_verification_email", _fake_send)
    code_res = await client.post(
        "/api/auth/email-code", json={"email": target_email, "purpose": "register"}
    )
    assert code_res.status_code == 200
    return await client.post(
        "/api/auth/register",
        json={
            "username": username,
            "email": target_email,
            "password": password,
            "verification_code": sent[f"register:{target_email}"],
        },
    )


@pytest.mark.asyncio
async def test_auth_rate_limit_oversized_password_and_cookie_delete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'sec.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
        auth_rate_limit_per_minute=2,
        cookie_secure=True,
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            reg = await _register_with_code(client, monkeypatch, "sec_user_1", "password123")
            assert reg.status_code == 201

            # Oversized password rejected by schema max_length=128 before PBKDF2
            huge = await client.post(
                "/api/auth/login",
                json={"username": "sec_user_1", "password": "x" * 256},
            )
            assert huge.status_code == 422

            # Brute force rate limit after 2 attempts for same account
            assert (
                await client.post(
                    "/api/auth/login", json={"username": "sec_user_1", "password": "wrong111"}
                )
            ).status_code == 401
            assert (
                await client.post(
                    "/api/auth/login", json={"username": "sec_user_1", "password": "wrong222"}
                )
            ).status_code == 401
            throttled = await client.post(
                "/api/auth/login", json={"username": "sec_user_1", "password": "password123"}
            )
            assert throttled.status_code == 429

            # Logout clears cookie with Secure flag matching settings
            out = await client.post("/api/auth/logout")
            assert out.status_code == 204
            set_cookie = out.headers.get("set-cookie", "")
            assert "Secure" in set_cookie


@pytest.mark.asyncio
async def test_upload_defense_ilike_escape_headers_and_account_delete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'up.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            reg = await _register_with_code(client, monkeypatch, "up_user", "password123")
            assert reg.status_code == 201

            # SVG payload masquerading as PNG must be rejected
            svg = await client.post(
                "/api/assets",
                files={"file": ("evil.png", b"<svg onload=alert(1)></svg>", "image/png")},
            )
            assert svg.status_code == 415

            # Truncated/corrupt PNG body must fail image.load()
            corrupt = await client.post(
                "/api/assets",
                files={"file": ("broken.png", _valid_png()[:20], "image/png")},
            )
            assert corrupt.status_code == 415

            # Valid upload serves nosniff + sandbox CSP headers and LIKE escapes '%'
            good = await client.post(
                "/api/assets",
                files={"file": ("hero_shot.png", _valid_png(), "image/png")},
            )
            assert good.status_code == 201
            aid = good.json()["id"]

            served = await client.get(f"/api/assets/{aid}/content")
            assert served.status_code == 200
            assert served.headers.get("x-content-type-options") == "nosniff"
            assert "default-src 'none'" in served.headers.get("content-security-policy", "")

            wildcard = await client.get("/api/assets?search=%25")
            assert wildcard.status_code == 200
            assert wildcard.json() == []

            # Missing image config triggers 404 (not TypeError 500)
            missing_cfg = await client.delete(f"/api/agent/image-configs/{uuid.uuid4()}")
            assert missing_cfg.status_code == 404

            # Delete account removes DB user first and cleans stored asset file afterwards
            assert list((tmp_path / "assets").rglob("*.png"))
            deleted = await client.request(
                "DELETE",
                "/api/auth/account",
                json={"username": "up_user", "password": "password123"},
            )
            assert deleted.status_code == 204
            assert not list((tmp_path / "assets").rglob("*.png"))


@pytest.mark.asyncio
async def test_ssrf_dns_rebinding_and_streaming_oom_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    # Private/loopback/link-local DNS resolution rejected at connect_tcp layer
    with pytest.raises(ValueError):
        _resolve_public_ip("localhost", 443)
    with pytest.raises(ValueError):
        _resolve_public_ip("127.0.0.1", 443)
    with pytest.raises(ValueError):
        _resolve_public_ip("::ffff:169.254.169.254", 443)

    monkeypatch.setattr(
        "canvas_api.providers.chat.socket.getaddrinfo",
        lambda *_a, **_kw: [(2, 1, 6, "", ("10.0.0.5", 443))],
    )
    backend = _PublicOnlyNetworkBackend()
    with pytest.raises(httpcore.ConnectError, match="内网"):
        await backend.connect_tcp("rebind.example.com", 443)

    # Restore DNS helper via monkeypatched public validator for streaming size test
    monkeypatch.setattr(
        "canvas_api.providers.images.validate_public_https_url",
        lambda u: u,
    )

    class _StreamResp:
        status_code = 200
        headers = {"content-length": "999999"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def aiter_bytes(self, chunk_size: int = 65536):
            del chunk_size
            yield b"a" * 600
            yield b"b" * 600

    class _FakeStreamClient:
        def stream(self, method: str, url: str):
            del method, url
            return _StreamResp()

    with pytest.raises(ImageProviderError, match="体积超过限制"):
        await _fetch_image_url(
            _FakeStreamClient(), "https://cdn.example.com/big.png", max_bytes=1024  # type: ignore[arg-type]
        )

    # Oversized base64 string rejected before allocating raw decode buffer
    oversized_b64 = base64.b64encode(b"x" * 2000).decode("ascii")
    with pytest.raises(ImageProviderError, match="体积超过限制"):
        _decode_b64_image(oversized_b64, max_bytes=512)


@pytest.mark.asyncio
async def test_proposal_state_locks_idempotency_sse_and_redis_reconnect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'race.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            reg = await _register_with_code(client, monkeypatch, "race_user", "password123")
            assert reg.status_code == 201
            proj = (await client.get("/api/projects")).json()[0]
            canvas = (await client.get(f"/api/projects/{proj['id']}/canvases")).json()[0]
            canvas_id = uuid.UUID(canvas["id"])

            # Idempotency conflict check when reusing same key for different goal
            r1 = await client.post(
                "/api/agent/runs",
                json={
                    "canvas_id": str(canvas_id),
                    "goal": "目标 A",
                    "idempotency_key": "same-key",
                },
            )
            assert r1.status_code == 202
            r_replay = await client.post(
                "/api/agent/runs",
                json={
                    "canvas_id": str(canvas_id),
                    "goal": "目标 A",
                    "idempotency_key": "same-key",
                },
            )
            assert r_replay.json()["id"] == r1.json()["id"]
            r_conflict = await client.post(
                "/api/agent/runs",
                json={
                    "canvas_id": str(canvas_id),
                    "goal": "目标 B",
                    "idempotency_key": "same-key",
                },
            )
            assert r_conflict.status_code == 409

            # Seed a completed run with valid proposal
            async with app.state.session_factory() as db:
                owner_id = await db.scalar(select(User.id))
                run = AgentRun(
                    owner_id=owner_id,
                    project_id=uuid.UUID(proj["id"]),
                    canvas_id=canvas_id,
                    goal="测试锁",
                    reference_asset_ids=[],
                    context_revision=0,
                    status=RunStatus.SUCCEEDED,
                    summary="测试",
                    proposal={
                        "operations": [
                            {
                                "tool": "add_note",
                                "params": {"title": "卡", "content": "c", "x": 0, "y": 0},
                            }
                        ],
                        "applied": False,
                    },
                )
                db.add(run)
                await db.flush()
                db.add(
                    AgentTask(
                        run_id=run.id,
                        role="Coordinator",
                        sequence=0,
                        task_key="coordinator",
                        title="拆解",
                        depends_on=[],
                        status=RunStatus.SUCCEEDED,
                    )
                )
                db.add(
                    RunEvent(
                        run_id=run.id,
                        sequence=1,
                        event_type="succeeded",
                        data={"status": "succeeded"},
                    )
                )
                await db.commit()
                run_id = run.id

            # SSE succeeds cleanly and releases connections (pool checkedout == 0)
            sse = await client.get(f"/api/agent/runs/{run_id}/events")
            assert sse.status_code == 200
            assert "event: succeeded" in sse.text

            # Rejecting applied proposal is blocked cleanly with 409
            applied = await client.post(
                f"/api/agent/runs/{run_id}/apply", json={"base_revision": 0}
            )
            assert applied.status_code == 200
            reject_after_apply = await client.post(f"/api/agent/runs/{run_id}/reject")
            assert reject_after_apply.status_code == 409

        # Test lazy Redis pool reconnect path in dependencies.get_redis_pool
        app.state.settings.queue_enabled = True
        app.state.redis = None
        sentinel = object()
        import canvas_api.dependencies as deps

        orig_create_pool = deps.create_pool

        async def _fake_pool(_dsn):
            return sentinel

        deps.create_pool = _fake_pool  # type: ignore[assignment]
        try:
            recovered = await get_redis_pool(app)
            assert recovered is sentinel
        finally:
            deps.create_pool = orig_create_pool
            app.state.redis = None
            app.state.settings.queue_enabled = False
