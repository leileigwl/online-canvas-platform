from __future__ import annotations

import smtplib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import update

from canvas_api.config import Settings
from canvas_api.email_service import EmailDeliveryError, send_verification_email
from canvas_api.main import create_app
from canvas_api.models import EmailVerificationCode, User
from canvas_api.security import hash_password, reset_rate_limits


@pytest.fixture(autouse=True)
def _clear_limits():
    reset_rate_limits()
    yield
    reset_rate_limits()


def _make_settings(tmp_path: Path, **overrides: object) -> Settings:
    return Settings(
        _env_file=None,
        app_env="development",
        app_secret_key="test-secret-key-at-least-thirty-two-chars",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'email_auth.db'}",
        queue_enabled=False,
        auto_create_schema=True,
        asset_storage="local",
        asset_local_path=str(tmp_path / "assets"),
        auth_rate_limit_per_minute=30,
        **overrides,
    )


@pytest.mark.asyncio
async def test_email_register_login_and_password_reset_flow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[tuple[str, str, str]] = []

    async def _fake_send(_settings, *, to_email: str, code: str, purpose: str) -> None:
        sent.append((purpose, to_email, code))

    monkeypatch.setattr("canvas_api.routes.send_verification_email", _fake_send)
    app = create_app(_make_settings(tmp_path))

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Request registration code
            send_res = await client.post(
                "/api/auth/email-code",
                json={"email": "Alice.Studio@163.COM ", "purpose": "register"},
            )
            assert send_res.status_code == 200
            assert send_res.json()["sent"] is True
            assert len(sent) == 1
            reg_code = sent[-1][2]
            assert sent[-1][:2] == ("register", "alice.studio@163.com")

            # 2. Immediate resend hits cooldown 429
            cooldown_res = await client.post(
                "/api/auth/email-code",
                json={"email": "alice.studio@163.com", "purpose": "register"},
            )
            assert cooldown_res.status_code == 429

            # 3. Wrong code rejected, code not consumed yet
            bad_reg = await client.post(
                "/api/auth/register",
                json={
                    "username": "alice_creator",
                    "email": "alice.studio@163.com",
                    "password": "password123",
                    "verification_code": "000000" if reg_code != "000000" else "111111",
                },
            )
            assert bad_reg.status_code == 400

            # 4. Correct code succeeds and sets email + email_verified
            ok_reg = await client.post(
                "/api/auth/register",
                json={
                    "username": "Alice_Creator",
                    "email": "alice.studio@163.com",
                    "password": "password123",
                    "verification_code": reg_code,
                },
            )
            assert ok_reg.status_code == 201

            # Username conflict checked before consuming valid code for a different email
            code_bob = await client.post(
                "/api/auth/email-code",
                json={"email": "bob@163.com", "purpose": "register"},
            )
            assert code_bob.status_code == 200
            bob_code = sent[-1][2]
            async with AsyncClientWrapper(transport) as bob_client:
                dup_uname = await bob_client.post(
                    "/api/auth/register",
                    json={
                        "username": "alice_creator",
                        "email": "bob@163.com",
                        "password": "password123",
                        "verification_code": bob_code,
                    },
                )
                assert dup_uname.status_code == 409
                bob_ok = await bob_client.post(
                    "/api/auth/register",
                    json={
                        "username": "bob_creator",
                        "email": "bob@163.com",
                        "password": "password123",
                        "verification_code": bob_code,
                    },
                )
                assert bob_ok.status_code == 201
            body = ok_reg.json()
            assert body["username"] == "alice_creator"
            assert body["email"] == "alice.studio@163.com"
            assert body["email_verified"] is True

            # Duplicate email fails at code-send time with 409
            dup_send = await client.post(
                "/api/auth/email-code",
                json={"email": "alice.studio@163.com", "purpose": "register"},
            )
            assert dup_send.status_code == 409

            # 5. Keep a second session active to verify reset_password invalidates all sessions
            async with AsyncClientWrapper(transport) as second_client:
                login_email = await second_client.post(
                    "/api/auth/login",
                    json={"identifier": "ALICE.STUDIO@163.COM", "password": "password123"},
                )
                assert login_email.status_code == 200
                assert (await second_client.get("/api/auth/me")).status_code == 200

                # Unknown email on reset_password returns neutral 200 without sending SMTP mail
                sent_before = len(sent)
                unknown_reset = await client.post(
                    "/api/auth/email-code",
                    json={"email": "nobody@163.com", "purpose": "reset_password"},
                )
                assert unknown_reset.status_code == 200
                assert len(sent) == sent_before

                # Real email reset_password sends code
                reset_send = await client.post(
                    "/api/auth/email-code",
                    json={"email": "alice.studio@163.com", "purpose": "reset_password"},
                )
                assert reset_send.status_code == 200
                reset_code = sent[-1][2]

                reset_ok = await client.post(
                    "/api/auth/password/reset",
                    json={
                        "email": "alice.studio@163.com",
                        "verification_code": reset_code,
                        "new_password": "newpassword456",
                    },
                )
                assert reset_ok.status_code == 204

                # All old sessions (both clients) must now be invalidated
                assert (await client.get("/api/auth/me")).status_code == 401
                assert (await second_client.get("/api/auth/me")).status_code == 401

                # Old password rejected; new password works via email or username
                old_pw = await client.post(
                    "/api/auth/login",
                    json={"identifier": "alice.studio@163.com", "password": "password123"},
                )
                assert old_pw.status_code == 401
                new_pw = await client.post(
                    "/api/auth/login",
                    json={"identifier": "alice_creator", "password": "newpassword456"},
                )
                assert new_pw.status_code == 200


@pytest.mark.asyncio
async def test_email_code_max_attempts_expiry_and_smtp_failure_recovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[str] = []
    fail_smtp = True

    async def _flaky_send(_settings, *, to_email: str, code: str, purpose: str) -> None:
        if fail_smtp:
            raise EmailDeliveryError("SMTP 暂不可用")
        sent.append(code)

    monkeypatch.setattr("canvas_api.routes.send_verification_email", _flaky_send)
    app = create_app(_make_settings(tmp_path, email_code_max_attempts=2))

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # Header injection rejected
            inject_res = await client.post(
                "/api/auth/email-code",
                json={"email": "bad@163.com\r\nBcc:evil@example.com", "purpose": "register"},
            )
            assert inject_res.status_code == 422

            # SMTP failure returns 502 and clears cooldown row so retry works immediately
            fail_res = await client.post(
                "/api/auth/email-code",
                json={"email": "retry@163.com", "purpose": "register"},
            )
            assert fail_res.status_code == 502

            fail_smtp = False
            ok_res = await client.post(
                "/api/auth/email-code",
                json={"email": "retry@163.com", "purpose": "register"},
            )
            assert ok_res.status_code == 200
            valid_code = sent[-1]
            wrong_code = "000000" if valid_code != "000000" else "111111"

            # Burn max_attempts=2 wrong guesses
            for _ in range(2):
                res = await client.post(
                    "/api/auth/register",
                    json={
                        "username": "retry_user",
                        "email": "retry@163.com",
                        "password": "password123",
                        "verification_code": wrong_code,
                    },
                )
                assert res.status_code == 400

            # Even the real code is now invalidated after lockout
            locked_res = await client.post(
                "/api/auth/register",
                json={
                    "username": "retry_user",
                    "email": "retry@163.com",
                    "password": "password123",
                    "verification_code": valid_code,
                },
            )
            assert locked_res.status_code == 400

            # Request fresh code, force expiry in DB, verify expired error
            async with app.state.session_factory() as db:
                await db.execute(
                    update(EmailVerificationCode)
                    .where(EmailVerificationCode.email == "retry@163.com")
                    .values(created_at=datetime.now(UTC) - timedelta(seconds=120))
                )
                await db.commit()

            ok_res2 = await client.post(
                "/api/auth/email-code",
                json={"email": "retry@163.com", "purpose": "register"},
            )
            assert ok_res2.status_code == 200
            valid_code2 = sent[-1]

            async with app.state.session_factory() as db:
                await db.execute(
                    update(EmailVerificationCode)
                    .where(EmailVerificationCode.email == "retry@163.com")
                    .values(expires_at=datetime.now(UTC) - timedelta(seconds=5))
                )
                await db.commit()

            expired_res = await client.post(
                "/api/auth/register",
                json={
                    "username": "retry_user",
                    "email": "retry@163.com",
                    "password": "password123",
                    "verification_code": valid_code2,
                },
            )
            assert expired_res.status_code == 400
            assert "过期" in expired_res.json()["detail"]


@pytest.mark.asyncio
async def test_legacy_account_login_and_bind_email(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: dict[str, str] = {}

    async def _fake_send(_settings, *, to_email: str, code: str, purpose: str) -> None:
        sent[to_email] = code

    monkeypatch.setattr("canvas_api.routes.send_verification_email", _fake_send)
    app = create_app(_make_settings(tmp_path))

    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as db:
            db.add(User(username="legacy_user", password_hash=hash_password("legacyPass123")))
            await db.commit()

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # Unauthenticated bind_email code send fails 401
            unauth = await client.post(
                "/api/auth/email-code",
                json={"email": "legacy@163.com", "purpose": "bind_email"},
            )
            assert unauth.status_code == 401

            # Legacy user logs in via username and binds email
            login_res = await client.post(
                "/api/auth/login",
                json={"username": "legacy_user", "password": "legacyPass123"},
            )
            assert login_res.status_code == 200
            assert login_res.json()["email"] is None
            assert login_res.json()["email_verified"] is False

            send_res = await client.post(
                "/api/auth/email-code",
                json={"email": "legacy@163.com", "purpose": "bind_email"},
            )
            assert send_res.status_code == 200

            bind_res = await client.post(
                "/api/auth/email/bind",
                json={
                    "email": "legacy@163.com",
                    "verification_code": sent["legacy@163.com"],
                },
            )
            assert bind_res.status_code == 200
            assert bind_res.json()["email"] == "legacy@163.com"
            assert bind_res.json()["email_verified"] is True

            # Can now log in using bound email
            await client.post("/api/auth/logout")
            email_login = await client.post(
                "/api/auth/login",
                json={"identifier": "legacy@163.com", "password": "legacyPass123"},
            )
            assert email_login.status_code == 200


@pytest.mark.asyncio
async def test_smtp_ssl_delivery_and_error_translation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: list[dict[str, object]] = []

    class _FakeSMTPSSL:
        def __init__(self, host: str, port: int, timeout: int) -> None:
            self.host = host
            self.port = port
            self.timeout = timeout

        def __enter__(self) -> _FakeSMTPSSL:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def login(self, user: str, password: str) -> None:
            captured.append({"login_user": user, "login_password": password})

        def send_message(self, msg) -> None:
            captured.append(
                {
                    "host": self.host,
                    "port": self.port,
                    "from": msg["From"],
                    "to": msg["To"],
                    "subject": msg["Subject"],
                    "body": msg.get_content(),
                }
            )

    monkeypatch.setattr(smtplib, "SMTP_SSL", _FakeSMTPSSL)
    settings = _make_settings(
        tmp_path,
        smtp_enabled=True,
        smtp_host="smtp.163.com",
        smtp_port=465,
        smtp_user="sender@163.com",
        smtp_from_email="",
        smtp_password="fake-auth-code",
        smtp_use_ssl=True,
    )
    await send_verification_email(
        settings, to_email="target@163.com", code="654321", purpose="register"
    )
    assert captured[0]["login_user"] == "sender@163.com"
    assert captured[1]["host"] == "smtp.163.com"
    assert captured[1]["port"] == 465
    assert "sender@163.com" in str(captured[1]["from"])
    assert captured[1]["to"] == "target@163.com"
    assert "654321" in str(captured[1]["body"])

    # Auth failure translates cleanly without leaking credentials
    class _FailingSMTP(_FakeSMTPSSL):
        def login(self, user: str, password: str) -> None:
            raise smtplib.SMTPAuthenticationError(535, b"Error: authentication failed")

    monkeypatch.setattr(smtplib, "SMTP_SSL", _FailingSMTP)
    with pytest.raises(EmailDeliveryError, match="鉴权失败"):
        await send_verification_email(
            settings, to_email="target@163.com", code="654321", purpose="register"
        )


def AsyncClientWrapper(transport: httpx.ASGITransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport, base_url="http://test")
