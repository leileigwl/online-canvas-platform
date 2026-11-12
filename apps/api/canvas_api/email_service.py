from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import smtplib
from email.message import EmailMessage
from email.utils import formataddr

from canvas_api.config import Settings

logger = logging.getLogger(__name__)

_SUBJECTS = {
    "register": "【FlowCanvas】账户注册邮箱验证码",
    "reset_password": "【FlowCanvas】密码重置邮箱验证码",
    "bind_email": "【FlowCanvas】邮箱绑定验证码",
}

_PURPOSE_LABELS = {
    "register": "注册 FlowCanvas 账户",
    "reset_password": "重置 FlowCanvas 登录密码",
    "bind_email": "绑定或更换 FlowCanvas 账户邮箱",
}


class EmailDeliveryError(RuntimeError):
    pass


def hash_email_code(purpose: str, email: str, code: str, settings: Settings) -> str:
    payload = f"{purpose}:{email.strip().lower()}:{code}".encode()
    return hmac.new(settings.app_secret_key.encode(), payload, hashlib.sha256).hexdigest()


def verify_email_code_digest(
    purpose: str, email: str, code: str, expected_hash: str, settings: Settings
) -> bool:
    candidate = hash_email_code(purpose, email, code, settings)
    return hmac.compare_digest(candidate, expected_hash)


def _send_sync(settings: Settings, *, to_email: str, code: str, purpose: str) -> None:
    from_email = (settings.smtp_from_email or settings.smtp_user).strip()
    ttl_minutes = max(1, settings.email_code_ttl_seconds // 60)
    action_label = _PURPOSE_LABELS.get(purpose, "验证您的邮箱")

    msg = EmailMessage()
    msg["Subject"] = _SUBJECTS.get(purpose, "【FlowCanvas】邮箱验证码")
    msg["From"] = formataddr((settings.smtp_from_name or "FlowCanvas", from_email))
    msg["To"] = to_email
    msg.set_content(
        f"您好，\n\n"
        f"您正在{action_label}，本次 6 位数字验证码为：\n\n"
        f"    {code}\n\n"
        f"验证码 {ttl_minutes} 分钟内有效，请勿泄露给他人。\n"
        f"如非本人操作，请忽略此邮件。\n\n"
        f"FlowCanvas 工作台"
    )

    if settings.smtp_use_ssl:
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=12) as smtp:
            smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=12) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(msg)


async def send_verification_email(
    settings: Settings, *, to_email: str, code: str, purpose: str
) -> None:
    if not settings.smtp_enabled or not all(
        (settings.smtp_host.strip(), settings.smtp_user.strip(), settings.smtp_password.strip())
    ):
        raise EmailDeliveryError(
            "邮件服务尚未完成发信邮箱配置（需配置 SMTP_ENABLED、SMTP_USER 与授权码）"
        )
    try:
        await asyncio.to_thread(_send_sync, settings, to_email=to_email, code=code, purpose=purpose)
    except smtplib.SMTPAuthenticationError as error:
        logger.warning(
            "SMTP authentication rejected host=%s error_type=%s",
            settings.smtp_host,
            type(error).__name__,
        )
        raise EmailDeliveryError("SMTP 发信邮箱鉴权失败，请检查发信地址或授权码") from error
    except (smtplib.SMTPException, OSError) as error:
        logger.warning(
            "SMTP delivery failed host=%s error_type=%s",
            settings.smtp_host,
            type(error).__name__,
        )
        raise EmailDeliveryError("验证码邮件发送失败，请检查邮箱地址或稍后重试") from error
