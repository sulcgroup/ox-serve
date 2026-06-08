import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "fs";
import os from "os";

export type ClientLogEntry = {
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

export type ActiveSessionInfo = {
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

export type ActiveSimulationInfo = {
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

export type SimulationEvent = {
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

const LOG_DIR = "./logs";
const SESSION_LOG = `${LOG_DIR}/sessions.jsonl`;
const SUMMARY_LOG = `${LOG_DIR}/ip_summary.json`;
const LIVE_STATUS_LOG = `${LOG_DIR}/live_status.json`;
const USAGE_TIMESERIES_LOG = `${LOG_DIR}/usage_timeseries.jsonl`;
const SIMULATION_EVENTS_LOG = `${LOG_DIR}/simulation_events.jsonl`;

export function ensureLogDir(): void {
    if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR);
    }
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

export function logSession(entry: ClientLogEntry): void {
    appendJsonl(SESSION_LOG, entry);
}

export function updateIpSummary(entry: ClientLogEntry): void {
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
    ipEntry.largestMessageBytes = Math.max(
        ipEntry.largestMessageBytes,
        entry.largestMessageBytes,
    );
    ipEntry.largestSendBytes = Math.max(
        ipEntry.largestSendBytes,
        entry.largestSendBytes,
    );
    ipEntry.lastSeen = entry.disconnectedAt;
    ipEntry.browsers[entry.browser] =
        (ipEntry.browsers[entry.browser] ?? 0) + 1;

    saveSummary(summary);
}

function currentUsageSample(
    activeSessionInfo: Map<string, ActiveSessionInfo>,
    allowedConnections: number,
): UsageSample {
    const activeSessions = Array.from(activeSessionInfo.values());
    const activeIps = new Set(activeSessions.map((s) => s.ip));
    const activeSimulationCount = activeSessions.filter(
        (s) => s.currentSimulation,
    ).length;
    const loadavg = os.loadavg();
    const memory = process.memoryUsage();

    return {
        timestamp: new Date().toISOString(),
        activeSessionCount: activeSessions.length,
        activeIpCount: activeIps.size,
        activeSimulationCount,
        allowedConnections,
        loadavg1: loadavg[0],
        loadavg5: loadavg[1],
        loadavg15: loadavg[2],
        serverRssMB: Math.round(memory.rss / 1024 / 1024),
        serverHeapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
    };
}

export function saveLiveStatus(
    activeSessionInfo: Map<string, ActiveSessionInfo>,
    allowedConnections: number,
): void {
    const activeSessions = Array.from(activeSessionInfo.values());
    const sample = currentUsageSample(activeSessionInfo, allowedConnections);

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

export function recordUsageSample(
    activeSessionInfo: Map<string, ActiveSessionInfo>,
    allowedConnections: number,
): void {
    const sample = currentUsageSample(activeSessionInfo, allowedConnections);
    appendJsonl(USAGE_TIMESERIES_LOG, sample);
    saveLiveStatus(activeSessionInfo, allowedConnections);
}

export function recordSimulationEvent(event: SimulationEvent): void {
    appendJsonl(SIMULATION_EVENTS_LOG, event);
}

export function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

export function payloadSize(payload: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(payload), "utf8");
    } catch {
        return 0;
    }
}
