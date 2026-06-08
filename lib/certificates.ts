import { readFileSync } from "fs";
import type { ServerOptions } from "https";

type CertificateFileArgs = {
    certFile?: string;
    keyFile?: string;
    caFile?: string;
};

function readOptionValue(args: string[], index: number, name: string): string {
    const value = args[index + 1];

    if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${name}`);
    }

    return value;
}

function parseCertificateFileArgs(args: string[]): CertificateFileArgs {
    const certificateArgs: CertificateFileArgs = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith("--cert=")) {
            certificateArgs.certFile = arg.slice("--cert=".length);
        } else if (arg === "--cert" || arg === "--cert-file") {
            certificateArgs.certFile = readOptionValue(args, i, arg);
            i++;
        } else if (arg.startsWith("--cert-file=")) {
            certificateArgs.certFile = arg.slice("--cert-file=".length);
        } else if (arg.startsWith("--key=")) {
            certificateArgs.keyFile = arg.slice("--key=".length);
        } else if (arg === "--key" || arg === "--key-file") {
            certificateArgs.keyFile = readOptionValue(args, i, arg);
            i++;
        } else if (arg.startsWith("--key-file=")) {
            certificateArgs.keyFile = arg.slice("--key-file=".length);
        } else if (arg.startsWith("--ca=")) {
            certificateArgs.caFile = arg.slice("--ca=".length);
        } else if (arg === "--ca" || arg === "--ca-file") {
            certificateArgs.caFile = readOptionValue(args, i, arg);
            i++;
        } else if (arg.startsWith("--ca-file=")) {
            certificateArgs.caFile = arg.slice("--ca-file=".length);
        }
    }

    return certificateArgs;
}

export function loadCertificateOptions(
    args: string[],
): ServerOptions | undefined {
    const { certFile, keyFile, caFile } = parseCertificateFileArgs(args);

    if (!certFile && !keyFile && !caFile) return undefined;

    if (!certFile || !keyFile) {
        throw new Error("Both --cert and --key are required to enable HTTPS");
    }

    return {
        cert: readFileSync(certFile),
        key: readFileSync(keyFile),
        ca: caFile ? readFileSync(caFile) : undefined,
    };
}
