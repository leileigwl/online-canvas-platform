from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

import httpx


class ChatProvider(Protocol):
    async def complete_json(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        system: str,
        user: str,
        max_output_tokens: int = 2048,
        token_limit_field: str = "max_tokens",
    ) -> ChatCompletionResult: ...


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class ChatCompletionResult:
    content: dict
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


def validate_public_https_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise ValueError("模型服务地址必须是有效的 HTTPS URL")
    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith((".local", ".localhost")):
        raise ValueError("模型服务地址不能指向本机或局域网")
    try:
        try:
            addresses = [ipaddress.ip_address(hostname)]
        except ValueError:
            addresses = [
                ipaddress.ip_address(item[4][0])
                for item in socket.getaddrinfo(
                    hostname, parsed.port or 443, type=socket.SOCK_STREAM
                )
            ]
    except (OSError, ValueError) as error:
        raise ValueError("无法解析模型服务地址") from error
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("模型服务地址不能访问本机、内网或链路本地网络")
    return value.rstrip("/")


class OpenAICompatibleChatProvider:
    async def complete_json(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        system: str,
        user: str,
        max_output_tokens: int = 2048,
        token_limit_field: str = "max_tokens",
    ) -> ChatCompletionResult:
        if token_limit_field not in {"max_tokens", "max_completion_tokens"}:
            raise ProviderError("模型输出长度参数配置无效")
        try:
            safe_url = await asyncio.to_thread(validate_public_https_url, base_url)
            async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
                payload = {
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.2,
                }
                payload[token_limit_field] = max_output_tokens
                response = await client.post(
                    f"{safe_url}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json=payload,
                )
                response.raise_for_status()
                body = response.json()
                content = body["choices"][0]["message"]["content"]
                usage = body.get("usage") or {}
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
            raise ProviderError("模型服务请求失败，请检查配置或稍后重试") from error
        import json

        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError) as error:
            raise ProviderError("模型服务没有返回有效 JSON") from error
        if not isinstance(parsed, dict):
            raise ProviderError("模型服务返回内容格式无效")
        if not isinstance(usage, dict):
            usage = {}
        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        return ChatCompletionResult(
            content=parsed,
            prompt_tokens=(
                prompt_tokens if isinstance(prompt_tokens, int) and prompt_tokens >= 0 else None
            ),
            completion_tokens=(
                completion_tokens
                if isinstance(completion_tokens, int) and completion_tokens >= 0
                else None
            ),
        )
