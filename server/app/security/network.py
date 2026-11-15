"""LAN allowlist; forwarded headers are trusted only by explicit opt-in."""

from ipaddress import ip_address, ip_network

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import Settings
from app.core.errors import AppError, ErrorCode, send_error


class NetworkMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.networks = [
            ip_network(value, strict=False) for value in settings.allowed_client_networks
        ]
        self.trust_proxy_headers = settings.trust_proxy_headers

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        address = (scope.get("client") or ("",))[0]
        if self.trust_proxy_headers:
            forwarded = Headers(scope=scope).get("x-forwarded-for")
            if forwarded is not None:
                address = forwarded.split(",")[0].strip()
        try:
            ip = ip_address(address)
            # Dual-stack sockets report IPv4 LAN clients as ::ffff:a.b.c.d.
            if ip.version == 6 and ip.ipv4_mapped is not None:
                ip = ip.ipv4_mapped
            allowed = any(ip in network for network in self.networks)
        except ValueError:
            allowed = False
        if not allowed:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                await send_error(
                    scope,
                    receive,
                    send,
                    AppError(ErrorCode.network_not_allowed, "Client network is not allowed."),
                )
            return
        await self.app(scope, receive, send)
