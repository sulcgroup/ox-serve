#!/usr/bin/env python3

import json
import time
from pathlib import Path
from datetime import datetime, timezone

from rich.console import Console
from rich.live import Live
from rich.layout import Layout
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

LOG_DIR = Path("./logs")
LIVE_STATUS = LOG_DIR / "live_status.json"
SESSIONS = LOG_DIR / "sessions.jsonl"
USAGE_TIMESERIES = LOG_DIR / "usage_timeseries.jsonl"
SIMULATION_EVENTS = LOG_DIR / "simulation_events.jsonl"
CONFIG = Path("./resources/config.json")

console = Console(force_terminal=True, color_system="standard")


def load_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def load_jsonl(path, limit=None):
    if not path.exists():
        return []

    try:
        lines = path.read_text().splitlines()
    except Exception:
        return []

    if limit is not None:
        lines = lines[-limit:]

    rows = []
    for line in lines:
        try:
            rows.append(json.loads(line))
        except Exception:
            pass

    return rows


def fmt_ms(ms):
    seconds = int((ms or 0) / 1000)
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}:{seconds % 60:02d}"


def fmt_bytes(n):
    n = float(n or 0)

    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024

    return f"{n:.1f} PB"


def parse_iso(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def active_duration(connected_at):
    dt = parse_iso(connected_at)
    if not dt:
        return 0

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    return int((datetime.now(timezone.utc) - dt).total_seconds() * 1000)


def sparkline(values, maximum=10, width=100):
    chars = " ▁▂▃▄▅▆▇█"

    values = list(values)[-width:]
    if not values:
        return "no data"

    maximum = int(maximum or 10)

    out = ""
    for v in values:
        v = int(v or 0)
        v = min(max(v, 0), maximum)

        if v == 0:
            out += " "
        else:
            ratio = v / maximum
            out += chars[max(1, int(round(ratio * (len(chars) - 1))))]

    return out


def status_style(value, kind="generic"):
    if kind == "exit":
        return "green" if str(value) == "0" else "red"

    if kind == "fail":
        return "green" if int(value or 0) == 0 else "red"

    if kind == "active":
        return "green" if int(value or 0) > 0 else "dim"

    return "white"


def make_header(live, sessions, usage, sim_events, config):
    active_sessions = live.get("activeSessions", [])
    active_count = len(active_sessions)

    max_connections = int(
        config.get("allowed_connections", live.get("allowedConnections", 10)) or 10
    )

    active_connected_ms = sum(
        active_duration(str(s.get("connectedAt", ""))) for s in active_sessions
    )

    total_started = sum(1 for e in sim_events if e.get("event") == "started")
    total_finished = sum(1 for e in sim_events if e.get("event") == "finished")
    total_errors = sum(1 for e in sim_events if e.get("event") == "error")

    total_upload = sum(int(s.get("bytesReceived", 0) or 0) for s in sessions)
    total_download = sum(int(s.get("bytesSent", 0) or 0) for s in sessions)

    active_upload = sum(int(s.get("bytesReceived", 0) or 0) for s in active_sessions)
    active_download = sum(int(s.get("bytesSent", 0) or 0) for s in active_sessions)

    peak_sessions = max(
        [int(u.get("activeSessionCount", 0)) for u in usage],
        default=active_count,
    )

    peak_sims = max(
        [int(u.get("activeSimulationCount", 0)) for u in usage],
        default=0,
    )

    text = Text()
    text.append("ox-serve dashboard\n", style="bold cyan")
    text.append(f"Updated: {datetime.now().isoformat(timespec='seconds')}\n", style="dim")
    text.append("Active sessions: ", style="bold")
    text.append(f"{active_count}/{max_connections}", style="green" if active_count else "dim")
    text.append("   Peak sessions: ", style="bold")
    text.append(f"{peak_sessions}/{max_connections}", style="yellow" if peak_sessions else "dim")
    text.append("   Active runtime: ", style="bold")
    text.append(f"{fmt_ms(active_connected_ms)}\n", style="cyan")

    text.append("Active simulations: ", style="bold")
    text.append(str(live.get("activeSimulationCount", 0)), style="green" if live.get("activeSimulationCount", 0) else "dim")
    text.append("   Peak simulations: ", style="bold")
    text.append(str(peak_sims), style="yellow" if peak_sims else "dim")
    text.append("   Closed sessions: ", style="bold")
    text.append(f"{len(sessions)}\n", style="cyan")

    text.append("Simulations started: ", style="bold")
    text.append(str(total_started), style="cyan")
    text.append("   finished: ", style="bold")
    text.append(str(total_finished), style="green")
    text.append("   errors: ", style="bold")
    text.append(f"{total_errors}\n", style="red" if total_errors else "green")

    text.append("Active upload: ", style="bold")
    text.append(fmt_bytes(active_upload), style="magenta")
    text.append("   active download: ", style="bold")
    text.append(fmt_bytes(active_download), style="blue")
    text.append("   closed upload: ", style="bold")
    text.append(fmt_bytes(total_upload), style="magenta")
    text.append("   closed download: ", style="bold")
    text.append(fmt_bytes(total_download), style="blue")

    return Panel(text, title="Status", border_style="cyan")


def make_usage_plot(usage, config):
    max_connections = int(config.get("allowed_connections", 10) or 10)
    plot_max = max(10, max_connections)

    sessions = [int(u.get("activeSessionCount", 0)) for u in usage]
    simulations = [int(u.get("activeSimulationCount", 0)) for u in usage]

    current_sessions = sessions[-1] if sessions else 0
    current_sims = simulations[-1] if simulations else 0

    text = Text()
    text.append("Active sessions\n", style="bold green")
    text.append(sparkline(sessions, plot_max, width=100) + "\n", style="green")
    text.append(
        f"Scale: 0–{plot_max}   "
        f"Current: {current_sessions}/{max_connections}   "
        f"Peak: {max(sessions, default=0)}/{max_connections}\n\n",
        style="dim",
    )

    text.append("Active simulations\n", style="bold yellow")
    text.append(sparkline(simulations, plot_max, width=100) + "\n", style="yellow")
    text.append(
        f"Scale: 0–{plot_max}   "
        f"Current: {current_sims}   "
        f"Peak: {max(simulations, default=0)}",
        style="dim",
    )

    return Panel(text, title="Usage over time", border_style="green")


def make_active_table(live):
    table = Table(title="Active Sessions", expand=True, header_style="bold cyan")
    table.add_column("Session", style="cyan")
    table.add_column("Browser", style="white")
    table.add_column("Duration", style="green")
    table.add_column("Msg", justify="right", style="yellow")
    table.add_column("Sim", justify="right", style="yellow")
    table.add_column("Upload", justify="right", style="magenta")
    table.add_column("Download", justify="right", style="blue")
    table.add_column("Current job", style="green")

    active = live.get("activeSessions", [])

    if not active:
        table.add_row("-", "-", "-", "-", "-", "-", "-", "[dim]No active sessions[/dim]")
        return table

    for s in active:
        connected_at = str(s.get("connectedAt", ""))
        current = s.get("currentSimulation") or {}

        if current:
            job = (
                f"[green]{current.get('interactionType', 'unknown')} "
                f"{current.get('bases', 0)} nt[/green]"
            )
        else:
            job = "[dim]-[/dim]"

        table.add_row(
            str(s.get("sessionId", ""))[:8],
            str(s.get("browser", "unknown")),
            fmt_ms(active_duration(connected_at)),
            str(s.get("messages", 0)),
            str(s.get("simulationsStarted", 0)),
            fmt_bytes(s.get("bytesReceived", 0)),
            fmt_bytes(s.get("bytesSent", 0)),
            job,
        )

    return table


def make_simulation_activity_plot(sim_events):
    now = datetime.now(timezone.utc)
    current_hour = now.replace(minute=0, second=0, microsecond=0)

    hourly = []

    for i in range(23, -1, -1):
        hour_start = current_hour.timestamp() - i * 3600
        dt = datetime.fromtimestamp(hour_start, timezone.utc)

        hourly.append(
            {
                "start": dt,
                "label": dt.strftime("%H"),
                "started": 0,
                "finished": 0,
                "failed": 0,
            }
        )

    for e in sim_events:
        dt = parse_iso(e.get("timestamp"))
        if not dt:
            continue

        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)

        event_hour = dt.replace(minute=0, second=0, microsecond=0)

        for h in hourly:
            if h["start"] == event_hour:
                event = e.get("event")

                if event == "started":
                    h["started"] += 1
                elif event == "finished":
                    if e.get("exitCode") in (0, "0"):
                        h["finished"] += 1
                    else:
                        h["failed"] += 1
                elif event == "error":
                    h["failed"] += 1

                break

    started_values = [h["started"] for h in hourly]
    finished_values = [h["finished"] for h in hourly]
    failed_values = [h["failed"] for h in hourly]

    max_value = max(
        max(started_values, default=0),
        max(finished_values, default=0),
        max(failed_values, default=0),
        10,
    )

    total_started = sum(started_values)
    total_finished = sum(finished_values)
    total_failed = sum(failed_values)

    busiest = max(hourly, key=lambda h: h["started"])

    def compact_bar(value, maximum, width=10):
        if value <= 0:
            return " " * width

        filled = max(1, int(width * value / maximum))
        return "█" * filled + " " * (width - filled)

    table = Table(title="Simulation activity, last 24 h", expand=True, header_style="bold cyan")
    table.add_column("Hour", justify="right", style="cyan")
    table.add_column("Start", justify="right", style="yellow")
    table.add_column("OK", justify="right", style="green")
    table.add_column("Fail", justify="right", style="red")
    table.add_column("Load", style="yellow")

    for h in hourly:
        if h["started"] == 0 and h["finished"] == 0 and h["failed"] == 0:
            continue

        table.add_row(
            h["label"],
            str(h["started"]),
            str(h["finished"]),
            str(h["failed"]),
            f"[yellow]{compact_bar(h['started'], max_value, width=12)}[/yellow]",
        )

    if total_started == 0 and total_finished == 0 and total_failed == 0:
        table.add_row("-", "0", "0", "0", "[dim]No activity in last 24 h[/dim]")

    summary = Text()
    summary.append("Last 24 h: ", style="bold")
    summary.append(f"started {total_started}", style="yellow")
    summary.append(", ")
    summary.append(f"OK {total_finished}", style="green")
    summary.append(", ")
    summary.append(f"failed {total_failed}\n", style="red" if total_failed else "green")
    summary.append(
        f"Busiest start hour: {busiest['label']}:00 "
        f"with {busiest['started']} starts",
        style="cyan",
    )

    panel = Layout()
    panel.split_column(
        Layout(Panel(summary, title="Summary", border_style="yellow"), size=4),
        Layout(table),
    )

    return panel


def make_workload_table(sim_events):
    finished = [e for e in sim_events if e.get("event") == "finished"]

    table = Table(title="Recent Simulation Workload", expand=True, header_style="bold cyan")
    table.add_column("Time", style="cyan")
    table.add_column("Type", style="white")
    table.add_column("Bases", justify="right", style="yellow")
    table.add_column("Strands", justify="right", style="yellow")
    table.add_column("Runtime", style="green")
    table.add_column("Exit", justify="right")
    table.add_column("Flags", style="magenta")

    if not finished:
        table.add_row("-", "-", "-", "-", "-", "-", "-")
        return table

    for e in finished[-12:][::-1]:
        flags = []
        if e.get("hasExternalForces"):
            flags.append("forces")
        if e.get("hasANM"):
            flags.append("ANM")

        exit_code = str(e.get("exitCode", "-"))
        exit_cell = f"[green]{exit_code}[/green]" if exit_code == "0" else f"[red]{exit_code}[/red]"

        table.add_row(
            str(e.get("timestamp", ""))[11:19],
            str(e.get("interactionType", "unknown")),
            str(e.get("bases", 0)),
            str(e.get("strands", 0)),
            fmt_ms(int(e.get("runtimeMs", 0))),
            exit_cell,
            ",".join(flags) if flags else "[dim]-[/dim]",
        )

    return table


def make_recent_table(sessions):
    table = Table(title="Recent Closed Sessions", expand=True, header_style="bold cyan")
    table.add_column("Session", style="cyan")
    table.add_column("Browser", style="white")
    table.add_column("Duration", style="green")
    table.add_column("Msg", justify="right", style="yellow")
    table.add_column("Sim", justify="right", style="yellow")
    table.add_column("Upload", justify="right", style="magenta")
    table.add_column("Download", justify="right", style="blue")

    for s in sessions[-10:][::-1]:
        table.add_row(
            str(s.get("sessionId", ""))[:8],
            str(s.get("browser", "unknown")),
            fmt_ms(int(s.get("durationMs", 0))),
            str(s.get("messages", 0)),
            str(s.get("simulationsStarted", 0)),
            fmt_bytes(s.get("bytesReceived", 0)),
            fmt_bytes(s.get("bytesSent", 0)),
        )

    if not sessions:
        table.add_row("-", "-", "-", "-", "-", "-", "-")

    return table


def build_dashboard():
    live = load_json(LIVE_STATUS, {})
    sessions = load_jsonl(SESSIONS, limit=1000)
    usage = load_jsonl(USAGE_TIMESERIES, limit=1000)
    sim_events = load_jsonl(SIMULATION_EVENTS, limit=3000)
    config = load_json(CONFIG, {})

    layout = Layout()

    layout.split_column(
        Layout(make_header(live, sessions, usage, sim_events, config), size=8),
        Layout(make_usage_plot(usage, config), size=8),
        Layout(name="main"),
    )

    layout["main"].split_row(
        Layout(name="left"),
        Layout(name="right"),
    )

    layout["left"].split_column(
        Layout(make_active_table(live), ratio=1),
        Layout(make_recent_table(sessions), ratio=1),
    )

    layout["right"].split_column(
        Layout(make_simulation_activity_plot(sim_events), ratio=1),
        Layout(make_workload_table(sim_events), ratio=1),
    )

    return layout


def main():
    with Live(
        build_dashboard(),
        refresh_per_second=0.25,
        console=console,
        screen=False,
        transient=False,
    ) as live:
        while True:
            live.update(build_dashboard())
            time.sleep(4)


if __name__ == "__main__":
    main()