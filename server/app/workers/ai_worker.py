"""One asynchronous consumer; provider concurrency is also independently bounded."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.ai.jobs import AIJobService


async def run_worker(service: "AIJobService") -> None:
    while True:
        job_id, request_id = await service.queue.get()
        try:
            await service.process(job_id, request_id)
        finally:
            service.queue.task_done()
