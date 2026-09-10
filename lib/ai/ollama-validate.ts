/**
 * An admin-settable URL that the server fetches is an SSRF primitive (plan
 * §9.2.1). These checks run on save and on every heartbeat write. This is a
 * string/IP-literal check, not a DNS-resolution + pinning check — good enough
 * to catch the realistic misconfigurations (a raw private IP, a metadata
 * address, http instead of https) without building a full resolver here.
 */

const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

function isRfc1918(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function validateOllamaBaseUrl(rawUrl: string, allowInsecure = process.env.ALLOW_INSECURE_OLLAMA === "1"): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`"${rawUrl}" is not a valid URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// are allowed.");
  }
  if (url.protocol === "http:" && !allowInsecure) {
    throw new Error("http:// is only allowed with ALLOW_INSECURE_OLLAMA=1 set explicitly. Use https:// for anything reachable from the internet.");
  }

  const hostname = url.hostname;
  if (METADATA_HOSTS.has(hostname)) {
    throw new Error(`${hostname} is a cloud metadata address and can never be a valid Ollama endpoint.`);
  }
  if (isLoopback(hostname)) {
    throw new Error(`${hostname} is a loopback address — a Vercel function cannot reach the box it's running on.`);
  }
  if (isRfc1918(hostname)) {
    throw new Error(`${hostname} is a private address. A Vercel function cannot reach your network — expose the box with a tunnel or a public hostname.`);
  }

  return url.toString().replace(/\/+$/, "");
}
