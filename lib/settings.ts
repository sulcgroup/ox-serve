import path from "path";

export type OxDNASettingValue = string | number | boolean;

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

function isForbiddenTransferKey(key: string): boolean {
    return FORBIDDEN_TRANSFER_KEYS.some((re) => re.test(key));
}

function validateScalarSetting(
    key: string,
    raw: unknown,
): OxDNASettingValue {
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
): Record<string, OxDNASettingValue> {
    const clean: Record<string, OxDNASettingValue> = {};

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

export function hasANMSettings(
    data: Record<string, unknown>,
    settings: Record<string, OxDNASettingValue>,
): boolean {
    return "par_file" in data || "parfile" in settings;
}

export function hasExternalForcesSettings(
    data: Record<string, unknown>,
    settings: Record<string, OxDNASettingValue>,
): boolean {
    return "trap_file" in data || settings["external_forces"] === "1";
}
