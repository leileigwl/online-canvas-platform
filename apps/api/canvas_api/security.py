import asyncio
import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque

from cryptography.fernet import Fernet
from fastapi import HTTPException, status

from canvas_api.config import Settings, get_settings

_ITERATIONS = 600_000
_RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)
_RATE_LOCK = asyncio.Lock()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITERATIONS)
    return f"pbkdf2_sha256${_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds, salt, expected = encoded.split("$", maxsplit=3)
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


async def hash_password_async(password: str) -> str:
    return await asyncio.to_thread(hash_password, password)


async def verify_password_async(password: str, encoded: str) -> bool:
    return await asyncio.to_thread(verify_password, password, encoded)


async def enforce_rate_limit(
    redis_client: object | None,
    scope: str,
    identifier: str,
    *,
    limit: int,
    window_seconds: int = 60,
) -> None:
    """Sliding/fixed rate guard backed by Redis when available, else bounded local deque."""
    if redis_client is not None:
        try:
            bucket_id = int(time.time() // window_seconds)
            redis_key = f"flowcanvas:rl:{scope}:{identifier}:{bucket_id}"
            count = await redis_client.incr(redis_key)  # type: ignore[attr-defined]
            if count == 1:
                await redis_client.expire(redis_key, window_seconds + 5)  # type: ignore[attr-defined]
            if count > limit:
                raise HTTPException(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    "请求过于频繁，请稍后再试",
                )
            return
        except HTTPException:
            raise
        except Exception:
            # Fall back to local limiter if Redis momentarily drops.
            pass

    now = time.monotonic()
    cutoff = now - window_seconds
    full_key = f"{scope}:{identifier}"
    async with _RATE_LOCK:
        dq = _RATE_BUCKETS[full_key]
        while dq and dq[0] <= cutoff:
            dq.popleft()
        if len(dq) >= limit:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "请求过于频繁，请稍后再试",
            )
        dq.append(now)
        if len(_RATE_BUCKETS) > 10_000:
            stale = [k for k, v in _RATE_BUCKETS.items() if not v or v[-1] <= cutoff]
            for k in stale:
                del _RATE_BUCKETS[k]


def reset_rate_limits() -> None:
    _RATE_BUCKETS.clear()


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _fernet(settings: Settings | None = None) -> Fernet:
    config = settings or get_settings()
    key = hashlib.sha256(config.app_secret_key.encode()).digest()
    import base64

    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(value: str, settings: Settings | None = None) -> str:
    return _fernet(settings).encrypt(value.encode()).decode()


def decrypt_secret(value: str, settings: Settings | None = None) -> str:
    return _fernet(settings).decrypt(value.encode()).decode()
