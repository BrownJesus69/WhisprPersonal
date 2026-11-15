import asyncio
from typing import Any

import pytest

from app.services import gpu


def test_off(make_settings: Any) -> None:
    assert asyncio.run(gpu.detect_gpu(make_settings())).detection == "disabled"


def test_missing(make_settings: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    def missing_import() -> int:
        raise ImportError

    async def missing_process(*args: Any, **kwargs: Any) -> None:
        raise FileNotFoundError

    monkeypatch.setattr(gpu, "_cuda_count", missing_import)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", missing_process)
    result = asyncio.run(gpu.detect_gpu(make_settings(gpu_detection="auto")))
    assert result.available is False
    assert result.detection == "unavailable"


def test_subprocess_timeout(make_settings: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeProcess:
        killed = False
        calls = 0

        async def communicate(self) -> tuple[bytes, bytes]:
            self.calls += 1
            if self.calls == 1:
                raise TimeoutError
            return b"", b""

        def kill(self) -> None:
            self.killed = True

    process = FakeProcess()

    async def start(*args: Any, **kwargs: Any) -> FakeProcess:
        return process

    monkeypatch.setattr(gpu, "_cuda_count", lambda: 0)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", start)
    result = asyncio.run(gpu.detect_gpu(make_settings(gpu_detection="auto")))
    assert result.detection == "unavailable"
    assert process.killed
