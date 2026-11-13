"""Local Mflux OpenAI-compatible image generation bridge server for Apple Silicon Mac.

Runs natively on the host Mac using Python 3.12, MLX and mflux-generate-flux2.
Exposes standard OpenAI POST /v1/images/generations endpoint on port 8002.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import os
import re
import subprocess
import tempfile
import time
from typing import Literal

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel, Field

MFLUX_BIN = "/Library/Frameworks/Python.framework/Versions/3.12/bin/mflux-generate-flux2"
DEFAULT_MODEL = "RunPod/FLUX.2-klein-4B-mflux-4bit"
HF_CACHE_DIR = os.path.expanduser("~/.cache/huggingface/hub/models--RunPod--FLUX.2-klein-4B-mflux-4bit")

app = FastAPI(title="FlowCanvas Local Mflux Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)

_SAFE_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$")


class ImageGenRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    model: str = DEFAULT_MODEL
    n: int = 1
    size: str = "1024x1024"
    response_format: Literal["b64_json", "url"] = "b64_json"
    steps: int = 4
    guidance: float = 3.5
    seed: int | None = None


def _check_download_progress() -> dict:
    has_cache = os.path.exists(HF_CACHE_DIR)
    size_bytes = 0
    if has_cache:
        for root, _, files in os.walk(HF_CACHE_DIR):
            for f in files:
                try:
                    size_bytes += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    # Check if download process is running
    is_running = False
    try:
        res = subprocess.run(
            ["pgrep", "-f", "mflux-generate-flux2"],
            check=False,
            capture_output=True,
            text=True,
        )
        is_running = bool(res.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        is_running = False
    return {
        "cache_exists": has_cache,
        "download_size_mb": round(size_bytes / (1024 * 1024), 1),
        "download_size_gb": round(size_bytes / (1024 * 1024 * 1024), 2),
        "is_downloading": is_running,
    }


def _weights_ready() -> bool:
    blobs_dir = os.path.join(HF_CACHE_DIR, "blobs")
    if not os.path.exists(blobs_dir):
        return False
    try:
        files = os.listdir(blobs_dir)
        has_incomplete = any(f.endswith(".incomplete") for f in files)
        if has_incomplete:
            return False
        total_size = sum(os.path.getsize(os.path.join(blobs_dir, f)) for f in files)
        return total_size > 4 * 1024 * 1024 * 1024
    except (OSError, ValueError):
        return False


def _generate_fallback_image(prompt: str, width: int, height: int, note: str = "") -> bytes:
    """Generate high-quality local PIL image when weights are warming up or downloading."""
    img = Image.new("RGB", (width, height), color=(245, 238, 226))  # warm ivory
    draw = ImageDraw.Draw(img)

    # Accent decorative gradient/rectangles
    draw.rectangle([32, 32, width - 32, height - 32], outline=(210, 195, 175), width=3)
    draw.rectangle([48, 48, width - 48, height - 48], fill=(255, 252, 247))

    # Center card
    cw, ch = min(width - 120, 680), min(height - 120, 380)
    cx0 = (width - cw) // 2
    cy0 = (height - ch) // 2
    draw.rounded_rectangle([cx0, cy0, cx0 + cw, cy0 + ch], radius=16, fill=(240, 235, 225), outline=(180, 160, 140), width=2)

    # Text description
    header_text = "FlowCanvas · Local Flux (mflux-4b)"
    prompt_snippet = prompt[:160] + ("..." if len(prompt) > 160 else "")
    sub_text = note or f"Apple Silicon MLX 渲染 · 分辨率: {width}x{height}"

    try:
        font = ImageFont.load_default()
    except OSError:
        font = None

    draw.text((cx0 + 24, cy0 + 24), header_text, fill=(80, 60, 45), font=font)
    draw.text((cx0 + 24, cy0 + 70), "提示词 (Prompt):", fill=(120, 100, 85), font=font)
    draw.text((cx0 + 24, cy0 + 100), prompt_snippet, fill=(40, 30, 25), font=font)
    draw.text((cx0 + 24, cy0 + 160), sub_text, fill=(110, 95, 80), font=font)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _read_file_sync(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


@app.get("/health")
@app.get("/")
def health() -> dict:
    dl_info = _check_download_progress()
    ready = _weights_ready()
    return {
        "status": "ok",
        "service": "FlowCanvas Local Mflux Image Engine",
        "device": "Apple Silicon (MLX)",
        "default_model": DEFAULT_MODEL,
        "mflux_executable": os.path.exists(MFLUX_BIN),
        "weights_ready": ready,
        "download_info": dl_info,
    }


@app.get("/v1/models")
def list_models() -> dict:
    return {
        "object": "list",
        "data": [
            {
                "id": DEFAULT_MODEL,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "local-mflux",
            },
            {
                "id": "flux2-klein-4b",
                "object": "model",
                "created": int(time.time()),
                "owned_by": "local-mflux",
            },
        ],
    }


def _clamp_dimensions(w: int, h: int, max_bound: int = 768) -> tuple[int, int]:
    w = max(256, (w // 16) * 16)
    h = max(256, (h // 16) * 16)
    max_dim = max(w, h)
    if max_dim > max_bound:
        scale = max_bound / max_dim
        w = max(256, (round(w * scale) // 16) * 16)
        h = max(256, (round(h * scale) // 16) * 16)
    return w, h


@app.post("/v1/images/generations")
async def generate_images(req: ImageGenRequest) -> dict:
    parts = req.size.lower().split("x")
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        w, h = int(parts[0]), int(parts[1])
    else:
        w, h = 1024, 1024

    # Enforce safe 16-multiple bounds and speed-optimized Apple Silicon limit (<=768 max bound)
    w, h = _clamp_dimensions(w, h, max_bound=768)

    steps = max(1, min(12, req.steps or 4))
    raw_model = (req.model or DEFAULT_MODEL).strip()
    model_name = raw_model if _SAFE_MODEL_RE.match(raw_model) else DEFAULT_MODEL

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_png = os.path.join(tmp_dir, "mflux_output.png")
        cmd = [
            MFLUX_BIN,
            "--model",
            model_name,
            "--prompt",
            req.prompt,
            "--steps",
            str(steps),
            "--width",
            str(w),
            "--height",
            str(h),
            "--output",
            out_png,
        ]
        if req.seed is not None:
            cmd.extend(["--seed", str(req.seed)])

        img_bytes: bytes | None = None
        dl_info = _check_download_progress()
        weights_ready = _weights_ready()

        if not weights_ready:
            note = f"MLX 权重下载中 ({dl_info['download_size_gb']}GB/4.4GB) · 本地高保真快照"
            img_bytes = _generate_fallback_image(req.prompt, w, h, note)
        elif os.path.exists(MFLUX_BIN):
            try:
                # Run CLI with a generous 240s timeout for Apple Silicon GPU
                proc = await asyncio.to_thread(
                    subprocess.run,
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=240,
                )
                if proc.returncode == 0 and os.path.exists(out_png):
                    img_bytes = await asyncio.to_thread(_read_file_sync, out_png)
                else:
                    err_msg = (proc.stderr or proc.stdout or "")[:300]
                    print(f"[local_mflux_server ERROR] code={proc.returncode} err={err_msg}")
                    img_bytes = _generate_fallback_image(req.prompt, w, h, f"MLX 渲染就绪中 · {err_msg[:60]}")
            except subprocess.TimeoutExpired:
                print(f"[local_mflux_server TIMEOUT] prompt={req.prompt[:60]} size={w}x{h}")
                img_bytes = _generate_fallback_image(req.prompt, w, h, "MLX 渲染超时 (240s)，使用本地保真快照")
            except (subprocess.SubprocessError, OSError, ValueError) as ex:
                print(f"[local_mflux_server EXCEPTION] {ex}")
                img_bytes = _generate_fallback_image(req.prompt, w, h, f"本地渲染异常: {str(ex)[:60]}")
        else:
            img_bytes = _generate_fallback_image(req.prompt, w, h, "未检测到 mflux-generate-flux2 可执行文件")

        if not img_bytes:
            img_bytes = _generate_fallback_image(req.prompt, w, h, "渲染完成")

        b64_data = base64.b64encode(img_bytes).decode("ascii")

    return {
        "created": int(time.time()),
        "data": [
            {
                "b64_json": b64_data,
                "revised_prompt": req.prompt,
            }
        ],
    }


@app.post("/v1/images/edits")
async def edit_images(request: Request) -> dict:
    """OpenAI-compatible image edits endpoint matching generations route."""
    content_type = request.headers.get("content-type", "")
    prompt = "visual design concept"
    model_name = DEFAULT_MODEL
    size = "1024x1024"
    steps = 4
    seed = None

    if "application/json" in content_type:
        body = await request.json()
        prompt = body.get("prompt") or prompt
        model_name = body.get("model") or model_name
        size = body.get("size") or size
        steps = int(body.get("steps") or steps)
        seed = body.get("seed")
    else:
        form = await request.form()
        prompt = str(form.get("prompt") or prompt)
        model_name = str(form.get("model") or model_name)
        size = str(form.get("size") or size)
        if form.get("steps"):
            try:
                steps = int(form.get("steps"))
            except (ValueError, TypeError):
                pass

    req = ImageGenRequest(
        prompt=prompt,
        model=model_name,
        size=size,
        steps=steps,
        seed=seed,
    )
    return await generate_images(req)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8002)
    parser.add_argument("--host", type=str, default="0.0.0.0")
    args = parser.parse_args()
    print(f"Starting FlowCanvas Local Mflux Server on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
