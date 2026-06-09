import { spawn, ChildProcess } from "child_process";
import * as uuid from "uuid";
import WebSocket from "ws";
import {
    mkdirSync,
    existsSync,
    writeFileSync,
    readFileSync,
    copyFileSync,
} from "fs";
import { rimraf } from "./lib/utils.js";
import { IncomingMessage } from "http"; 
import os from "os";
import { loadCertificateOptions } from "./lib/certificates.js";
import { getHelpText, parseCliOptions } from "./lib/cli.js";
import {
    detectBrowser,
    getClientIp,
    getHeader,
    getLocation,
} from "./lib/client-info.js";
import {
    ActiveSessionInfo,
    ActiveSimulationInfo,
    ClientLogEntry,
    ensureLogDir,
    formatDuration,
    logSession,
    payloadSize,
    recordSimulationEvent,
    recordUsageSample,
    saveLiveStatus,
    updateIpSummary,
} from "./lib/logging.js";
import {
    hasANMSettings,
    hasExternalForcesSettings,
    OxDNASettingValue,
    sanitizeTransferredOxDNASettings,
} from "./lib/settings.js";
import { createConfiguredServer } from "./lib/server.js";
import { parseTopologyStats } from "./lib/topology.js";

const cliOptions = parseCliOptions(process.argv.slice(2));

if (cliOptions.showHelp) {
    console.log(getHelpText());
    process.exit(0);
}

const config = JSON.parse(readFileSync(cliOptions.configFile, "utf8"));

const SUPPRESS_TERMINAL_STDOUT = config.suppress_terminal_stdout ?? true;

ensureLogDir();

const activeSessionInfo = new Map<string, ActiveSessionInfo>();
const activeChildProcesses = new Set<ChildProcess>();
const allowedConnections = Number(config.allowed_connections ?? 0);
const maxIdleTimeMs = Number(config.max_idle_time_ms ?? 5 * 60 * 1000);
const certificateOptions = loadCertificateOptions(process.argv.slice(2));
const { protocol, server } = createConfiguredServer(certificateOptions);

rimraf(config.simulation_folder);
mkdirSync(config.simulation_folder);

const clients = new Set<WebSocket>();
const wss = new WebSocket.Server({ server });

saveLiveStatus(activeSessionInfo, allowedConnections);
recordUsageSample(activeSessionInfo, allowedConnections);

console.log(`${protocol} server listening on port ${config.serverPort}`);

wss.on("connection", (connection: WebSocket, req: IncomingMessage) => {
    if (config.debug_headers) {
        console.log("REMOTE ADDRESS:", req.socket.remoteAddress);
        console.log("HEADERS:");
        console.log(JSON.stringify(req.headers, null, 2));
    }

    if (clients.size >= allowedConnections) {
        console.log("refused connection");
        connection.close();
        recordUsageSample(activeSessionInfo, allowedConnections);
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
    let idleTimeout: NodeJS.Timeout | undefined;
    const userAbortedProcesses = new WeakSet<ChildProcess>();

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

        saveLiveStatus(activeSessionInfo, allowedConnections);
    }

    function sendTracked(payload: unknown): void {
        if (connection.readyState !== WebSocket.OPEN) return;

        const size = payloadSize(payload);
        bytesSent += size;
        largestSendBytes = Math.max(largestSendBytes, size);

        connection.send(JSON.stringify(payload));
        updateActiveSession();
    }

    function clearIdleTimeout(): void {
        if (!idleTimeout) return;

        clearTimeout(idleTimeout);
        idleTimeout = undefined;
    }

    function armIdleTimeout(): void {
        clearIdleTimeout();

        if (maxIdleTimeMs <= 0 || oxDNA) return;

        idleTimeout = setTimeout(() => {
            if (cleanedUp || oxDNA || connection.readyState !== WebSocket.OPEN) {
                return;
            }

            console.log(
                `client ${user_id} idle for ${formatDuration(maxIdleTimeMs)}, disconnecting`,
            );
            connection.close();
        }, maxIdleTimeMs);
        idleTimeout.unref();
    }

    recordUsageSample(activeSessionInfo, allowedConnections);

    console.log(`client ${user_id} connected | ip=${ip} | browser=${browser}`);
    console.log(`processes connected: ${clients.size}`);

    if (!existsSync(dir)) {
        mkdirSync(dir);
    }

    function cleanup(code?: number): void {
        if (cleanedUp) return;
        cleanedUp = true;

        clearIdleTimeout();
        clients.delete(connection);

        if (oxDNA) {
            activeChildProcesses.delete(oxDNA);
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
        recordUsageSample(activeSessionInfo, allowedConnections);

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
        clearIdleTimeout();

        const message = rawMessage.toString();
        const messageBytes = Buffer.byteLength(message, "utf8");

        messageCount++;
        bytesReceived += messageBytes;
        largestMessageBytes = Math.max(largestMessageBytes, messageBytes);
        updateActiveSession();

        if (message === "abort") {
            if (oxDNA) {
                userAbortedProcesses.add(oxDNA);
                activeChildProcesses.delete(oxDNA);
                oxDNA.kill();
                oxDNA = undefined;
            }
            currentSimulationMeta = undefined;
            updateActiveSession();
            recordUsageSample(activeSessionInfo, allowedConnections);
            armIdleTimeout();
            return;
        }

        if (oxDNA) {
            activeChildProcesses.delete(oxDNA);
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
            armIdleTimeout();
            return;
        }

        const transferredSettings = data.settings ?? {};

        const interactionType =
            typeof transferredSettings.interaction_type === "string"
                ? transferredSettings.interaction_type
                : config.default_oxDNA_settings.interaction_type ?? "unknown";

        const useDNA = !interactionType.includes("RNA");

        const settings: Record<string, OxDNASettingValue> = {
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
        recordUsageSample(activeSessionInfo, allowedConnections);

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

        const simulationStartedAtMs = currentSimulationStartedAtMs;
        const simulationMeta = currentSimulationMeta;
        const child = spawn(config.oxDNA, [config.input_file], { cwd: dir });
        oxDNA = child;
        activeChildProcesses.add(child);

        console.log(`client ${user_id} | relax | started`);

        child.stdout?.on("data", (chunk: Buffer) => {
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

        child.stderr?.on("data", (chunk: Buffer) => {
            console.error(`stderr: ${chunk.toString()}`);
        });

        child.on("error", (err: Error) => {
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
                hasExternalForces: simulationMeta?.hasExternalForces ?? false,
                hasANM: simulationMeta?.hasANM ?? false,
                runtimeMs: simulationStartedAtMs
                    ? Date.now() - simulationStartedAtMs
                    : undefined,
                errorMessage: err.message,
                loadavg1: os.loadavg()[0],
                serverRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            });

            sendTracked({
                console_log: `oxDNA error: ${err.message}`,
            });

            activeChildProcesses.delete(child);
            if (oxDNA === child) {
                oxDNA = undefined;
                currentSimulationMeta = undefined;
                armIdleTimeout();
            }
            updateActiveSession();
            recordUsageSample(activeSessionInfo, allowedConnections);
        });

        child.on("close", (code: number | null) => {
            const runtimeMs = simulationStartedAtMs
                ? Date.now() - simulationStartedAtMs
                : 0;
            const userAborted = userAbortedProcesses.has(child);

            if (userAborted) {
                console.log(`client ${user_id} | relax | aborted by user`);
            } else if (code === 0) {
                simulationsCompleted++;
            } else {
                simulationsFailed++;
            }

            console.log(`client ${user_id} | relax | finished | code: ${code}`);

            recordSimulationEvent({
                sessionId: user_id,
                ip,
                browser,
                event: userAborted ? "aborted" : "finished",
                timestamp: new Date().toISOString(),
                interactionType,
                bases: topologyStats.bases,
                strands: topologyStats.strands,
                hasExternalForces: simulationMeta?.hasExternalForces ?? false,
                hasANM: simulationMeta?.hasANM ?? false,
                runtimeMs,
                exitCode: code,
                loadavg1: os.loadavg()[0],
                serverRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            });

            activeChildProcesses.delete(child);
            if (oxDNA === child) {
                oxDNA = undefined;
                currentSimulationMeta = undefined;
            }

            if (!userAborted && existsSync(`${dir}/last_conf.dat`)) {
                sendTracked({
                    dat_file: readFileSync(`${dir}/last_conf.dat`, "utf8"),
                    console_log: `oxDNA finished with code ${code}`,
                });
            }

            updateActiveSession();
            recordUsageSample(activeSessionInfo, allowedConnections);
            if (oxDNA === undefined) {
                armIdleTimeout();
            }
        });
    });

    armIdleTimeout();

    connection.on("close", cleanup);

    connection.on("error", (err: Error) => {
        console.error(`client ${user_id} websocket error: ${err.message}`);
        cleanup();
    });
});

const LIVE_STATUS_INTERVAL_MS = Number(config.live_status_interval_ms ?? 5000);

const liveStatusInterval = setInterval(() => {
    saveLiveStatus(activeSessionInfo, allowedConnections);
    recordUsageSample(activeSessionInfo, allowedConnections);
}, LIVE_STATUS_INTERVAL_MS);

let isShuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`received ${signal}, shutting down`);
    clearInterval(liveStatusInterval);

    for (const child of activeChildProcesses) {
        child.kill();
    }
    activeChildProcesses.clear();

    for (const client of clients) {
        client.close();
    }

    saveLiveStatus(activeSessionInfo, allowedConnections);
    recordUsageSample(activeSessionInfo, allowedConnections);

    server.close(() => {
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(1);
    }, 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(config.serverPort, config.serverIP);
