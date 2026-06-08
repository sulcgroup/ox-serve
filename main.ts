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
import { createServer } from "http";
import { IncomingMessage } from "http"; 
import os from "os";
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
import { parseTopologyStats } from "./lib/topology.js";

const config = JSON.parse(readFileSync("./resources/config.json", "utf8"));

const SUPPRESS_TERMINAL_STDOUT = config.suppress_terminal_stdout ?? true;

ensureLogDir();

const activeSessionInfo = new Map<string, ActiveSessionInfo>();
const allowedConnections = Number(config.allowed_connections ?? 0);

const server = createServer({});

rimraf(config.simulation_folder);
mkdirSync(config.simulation_folder);

const clients = new Set<WebSocket>();
const wss = new WebSocket.Server({ server });

saveLiveStatus(activeSessionInfo, allowedConnections);
recordUsageSample(activeSessionInfo, allowedConnections);

console.log(`server listening on port ${config.serverPort}`);

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

    recordUsageSample(activeSessionInfo, allowedConnections);

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
            recordUsageSample(activeSessionInfo, allowedConnections);
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
            recordUsageSample(activeSessionInfo, allowedConnections);
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
            recordUsageSample(activeSessionInfo, allowedConnections);
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
    saveLiveStatus(activeSessionInfo, allowedConnections);
    recordUsageSample(activeSessionInfo, allowedConnections);
}, LIVE_STATUS_INTERVAL_MS);

server.listen(config.serverPort, config.serverIP);
