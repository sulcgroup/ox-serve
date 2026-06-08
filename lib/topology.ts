export function parseTopologyStats(
    topologyText: string,
): { bases: number; strands: number } {
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
