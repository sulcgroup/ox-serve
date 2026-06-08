import { IncomingMessage } from "http";

export function getHeader(
    req: IncomingMessage,
    name: string,
): string | undefined {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    return value;
}

export function getClientIp(req: IncomingMessage): string {
    const cfIp = getHeader(req, "cf-connecting-ip");
    if (cfIp) return cfIp.trim();

    const trueClientIp = getHeader(req, "true-client-ip");
    if (trueClientIp) return trueClientIp.trim();

    const forwarded = getHeader(req, "x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();

    const realIp = getHeader(req, "x-real-ip");
    if (realIp) return realIp.trim();

    return req.socket.remoteAddress ?? "unknown";
}

export function getLocation(req: IncomingMessage): string {
    const country =
        getHeader(req, "cf-ipcountry") ??
        getHeader(req, "x-vercel-ip-country") ??
        getHeader(req, "x-country-code") ??
        "unknown";

    const city =
        getHeader(req, "x-vercel-ip-city") ??
        getHeader(req, "cf-ipcity") ??
        getHeader(req, "x-city") ??
        "";

    return city ? `${city}, ${country}` : country;
}

export function detectBrowser(userAgent: string): string {
    if (userAgent.includes("Firefox/")) return "Firefox";
    if (userAgent.includes("Edg/")) return "Edge";
    if (userAgent.includes("Chrome/")) return "Chrome";
    if (userAgent.includes("Safari/")) return "Safari";
    return "Unknown";
}
