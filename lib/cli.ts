export type CliOptions = {
    configFile: string;
    showHelp: boolean;
};

function readOptionValue(args: string[], index: number, name: string): string {
    const value = args[index + 1];

    if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${name}`);
    }

    return value;
}

export function parseCliOptions(args: string[]): CliOptions {
    const options: CliOptions = {
        configFile: "./resources/config.json",
        showHelp: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--help" || arg === "-h") {
            options.showHelp = true;
        } else if (arg === "--config") {
            options.configFile = readOptionValue(args, i, arg);
            i++;
        } else if (arg.startsWith("--config=")) {
            options.configFile = arg.slice("--config=".length);
        }
    }

    return options;
}

export function getHelpText(): string {
    return `Usage: node dist/main.js [options]

Options:
  --config <path>       Path to config JSON file. Defaults to ./resources/config.json.
  --cert <path>         TLS certificate file. Requires --key.
  --cert-file <path>    Alias for --cert.
  --key <path>          TLS private key file. Requires --cert.
  --key-file <path>     Alias for --key.
  --ca <path>           Optional TLS certificate authority bundle.
  --ca-file <path>      Alias for --ca.
  -h, --help            Show this help text.
`;
}
