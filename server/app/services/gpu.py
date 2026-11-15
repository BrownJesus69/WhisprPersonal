"""Best-effort local GPU probe; never downloads or initializes inference models."""

import asyncio
import logging
from contextlib import suppress

from app.config import Settings
from app.schemas.health import GpuInfo


def _cuda_count() -> int:
    import ctranslate2  # optional Phase 3 dependency

    return int(ctranslate2.get_cuda_device_count())


async def detect_gpu(settings: Settings) -> GpuInfo:
    if settings.gpu_detection == "off":
        return GpuInfo(detection="disabled")
    try:
        if await asyncio.to_thread(_cuda_count) > 0:
            return GpuInfo(available=True, detection="ctranslate2")
    except Exception:  # Optional native libraries can fail to load as well as be absent.
        logging.getLogger(__name__).debug("Optional CUDA probe unavailable")
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            "nvidia-smi",
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=3)
        if process.returncode == 0:
            name, memory = stdout.decode().splitlines()[0].rsplit(",", 1)
            return GpuInfo(
                available=True,
                name=name.strip(),
                vram_total_mb=int(memory.strip()),
                detection="nvidia-smi",
            )
    except TimeoutError:
        if process is not None:
            with suppress(ProcessLookupError, OSError):
                process.kill()
                await process.communicate()
    except Exception:
        logging.getLogger(__name__).debug("Local GPU probe unavailable")
    return GpuInfo(available=False, detection="unavailable")
