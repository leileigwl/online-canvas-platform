from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../../.env"), extra="ignore")

    app_env: str = "development"
    app_secret_key: str = "development-only-change-this-key"
    database_url: str = "sqlite+aiosqlite:///./flowcanvas.db"
    redis_url: str = "redis://localhost:6379/0"
    queue_enabled: bool = True
    auto_create_schema: bool = True
    cookie_secure: bool = False
    session_days: int = 30
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    max_upload_bytes: int = 12 * 1024 * 1024
    auth_rate_limit_per_minute: int = Field(default=30, ge=1, le=1000)
    max_active_agent_runs_per_user: int = Field(default=3, ge=1, le=20)
    max_agent_model_calls_per_run: int = Field(default=12, ge=1, le=50)
    agent_model_completion_tokens_per_call: int = Field(default=2048, ge=128, le=8192)
    chat_completion_token_limit_field: Literal["max_tokens", "max_completion_tokens"] = "max_tokens"
    asset_storage: str = "local"
    asset_local_path: str = "./data/assets"
    s3_endpoint_url: str | None = None
    s3_region: str = "us-east-1"
    s3_bucket: str = "flowcanvas-private"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None

    @model_validator(mode="after")
    def validate_production_secrets(self) -> "Settings":
        if self.app_env == "production":
            if (
                self.app_secret_key == "development-only-change-this-key"
                or self.app_secret_key.startswith("replace-with-")
                or len(self.app_secret_key) < 32
            ):
                raise ValueError(
                    "APP_SECRET_KEY must be a unique value of at least 32 characters in production"
                )
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be enabled in production")
        if self.asset_storage == "s3" and not all(
            (self.s3_endpoint_url, self.s3_access_key, self.s3_secret_key)
        ):
            raise ValueError("S3 storage requires endpoint, access key, and secret key")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
