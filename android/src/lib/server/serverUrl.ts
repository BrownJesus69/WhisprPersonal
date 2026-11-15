export type ServerKind = 'lan' | 'tailscale' | 'localhost' | 'https';

export function parseServerUrl(input: string): {
  url: string;
  kind: ServerKind;
} {
  const text = input.trim();
  const plain = text.includes('://') ? text : `http://${text}`;
  if (!/^https?:\/\/[^/]+\/?$/i.test(plain))
    throw new Error('Use a plain server URL without a path');
  if (/[?#@\\]/.test(text))
    throw new Error('Use a plain server URL without credentials, query or fragment');
  let parsed: URL;
  try {
    parsed = new URL(text.includes('://') ? text : `http://${text}`);
  }
  catch {
    throw new Error('Enter a valid server address and port (1–65535)');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.username || parsed.password || !parsed.hostname || (parsed.port && (+parsed.port < 1 || +parsed.port > 65535)))
    throw new Error('Use a plain HTTP or HTTPS server URL, with port 1–65535');
  const h = parsed.hostname.toLowerCase();
  let kind: ServerKind;
  const ip = h.split('.').map(Number);
  const ipv4 = ip.length === 4 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  if (parsed.protocol === 'https:')
    kind = 'https';
  else if (['localhost', '127.0.0.1', '10.0.2.2'].includes(h))
    kind = 'localhost';
  else if (h.endsWith('.ts.net') || (ipv4 && ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127))
    kind = 'tailscale';
  else if (ipv4 && (ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168)))
    kind = 'lan';
  else
    throw new Error("Use your laptop's LAN or Tailscale address");
  return { url: parsed.origin, kind };
}
