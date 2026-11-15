import asyncio
from datetime import UTC, datetime
from typing import Any

from app.schemas.health import GpuInfo
from app.services.model_manager import ModelManager
from app.services.state import ServerState


def test_cpu_preload_lru(make_settings: Any) -> None:
    calls = []

    def factory(name: str, **kwargs: Any) -> object:
        calls.append((name, kwargs))
        return object()

    state = ServerState(datetime.now(UTC), GpuInfo())
    manager = ModelManager(make_settings(whisper_device="cpu"), state, factory)
    asyncio.run(manager.preload())
    assert state.model_status == "ready" and state.model_device == "cpu"
    assert calls[0][1]["compute_type"] == "int8"
    with manager.lock:
        first = manager.get("turbo")
        assert manager.get("turbo") is first
        manager.get("accurate")
    assert list(manager.models) == ["accurate"]
    assert len(calls) == 2 and state.model_load_s >= 0


def test_preload_failure_safe(make_settings: Any) -> None:
    def factory(*args: Any, **kwargs: Any) -> None:
        raise FileNotFoundError("private path")

    state = ServerState(datetime.now(UTC), GpuInfo())
    manager = ModelManager(make_settings(whisper_local_files_only=True), state, factory)
    asyncio.run(manager.preload())
    assert state.model_status == "error" and state.model_error == "model_files_missing"


def test_auto_device_probe_mocked_and_two_models(make_settings: Any, monkeypatch: Any) -> None:
    import ctranslate2
    import faster_whisper

    state = ServerState(datetime.now(UTC), GpuInfo())
    calls = []

    def factory(name: str, **kwargs: Any) -> object:
        assert state.model_status == "loading"
        calls.append(kwargs)
        return object()

    monkeypatch.setattr(ctranslate2, "get_cuda_device_count", lambda: 1)
    monkeypatch.setattr(faster_whisper, "WhisperModel", factory)
    manager = ModelManager(make_settings(whisper_max_loaded_models=2), state)
    asyncio.run(manager.preload())
    assert state.model_device == "cuda" and calls[0]["compute_type"] == "float16"
    with manager.lock:
        manager.get("accurate")
        manager.get("turbo")
    assert len(manager.models) == 2
    monkeypatch.setattr(ctranslate2, "get_cuda_device_count", lambda: 0)
    manager = ModelManager(make_settings(whisper_device="cuda"), state)
    asyncio.run(manager.preload())
    assert state.model_error == "cuda_unavailable"


def test_windows_dll_paths_and_handles(tmp_path: Any, monkeypatch: Any) -> None:
    from types import SimpleNamespace

    from app.services import cuda_windows

    first = tmp_path / "nvidia/cublas/bin"
    second = tmp_path / "nvidia/cudnn/bin"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    calls = []

    def add(directory: str) -> object:
        calls.append(directory)
        return object()

    environment = {"PATH": "original"}
    monkeypatch.setattr(
        cuda_windows,
        "os",
        SimpleNamespace(name="nt", environ=environment, pathsep=";", add_dll_directory=add),
    )
    monkeypatch.setattr(cuda_windows.site, "getsitepackages", lambda: [str(tmp_path)])
    directories = cuda_windows.prepare_cuda_dlls()
    assert directories == [str(first), str(second)]
    assert calls == directories and len(directories.handles) == 2
    path = environment["PATH"]
    again = cuda_windows.prepare_cuda_dlls()
    assert again == directories and environment["PATH"] == path
    monkeypatch.setattr(cuda_windows, "os", SimpleNamespace(name="posix"))
    assert cuda_windows.prepare_cuda_dlls() == []
