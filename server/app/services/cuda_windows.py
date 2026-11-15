"""Retain DLL directory handles and PATH entries for lazy Windows CUDA loading."""

import os
import site
from pathlib import Path
from typing import Any


class CudaDirectories(list[str]):
    """App-owned directory list keeps the Windows loader handles alive."""

    def __init__(self) -> None:
        super().__init__()
        self.handles: list[Any] = []


def prepare_cuda_dlls() -> CudaDirectories:
    result = CudaDirectories()
    if os.name != "nt":
        return result
    for root in site.getsitepackages():
        for directory in sorted((Path(root) / "nvidia").glob("*/bin")):
            value = str(directory)
            if directory.is_dir() and value not in result:
                result.handles.append(os.add_dll_directory(value))
                result.append(value)
                entries = os.environ.get("PATH", "").split(os.pathsep)
                if value not in entries:
                    os.environ["PATH"] = value + os.pathsep + os.environ.get("PATH", "")
    return result
