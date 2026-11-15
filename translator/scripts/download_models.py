"""Explicit download only; never used by the service."""

import argparse

from app.config import Settings
from app.engine import DIRECTIONS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download pinned models using existing HF login")
    _, unknown = parser.parse_known_args(argv)
    if unknown:
        # argparse's default error echoes argument values, which could include a pasted token.
        parser.error(
            "Unsupported arguments. Use the existing HF login; no token arguments allowed."
        )
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import GatedRepoError

    settings = Settings()
    for direction in DIRECTIONS:
        repo, revision = settings.model_spec(direction)
        try:
            snapshot_download(
                repo_id=repo,
                revision=revision,
                cache_dir=str(settings.hf_cache_dir),
                allow_patterns=["*.json", "*.py", "model.SRC", "model.TGT", "model.safetensors"],
            )
        except GatedRepoError:
            print(f"Accept the terms at https://huggingface.co/{repo} and run `hf auth login`.")
            return 1
        except Exception:
            print("Model download failed. Check HF login and connectivity.")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
