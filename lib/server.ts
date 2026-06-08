import { createServer as createHttpServer, Server as HttpServer } from "http";
import {
    createServer as createHttpsServer,
    Server as HttpsServer,
    ServerOptions,
} from "https";

export type ConfiguredServer = {
    protocol: "http" | "https";
    server: HttpServer | HttpsServer;
};

export function createConfiguredServer(
    certificateOptions: ServerOptions | undefined,
): ConfiguredServer {
    if (certificateOptions) {
        return {
            protocol: "https",
            server: createHttpsServer(certificateOptions),
        };
    }

    return {
        protocol: "http",
        server: createHttpServer({}),
    };
}
