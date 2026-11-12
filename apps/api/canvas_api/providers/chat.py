from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

import httpcore
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


def _is_public_global_ip(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if not address.is_global:
        return False
    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    ):
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        return _is_public_global_ip(mapped)
    return True


def _resolve_public_ip(hostname: str, port: int) -> str:
    clean_host = hostname.strip("[]").rstrip(".").lower()
    if clean_host == "localhost" or clean_host.endswith((".local", ".localhost")):
        raise ValueError("模型服务地址不能指向本机或局域网")
    try:
        try:
            addresses = [ipaddress.ip_address(clean_host)]
        except ValueError:
            addresses = [
                ipaddress.ip_address(item[4][0].split("%", 1)[0])
                for item in socket.getaddrinfo(clean_host, port, type=socket.SOCK_STREAM)
            ]
    except (OSError, ValueError) as error:
        raise ValueError("无法解析模型服务地址") from error
    if not addresses or any(not _is_public_global_ip(addr) for addr in addresses):
        raise ValueError("模型服务地址不能访问本机、内网或链路本地网络")
    return str(addresses[0])


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
    _resolve_public_ip(parsed.hostname, parsed.port or 443)
    return value.rstrip("/")


class _PublicOnlyNetworkBackend(httpcore.AnyIOBackend):
    """Pin TCP sockets directly to the SSRF-validated IP to prevent DNS rebinding."""

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: object | None = None,
    ) -> httpcore.AsyncNetworkStream:
        try:
            pinned_ip = await asyncio.to_thread(_resolve_public_ip, host, port)
        except ValueError as error:
            raise httpcore.ConnectError(str(error)) from error
        return await super().connect_tcp(
            pinned_ip,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )


def build_safe_async_client(*, timeout: float = 60.0) -> httpx.AsyncClient:
    transport = httpx.AsyncHTTPTransport()
    transport._pool._network_backend = _PublicOnlyNetworkBackend()
    return httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=transport)


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
            async with build_safe_async_client(timeout=90) as client:
                response: httpx.Response | None = None
                for attempt in range(2):
                    try:
                        response = await client.post(
                            f"{safe_url}/chat/completions",
                            headers={"Authorization": f"Bearer {api_key}"},
                            json=payload,
                        )
                        response.raise_for_status()
                        break
                    except httpx.HTTPStatusError as error:
                        status_code = error.response.status_code
                        if attempt == 0 and (status_code == 429 or status_code >= 500):
                            await asyncio.sleep(1.0)
                            continue
                        raise
                    except (httpx.TimeoutException, httpx.TransportError):
                        if attempt == 0:
                            await asyncio.sleep(1.0)
                            continue
                        raise
                assert response is not None
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
