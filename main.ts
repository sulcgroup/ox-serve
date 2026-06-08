import { spawn, ChildProcess } from "child_process";
import * as uuid from "uuid";
import WebSocket from "ws";
import {
    mkdirSync,
    existsSync,
    writeFileSync,
    readFileSync,
    copyFileSync,
    appendFileSync,
} from "fs";
import { rimraf } from "./lib/utils.js";
import { createServer } from "http";
import { IncomingMessage } from "http"; 
import path from "path";
import os from "os";

const FORBIDDEN_TRANSFER_KEYS = [
    /(^|_)file$/,
    /(^|_)filename$/,
    /(^|_)path$/,
    /(^|_)dir$/,
    /(^|_)prefix$/,
    /^topology$/,
    /^reload_from$/,
    /^plugin_/,
];

type ClientLogEntry = {
    sessionId: string;
    ip: string;
    location: string;
    userAgent: string;
    browser: string;
    connectedAt: string;
    disconnectedAt: string;
    durationMs: number;
    messages: number;
    simulationsStarted: number;
    simulationsCompleted: number;
    simulationsFailed: number;
    bytesReceived: number;
    bytesSent: number;
    largestMessageBytes: number;
    largestSendBytes: number;
};

type IpSummary = {
    ip: string;
    location: string;
    totalConnections: number;
    totalConnectedMs: number;
    totalMessages: number;
    totalSimulationsStarted: number;
    totalSimulationsCompleted: number;
    totalSimulationsFailed: number;
    totalBytesReceived: number;
    totalBytesSent: number;
    largestMessageBytes: number;
    largestSendBytes: number;
    lastSeen: string;
    browsers: Record<string, number>;
};

type ActiveSessionInfo = {
    sessionId: string;
    ip: string;
    location: string;
    userAgent: string;
    browser: string;
    connectedAt: string;
    messages: number;
    simulationsStarted: number;
    simulationsCompleted: number;
    simulationsFailed: number;
    bytesReceived: number;
    bytesSent: number;
    currentSimulation?: ActiveSimulationInfo;
};

type ActiveSimulationInfo = {
    startedAt: string;
    interactionType: string;
    bases: number;
    strands: number;
    hasExternalForces: boolean;
    hasANM: boolean;
};

type UsageSample = {
    timestamp: string;
    activeSessionCount: number;
    activeIpCount: number;
    activeSimulationCount: number;
    allowedConnections: number;
    loadavg1: number;
    loadavg5: number;
    loadavg15: number;
    serverRssMB: number;
    serverHeapUsedMB: number;
};

type SimulationEvent = {
    sessionId: string;
    ip: string;
    browser: string;
    event: "started" | "finished" | "error";
    timestamp: string;
    interactionType: string;
    bases: number;
    strands: number;
    hasExternalForces: boolean;
    hasANM: boolean;
    runtimeMs?: number;
    exitCode?: number | null;
    errorMessage?: string;
    loadavg1: number;
    serverRssMB: number;
};

const config = JSON.parse(readFileSync("./resources/config.json", "utf8"));

const SUPPRESS_TERMINAL_STDOUT = config.suppress_terminal_stdout ?? true;

const LOG_DIR = "./logs";
const SESSION_LOG = `${LOG_DIR}/sessions.jsonl`;
const SUMMARY_LOG = `${LOG_DIR}/ip_summary.json`;
const LIVE_STATUS_LOG = `${LOG_DIR}/live_status.json`;
const USAGE_TIMESERIES_LOG = `${LOG_DIR}/usage_timeseries.jsonl`;
const SIMULATION_EVENTS_LOG = `${LOG_DIR}/simulation_events.jsonl`;

if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR);
}

const activeSessionInfo = new Map<string, ActiveSessionInfo>();

function isForbiddenTransferKey(key: string): boolean {
    return FORBIDDEN_TRANSFER_KEYS.some((re) => re.test(key));
}

function validateScalarSetting(
    key: string,
    raw: unknown,
): string | number | boolean {
    if (
        typeof raw !== "string" &&
        typeof raw !== "number" &&
        typeof raw !== "boolean"
    ) {
        throw new Error(`Invalid setting '${key}': unsupported value type`);
    }

    if (typeof raw !== "string") return raw;

    const value = raw.trim();

    if (/[\r\n;]/.test(value)) {
        throw new Error(`Invalid setting '${key}': input injection`);
    }

    if (value.includes("$(") || value.includes("${")) {
        throw new Error(`Invalid setting '${key}': oxDNA expansion forbidden`);
    }

    if (path.isAbsolute(value) || value.includes("/") || value.includes("\\")) {
        throw new Error(`Invalid setting '${key}': path value forbidden`);
    }

    return value;
}

export function sanitizeTransferredOxDNASettings(
    transferred: Record<string, unknown>,
    useDNA: boolean,
): Record<string, string | number | boolean> {
    const clean: Record<string, string | number | boolean> = {};

    for (const [key, raw] of Object.entries(transferred)) {
        if (isForbiddenTransferKey(key)) continue;
        clean[key] = validateScalarSetting(key, raw);
    }

    clean["conf_file"] = "conf_file.dat";
    clean["topology"] = "top_file.top";
    clean["lastconf_file"] = "last_conf.dat";
    clean["trajectory_file"] = "/dev/null";
    clean["energy_file"] = "/dev/null";
    clean["log_file"] = "log.dat";
    clean["print_input"] = false;
    clean["seq_dep_file"] = useDNA
        ? "oxDNA2_sequence_dependent_parameters.txt"
        : "rna_sequence_dependent_parameters.txt";

    return clean;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    return value;
}

function getClientIp(req: IncomingMessage): string {
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

function getLocation(req: IncomingMessage): string {
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

function detectBrowser(userAgent: string): string {
    if (userAgent.includes("Firefox/")) return "Firefox";
    if (userAgent.includes("Edg/")) return "Edge";
    if (userAgent.includes("Chrome/")) return "Chrome";
    if (userAgent.includes("Safari/")) return "Safari";
    return "Unknown";
}

function parseTopologyStats(topologyText: string): { bases: number; strands: number } {
    const firstDataLine = topologyText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#"));

    if (!firstDataLine) {
        return { bases: 0, strands: 0 };
    }

    const parts = firstDataLine.split(/\s+/).map(Number);

    return {
        bases: Number.isFinite(parts[0]) ? parts[0] : 0,
        strands: Number.isFinite(parts[1]) ? parts[1] : 0,
    };
}

function hasANMSettings(data: any, settings: Record<string, string | number | boolean>): boolean {
    return "par_file" in data || "parfile" in settings;
}

function hasExternalForcesSettings(data: any, settings: Record<string, string | number | boolean>): boolean {
    return "trap_file" in data || settings["external_forces"] === "1";
}

function loadSummary(): Record<string, IpSummary> {
    if (!existsSync(SUMMARY_LOG)) return {};

    try {
        return JSON.parse(readFileSync(SUMMARY_LOG, "utf8"));
    } catch {
        return {};
    }
}

function saveSummary(summary: Record<string, IpSummary>): void {
    writeFileSync(SUMMARY_LOG, JSON.stringify(summary, null, 2));
}

function appendJsonl(file: string, value: unknown): void {
    appendFileSync(file, JSON.stringify(value) + "\n");
}

function logSession(entry: ClientLogEntry): void {
    appendJsonl(SESSION_LOG, entry);
}

function updateIpSummary(entry: ClientLogEntry): void {
    const summary = loadSummary();

    if (!summary[entry.ip]) {
        summary[entry.ip] = {
            ip: entry.ip,
            location: entry.location,
            totalConnections: 0,
            totalConnectedMs: 0,
            totalMessages: 0,
            totalSimulationsStarted: 0,
            totalSimulationsCompleted: 0,
            totalSimulationsFailed: 0,
            totalBytesReceived: 0,
            totalBytesSent: 0,
            largestMessageBytes: 0,
            largestSendBytes: 0,
            lastSeen: entry.disconnectedAt,
            browsers: {},
        };
    }

    const ipEntry = summary[entry.ip];

    ipEntry.location = entry.location;
    ipEntry.totalConnections += 1;
    ipEntry.totalConnectedMs += entry.durationMs;
    ipEntry.totalMessages += entry.messages;
    ipEntry.totalSimulationsStarted += entry.simulationsStarted;
    ipEntry.totalSimulationsCompleted += entry.simulationsCompleted;
    ipEntry.totalSimulationsFailed += entry.simulationsFailed;
    ipEntry.totalBytesReceived += entry.bytesReceived;
    ipEntry.totalBytesSent += entry.bytesSent;
    ipEntry.largestMessageBytes = Math.max(ipEntry.largestMessageBytes, entry.largestMessageBytes);
    ipEntry.largestSendBytes = Math.max(ipEntry.largestSendBytes, entry.largestSendBytes);
    ipEntry.lastSeen = entry.disconnectedAt;
    ipEntry.browsers[entry.browser] =
        (ipEntry.browsers[entry.browser] ?? 0) + 1;

    saveSummary(summary);
}

function currentUsageSample(): UsageSample {
    const activeSessions = Array.from(activeSessionInfo.values());
    const activeIps = new Set(activeSessions.map((s) => s.ip));
    const activeSimulationCount = activeSessions.filter((s) => s.currentSimulation).length;
    const loadavg = os.loadavg();
    const memory = process.memoryUsage();

    return {
        timestamp: new Date().toISOString(),
        activeSessionCount: activeSessions.length,
        activeIpCount: activeIps.size,
        activeSimulationCount,
        allowedConnections: Number(config.allowed_connections ?? 0),
        loadavg1: loadavg[0],
        loadavg5: loadavg[1],
        loadavg15: loadavg[2],
        serverRssMB: Math.round(memory.rss / 1024 / 1024),
        serverHeapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
    };
}

function saveLiveStatus(): void {
    const activeSessions = Array.from(activeSessionInfo.values());
    const sample = currentUsageSample();

    writeFileSync(
        LIVE_STATUS_LOG,
        JSON.stringify(
            {
                ...sample,
                activeSessions,
            },
            null,
            2,
        ),
    );
}

function recordUsageSample(): void {
    const sample = currentUsageSample();
    appendJsonl(USAGE_TIMESERIES_LOG, sample);
    saveLiveStatus();
}

function recordSimulationEvent(event: SimulationEvent): void {
    appendJsonl(SIMULATION_EVENTS_LOG, event);
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

function payloadSize(payload: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(payload), "utf8");
    } catch {
        return 0;
    }
}

const server = createServer({});

rimraf(config.simulation_folder);
mkdirSync(config.simulation_folder);

const clients = new Set<WebSocket>();
const wss = new WebSocket.Server({ server });

saveLiveStatus();
recordUsageSample();

console.log(`server listening on port ${config.serverPort}`);

wss.on("connection", (connection: WebSocket, req: IncomingMessage) => {
    if (config.debug_headers) {
        console.log("REMOTE ADDRESS:", req.socket.remoteAddress);
        console.log("HEADERS:");
        console.log(JSON.stringify(req.headers, null, 2));
    }

    if (clients.size >= config.allowed_connections) {
        console.log("refused connection");
        connection.close();
        recordUsageSample();
        return;
    }

    clients.add(connection);

    const user_id = uuid.v1();
    const dir = `${config.simulation_folder}/${user_id}`;

    const ip = getClientIp(req);
    const location = getLocation(req);
    const userAgent = getHeader(req, "user-agent") ?? "unknown";
    const browser = detectBrowser(userAgent);
    const connectedAtMs = Date.now();
    const connectedAt = new Date(connectedAtMs).toISOString();

    let messageCount = 0;
    let simulationsStarted = 0;
    let simulationsCompleted = 0;
    let simulationsFailed = 0;
    let bytesReceived = 0;
    let bytesSent = 0;
    let largestMessageBytes = 0;
    let largestSendBytes = 0;
    let oxDNA: ChildProcess | undefined;
    let currentSimulationStartedAtMs = 0;
    let currentSimulationMeta: ActiveSimulationInfo | undefined;
    let cleanedUp = false;

    activeSessionInfo.set(user_id, {
        sessionId: user_id,
        ip,
        location,
        userAgent,
        browser,
        connectedAt,
        messages: messageCount,
        simulationsStarted,
        simulationsCompleted,
        simulationsFailed,
        bytesReceived,
        bytesSent,
    });

    function updateActiveSession(): void {
        const active = activeSessionInfo.get(user_id);
        if (!active) return;

        active.messages = messageCount;
        active.simulationsStarted = simulationsStarted;
        active.simulationsCompleted = simulationsCompleted;
        active.simulationsFailed = simulationsFailed;
        active.bytesReceived = bytesReceived;
        active.bytesSent = bytesSent;
        active.currentSimulation = currentSimulationMeta;

        saveLiveStatus();
    }

    function sendTracked(payload: unknown): void {
        if (connection.readyState !== WebSocket.OPEN) return;

        const size = payloadSize(payload);
        bytesSent += size;
        largestSendBytes = Math.max(largestSendBytes, size);

        connection.send(JSON.stringify(payload));
        updateActiveSession();
    }

    recordUsageSample();

    console.log(`client ${user_id} connected | ip=${ip} | browser=${browser}`);
    console.log(`processes connected: ${clients.size}`);

    if (!existsSync(dir)) {
        mkdirSync(dir);
    }

    function cleanup(code?: number): void {
        if (cleanedUp) return;
        cleanedUp = true;

        clients.delete(connection);

        if (oxDNA) {
            oxDNA.kill();
            oxDNA = undefined;
        }

        currentSimulationMeta = undefined;
        activeSessionInfo.delete(user_id);

        rimraf(dir);

        const disconnectedAtMs = Date.now();

        const entry: ClientLogEntry = {
            sessionId: user_id,
            ip,
            location,
            userAgent,
            browser,
            connectedAt,
            disconnectedAt: new Date(disconnectedAtMs).toISOString(),
            durationMs: disconnectedAtMs - connectedAtMs,
            messages: messageCount,
            simulationsStarted,
            simulationsCompleted,
            simulationsFailed,
            bytesReceived,
            bytesSent,
            largestMessageBytes,
            largestSendBytes,
        };

        logSession(entry);
        updateIpSummary(entry);
        recordUsageSample();

        console.log(`client ${user_id} cleaned up | code: ${code ?? "unknown"}`);
        console.log(
            `usage | ip=${ip} | location=${location} | browser=${browser} | duration=${formatDuration(
                entry.durationMs,
            )} | messages=${messageCount} | simulations=${simulationsStarted}`,
        );
        console.log(`removed associated working dir: ${dir}`);
        console.log(`processes connected: ${clients.size}`);
    }

    connection.on("message", (rawMessage: any) => {
        const message = rawMessage.toString();
        const messageBytes = Buffer.byteLength(message, "utf8");

        messageCount++;
        bytesReceived += messageBytes;
        largestMessageBytes = Math.max(largestMessageBytes, messageBytes);
        updateActiveSession();

        if (message === "abort") {
            if (oxDNA) {
                oxDNA.kill();
                oxDNA = undefined;
            }
            currentSimulationMeta = undefined;
            updateActiveSession();
            recordUsageSample();
            return;
        }

        if (oxDNA) {
            oxDNA.kill();
            oxDNA = undefined;
            currentSimulationMeta = undefined;
            updateActiveSession();
        }

        let data: any;

        try {
            data = JSON.parse(message);
        } catch {
            sendTracked({
                console_log: "Invalid JSON message",
            });
            return;
        }

        const transferredSettings = data.settings ?? {};

        const interactionType =
            typeof transferredSettings.interaction_type === "string"
                ? transferredSettings.interaction_type
                : config.default_oxDNA_settings.interaction_type ?? "unknown";

        const useDNA = !interactionType.includes("RNA");

        const settings: Record<string, string | number | boolean> = {
            ...config.default_oxDNA_settings,
            ...sanitizeTransferredOxDNASettings(transferredSettings, useDNA),
        };

        if ("trap_file" in data) {
            settings["external_forces"] = "1";
            settings["external_forces_file"] = "trap.txt";
            writeFileSync(`${dir}/trap.txt`, data.trap_file);
        }

        if ("par_file" in data) {
            settings["parfile"] = "par_file.par";
            writeFileSync(`${dir}/par_file.par`, data.par_file);
        }

        const input_file = Object.entries(settings).map(
            ([key, value]) => `${key} = ${value}`,
        );

        const topFile = String(data.top_file ?? "");
        const datFile = String(data.dat_file ?? "");
        const topologyStats = parseTopologyStats(topFile);

        writeFileSync(`${dir}/conf_file.dat`, datFile);
        writeFileSync(`${dir}/last_conf.dat`, datFile);
        writeFileSync(`${dir}/top_file.top`, topFile);
        writeFileSync(`${dir}/${config.input_file}`, input_file.join("\n"));

        if (useDNA) {
            copyFileSync(
                "./resources/oxDNA2_sequence_dependent_parameters.txt",
                `${dir}/oxDNA2_sequence_dependent_parameters.txt`,
            );
        } else {
            copyFileSync(
                "./resources/rna_sequence_dependent_parameters.txt",
                `${dir}/rna_sequence_dependent_parameters.txt`,
            );
        }

        simulationsStarted++;
        currentSimulationStartedAtMs = Date.now();
        currentSimulationMeta = {
            startedAt: new Date(currentSimulationStartedAtMs).toISOString(),
            interactionType,
            bases: topologyStats.bases,
            strands: topologyStats.strands,
            hasExternalForces: hasExternalForcesSettings(data, settings),
            hasANM: hasANMSettings(data, settings),
        };

        updateActiveSession();
        recordUsageSample();

        recordSimulationEvent({
            sessionId: user_id,
            ip,
            browser,
            event: "started",
            timestamp: new Date().toISOString(),
            interactionType,
            bases: topologyStats.bases,
            strands: topologyStats.strands,
            hasExternalForces: currentSimulationMeta.hasExternalForces,
            hasANM: currentSimulationMeta.hasANM,
            loadavg1: os.loadavg()[0],
            serverRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        });

        oxDNA = spawn(config.oxDNA, [config.input_file], { cwd: dir });

        console.log(`client ${user_id} | relax | started`);

        oxDNA.stdout?.on("data", (chunk: Buffer) => {
            const console_log = chunk.toString();

            if (!SUPPRESS_TERMINAL_STDOUT) {
                console.log(`stdout: ${console_log}`);
            }

            if (existsSync(`${dir}/last_conf.dat`)) {
                sendTracked({
                    dat_file: readFileSync(`${dir}/last_conf.dat`, "utf8"),
                    console_log,
                });
            }
        });

        oxDNA.stderr?.on("data", (chunk: Buffer) => {
            console.error(`stderr: ${chunk.toString()}`);
        });

        oxDNA.on("error", (err: Error) => {
            simulationsFailed++;

            console.error(`client ${user_id} | oxDNA error: ${err.message}`);

            recordSimulationEvent({
                sessionId: user_id,
                ip,
                browser,
                event: "error",
                timestamp: new Date().toISOString(),
                interactionType,
                bases: topologyStats.bases,
                strands: topologyStats.strands,
                hasExternalForces: currentSimulationMeta?.hasExternalForces ?? false,
                hasANM: currentSimulationMeta?.hasANM ?? false,
                runtimeMs: currentSimulationStartedAtMs
                    ? Date.now() - currentSimulationStartedAtMs
                    : undefined,
                errorMessage: err.message,
                loadavg1: os.loadavg()[0],
                serverRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            });

            sendTracked({
                console_log: `oxDNA error: ${err.message}`,
            });

            oxDNA = undefined;
            currentSimulationMeta = undefined;
            updateActiveSession();
            recordUsageSample();
        });

        oxDNA.on("close", (code: number | null) => {
            const runtimeMs = currentSimulationStartedAtMs
                ? Date.now() - currentSimulationStartedAtMs
                : 0;

            if (code === 0) {
                simulationsCompleted++;
            } else {
                simulationsFailed++;
            }

            console.log(`client ${user_id} | relax | finished | code: ${code}`);

            recordSimulationEvent({
                sessionId: user_id,
                ip,
                browser,
                event: "finished",
                timestamp: new Date().toISOString(),
                interactionType,
                bases: topologyStats.bases,
                strands: topologyStats.strands,
                hasExternalForces: currentSimulationMeta?.hasExternalForces ?? false,
                hasANM: currentSimulationMeta?.hasANM ?? false,
                runtimeMs,
                exitCode: code,
                loadavg1: os.loadavg()[0],
                serverRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            });

            oxDNA = undefined;
            currentSimulationMeta = undefined;

            if (existsSync(`${dir}/last_conf.dat`)) {
                sendTracked({
                    dat_file: readFileSync(`${dir}/last_conf.dat`, "utf8"),
                    console_log: `oxDNA finished with code ${code}`,
                });
            }

            updateActiveSession();
            recordUsageSample();
        });
    });

    connection.on("close", cleanup);

    connection.on("error", (err: Error) => {
        console.error(`client ${user_id} websocket error: ${err.message}`);
        cleanup();
    });
});

const LIVE_STATUS_INTERVAL_MS = Number(config.live_status_interval_ms ?? 5000);

setInterval(() => {
    saveLiveStatus();
    recordUsageSample();
}, LIVE_STATUS_INTERVAL_MS);

server.listen(config.serverPort, config.serverIP);
