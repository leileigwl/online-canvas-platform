import hashlib
import hmac
import secrets

from cryptography.fernet import Fernet

from canvas_api.config import Settings, get_settings

_ITERATIONS = 600_000


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
