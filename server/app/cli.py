"""Local operator commands. QR codes contain only the supplied connection URL."""

import argparse
import secrets

import httpx
import qrcode
from pydantic import ValidationError

from app.schemas.health import HealthResponse


def main(argv: list[str] | None = None, *, transport: httpx.BaseTransport | None = None) -> int:
    parser = argparse.ArgumentParser(description="WhisprPersonal server tools")
    commands = parser.add_subparsers(dest="command", required=True)
    qr = commands.add_parser("qr")
    qr.add_argument("url")
    selftest = commands.add_parser("selftest")
    selftest.add_argument("--base-url", default="http://127.0.0.1:8000")
    selftest.add_argument("--timeout", type=float, default=5)
    commands.add_parser("gen-secret")
    download = commands.add_parser("download-models")
    download.add_argument("--fallback", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "download-models":
        import os
        from pathlib import Path

        from app.config import get_settings
        from app.services.cuda_windows import prepare_cuda_dlls

        prepare_cuda_dlls()
        os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
        from faster_whisper.utils import download_model

        settings = get_settings()
        names = [settings.whisper_model]
        if args.fallback:
            names.append(settings.whisper_fallback_model)
        for name in names:
            try:
                directory = Path(download_model(name, cache_dir=str(settings.models_dir)))
                size = sum(path.stat().st_size for path in directory.rglob("*") if path.is_file())
                print(f"Downloaded {name}: {size / 1024**3:.2f} GiB")
            except Exception:
                print("FAIL: model download failed. Check internet access and disk space.")
                return 1
        print("Set WHISPER_LOCAL_FILES_ONLY=true for offline events.")
        return 0
    if args.command == "gen-secret":
        print(secrets.token_urlsafe(48))
        return 0
    if args.command == "qr":
        if any(char in args.url for char in "@?#"):
            parser.error("QR URLs must not contain credentials, query data or fragments")
        print(args.url)
        code = qrcode.QRCode()
        code.add_data(args.url)
        code.print_ascii(invert=True)
        return 0
    try:
        with httpx.Client(transport=transport, timeout=args.timeout, trust_env=False) as client:
            response = client.get(args.base_url.rstrip("/") + "/health")
            response.raise_for_status()
            health = HealthResponse.model_validate(response.json())
    except (httpx.HTTPError, ValidationError, ValueError):
        print("FAIL: server unreachable or health response invalid.")
        return 1
    print(f"PASS: health reachable and valid ({health.status}).")
    print(
        f"Model: {health.model.status}; GPU: {health.gpu.available}; queue: {health.queue.status}"
    )
    providers = health.providers.model_dump()
    print(
        "Providers configured: "
        + ", ".join(
            f"{name}={'y' if value['configured'] else 'n'}" for name, value in providers.items()
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
