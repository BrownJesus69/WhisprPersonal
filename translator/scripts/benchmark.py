"""Owner-run local benchmark. Missing engines produce no scores and enable nothing."""

import asyncio
import json
import math
import statistics
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from sacrebleu.metrics import CHRF

from app.config import Settings

ROOT = Path(__file__).resolve().parents[1]
Engine = Callable[[str, str, list[str]], Awaitable[list[str]]]


def eligible(score: float, indic_score: float | None) -> bool:
    return (
        math.isfinite(score)
        and score >= 35
        and (indic_score is None or (math.isfinite(indic_score) and score >= 0.9 * indic_score))
    )


async def evaluate(engines: dict[str, Engine], dataset: dict[str, list[str]]) -> dict[str, Any]:
    scores: dict[str, dict[str, Any]] = {}
    for name, engine in engines.items():
        scores[name] = {}
        for source in ("kn", "ta", "hi", "en"):
            for target in ("kn", "ta", "hi", "en"):
                if source == target:
                    continue
                outputs, latencies = [], []
                try:
                    for text in dataset[source]:
                        started = time.perf_counter()
                        result = await engine(source, target, [text])
                        if len(result) != 1 or not result[0].strip():
                            raise ValueError("Invalid output")
                        latencies.append((time.perf_counter() - started) * 1000)
                        outputs.extend(result)
                    score = CHRF().corpus_score(outputs, [dataset[target]]).score
                    scores[name][f"{source}-{target}"] = {
                        "chrf": score,
                        "latency_ms": statistics.median(latencies),
                        "n": len(outputs),
                    }
                except Exception:
                    # Never print provider payloads or request headers.
                    continue
    recommendations = {}
    pairs = {p for metrics in scores.values() for p in metrics}
    for pair in sorted(pairs):
        indic = scores.get("indictrans2", {}).get(pair)
        libre = scores.get("libretranslate", {}).get(pair)
        if libre is not None:
            libre["eligible"] = eligible(libre["chrf"], indic["chrf"] if indic else None)
        if indic:
            recommendations[pair] = "indictrans2"
        elif libre and libre["eligible"]:
            recommendations[pair] = "libretranslate"
    return {
        "created_at": datetime.now(UTC).isoformat(),
        "engines": scores,
        "recommendation": recommendations,
    }


async def main() -> None:
    settings = Settings()
    async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=120) as client:

        async def indic(source: str, target: str, texts: list[str]) -> list[str]:
            secret = settings.shared_secret
            if not secret:
                raise ValueError("Not configured")
            response = await client.post(
                "http://127.0.0.1:8100/translate",
                headers={"X-WhisprPersonal-Translator-Key": secret.get_secret_value()},
                json={
                    "source_lang": source,
                    "target_lang": target,
                    "segments": [{"id": str(i), "text": t} for i, t in enumerate(texts)],
                },
            )
            response.raise_for_status()
            return [s["text"] for s in response.json()["segments"]]

        async def libre(source: str, target: str, texts: list[str]) -> list[str]:
            # The owner's installed Argos index has only these two relevant directions.
            if (source, target) not in {("hi", "en"), ("en", "hi")}:
                raise ValueError("No installed pack")
            response = await client.post(
                "http://127.0.0.1:5000/translate",
                json={"q": texts[0], "source": source, "target": target, "format": "text"},
            )
            response.raise_for_status()
            return [response.json()["translatedText"]]

        data = json.loads((ROOT / "benchmark_data.json").read_text(encoding="utf-8"))
        result = await evaluate({"indictrans2": indic, "libretranslate": libre}, data)
    destination = ROOT / "benchmarks" / "latest.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print("Local benchmark saved to translator/benchmarks/latest.json")


if __name__ == "__main__":
    asyncio.run(main())
