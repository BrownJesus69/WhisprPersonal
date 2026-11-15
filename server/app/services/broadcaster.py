"""Bounded, non-blocking per-session live delivery, with durable replay on overflow."""

import asyncio
from dataclasses import dataclass, field
from typing import Any


@dataclass(eq=False)
class Subscriber:
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(256))
    overflowed: bool = False


class Broadcaster:
    def __init__(self) -> None:
        self.subscribers: dict[str, set[Subscriber]] = {}

    def subscribe(self, session_id: str) -> Subscriber:
        subscriber = Subscriber()
        self.subscribers.setdefault(session_id, set()).add(subscriber)
        return subscriber

    def unsubscribe(self, session_id: str, subscriber: Subscriber) -> None:
        group = self.subscribers.get(session_id)
        if group is not None:
            group.discard(subscriber)
            if not group:
                self.subscribers.pop(session_id, None)

    def publish(self, session_id: str, message: dict[str, Any]) -> None:
        for subscriber in self.subscribers.get(session_id, ()):
            try:
                subscriber.queue.put_nowait(message)
            except asyncio.QueueFull:
                subscriber.overflowed = True

    def publish_threadsafe(
        self, loop: asyncio.AbstractEventLoop, session_id: str, message: dict[str, Any]
    ) -> None:
        loop.call_soon_threadsafe(self.publish, session_id, message)
