#!/usr/bin/env python3

import json
from pathlib import Path
from collections import Counter, defaultdict
from datetime import datetime

from rich.console import Console
from rich.table import Table

LOG_DIR = Path("./logs")

SESSIONS = LOG_DIR / "sessions.jsonl"
SIM_EVENTS = LOG_DIR / "simulation_events.jsonl"
LIVE_STATUS = LOG_DIR / "live_status.json"

console = Console(force_terminal=True, color_system="standard")


def load_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def load_jsonl(path):
    if not path.exists():
        return []

    rows = []
    for line in path.read_text().splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    return rows


def parse_dt(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def iso_year_week(dt):
    iso = dt.isocalendar()
    return iso[0], iso[1]


def fmt_ms(ms):
    seconds = int((ms or 0) / 1000)

    d = seconds // 86400
    seconds %= 86400

    h = seconds // 3600
    seconds %= 3600

    m = seconds // 60
    s = seconds % 60

    if d:
        return f"{d}d {h}h {m}m"

    return f"{h}h {m}m {s}s"


def fmt_bytes(n):
    n = float(n or 0)

    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024

    return f"{n:.1f} PB"


def period_stats(events, period="month"):
    rows = defaultdict(
        lambda: {
            "started": 0,
            "completed": 0,
            "failed": 0,
            "bases": 0,
            "runtimeMs": 0,
            "runtimeCount": 0,
        }
    )

    for e in events:
        dt = parse_dt(e.get("timestamp"))
        if not dt:
            continue

        if period == "month":
            key = dt.strftime("%Y-%m")
        elif period == "week":
            year, week = iso_year_week(dt)
            key = f"{year}-W{week:02d}"
        else:
            raise ValueError(period)

        event = e.get("event")

        if event == "started":
            rows[key]["started"] += 1

        elif event == "finished":
            rows[key]["completed"] += 1
            rows[key]["bases"] += int(e.get("bases", 0) or 0)

            runtime = int(e.get("runtimeMs", 0) or 0)
            if runtime > 0:
                rows[key]["runtimeMs"] += runtime
                rows[key]["runtimeCount"] += 1

            if e.get("exitCode") not in (0, "0"):
                rows[key]["failed"] += 1

        elif event == "error":
            rows[key]["failed"] += 1

    return rows


def failure_rate(row):
    started = row["started"]
    if not started:
        return 0.0
    return 100.0 * row["failed"] / started


def fail_color(rate):
    if rate > 20:
        return "red"
    if rate > 5:
        return "yellow"
    return "green"


def print_period_table(title, stats):
    console.print(f"\n[bold cyan]{title}[/bold cyan]")

    if not stats:
        console.print("[dim]No data.[/dim]\n")
        return

    table = Table(header_style="bold cyan")
    table.add_column("Period", style="cyan")
    table.add_column("Started", justify="right", style="yellow")
    table.add_column("Done", justify="right", style="green")
    table.add_column("Failed", justify="right", style="red")
    table.add_column("Fail %", justify="right")
    table.add_column("Bases", justify="right", style="magenta")
    table.add_column("Avg Runtime", justify="right", style="blue")

    for period, r in sorted(stats.items()):
        avg_runtime = (
            r["runtimeMs"] / r["runtimeCount"]
            if r["runtimeCount"]
            else 0
        )

        rate = failure_rate(r)
        color = fail_color(rate)

        table.add_row(
            period,
            str(r["started"]),
            str(r["completed"]),
            str(r["failed"]),
            f"[{color}]{rate:.2f}%[/{color}]",
            f"{r['bases']:,}",
            fmt_ms(avg_runtime),
        )

    console.print(table)


def print_top_low(title, stats, key, label=None):
    label = label or key

    console.print(f"\n[bold cyan]{title}[/bold cyan]")

    rows = [(period, values[key]) for period, values in stats.items()]
    rows = [row for row in rows if row[1] > 0]

    if not rows:
        console.print("[dim]No non-zero data.[/dim]")
        return

    rows_sorted = sorted(rows, key=lambda x: x[1])

    low_period, low_value = rows_sorted[0]
    top_period, top_value = rows_sorted[-1]

    console.print(f"Lowest {label:14}: [yellow]{low_period:12}[/yellow] [dim]{low_value:,}[/dim]")
    console.print(f"Highest {label:13}: [green]{top_period:12}[/green] [bold green]{top_value:,}[/bold green]")


def print_counter_table(title, key_name, counter, key_style="cyan"):
    console.print(f"\n[bold cyan]{title}[/bold cyan]")

    table = Table(header_style="bold cyan")
    table.add_column(key_name, style=key_style)
    table.add_column("Count", justify="right", style="green")

    if not counter:
        table.add_row("-", "0")
    else:
        for key, count in counter.most_common():
            table.add_row(str(key), str(count))

    console.print(table)


sessions = load_jsonl(SESSIONS)
events = load_jsonl(SIM_EVENTS)
live = load_json(LIVE_STATUS, {})

active_sessions = live.get("activeSessionCount", 0)

total_connected_ms = sum(int(s.get("durationMs", 0) or 0) for s in sessions)
total_messages = sum(int(s.get("messages", 0) or 0) for s in sessions)
total_upload = sum(int(s.get("bytesReceived", 0) or 0) for s in sessions)
total_download = sum(int(s.get("bytesSent", 0) or 0) for s in sessions)

browser_counter = Counter()
for s in sessions:
    browser_counter[s.get("browser", "unknown")] += 1

total_started = sum(1 for e in events if e.get("event") == "started")
total_completed = sum(1 for e in events if e.get("event") == "finished")
total_errors = sum(1 for e in events if e.get("event") == "error")

bases_total = 0
bases_max = 0
runtimes = []

interaction_counter = Counter()
flag_counter = Counter()

for e in events:
    if e.get("event") == "started":
        interaction_counter[e.get("interactionType", "unknown")] += 1

        if e.get("hasExternalForces"):
            flag_counter["external forces"] += 1
        if e.get("hasANM"):
            flag_counter["ANM"] += 1

    if e.get("event") != "finished":
        continue

    bases = int(e.get("bases", 0) or 0)
    bases_total += bases
    bases_max = max(bases_max, bases)

    runtime = int(e.get("runtimeMs", 0) or 0)
    if runtime > 0:
        runtimes.append(runtime)

avg_runtime = sum(runtimes) / len(runtimes) if runtimes else 0

monthly = period_stats(events, "month")
weekly = period_stats(events, "week")

console.print()
console.rule("[bold cyan]OX-SERVE USAGE SUMMARY[/bold cyan]")
console.print()

console.print("[bold yellow]CURRENT[/bold yellow]")
console.print(f"Active sessions         : [green]{active_sessions}[/green]")
console.print()

console.print("[bold yellow]USAGE[/bold yellow]")
console.print(f"Closed sessions         : [cyan]{len(sessions)}[/cyan]")
console.print(f"Connected time          : [green]{fmt_ms(total_connected_ms)}[/green]")
console.print(f"Messages                : [yellow]{total_messages:,}[/yellow]")
console.print(f"Upload                  : [magenta]{fmt_bytes(total_upload)}[/magenta]")
console.print(f"Download                : [blue]{fmt_bytes(total_download)}[/blue]")
console.print()

console.print("[bold yellow]SIMULATIONS[/bold yellow]")
console.print(f"Started                 : [cyan]{total_started:,}[/cyan]")
console.print(f"Completed               : [green]{total_completed:,}[/green]")
console.print(f"Errors                  : [red]{total_errors:,}[/red]")

if total_started:
    rate = 100.0 * total_errors / total_started
    color = fail_color(rate)
    console.print(f"Error rate              : [{color}]{rate:.2f}%[/{color}]")

console.print(f"Total bases simulated   : [cyan]{bases_total:,}[/cyan]")
console.print(f"Largest system          : [yellow]{bases_max:,}[/yellow] bases")
console.print(f"Average runtime         : [green]{fmt_ms(avg_runtime)}[/green]")

print_period_table("USAGE PER MONTH", monthly)
print_top_low("MONTHLY SIMULATION TOP / LOW", monthly, "started", "started")
print_top_low("MONTHLY BASES TOP / LOW", monthly, "bases", "bases")

print_period_table("USAGE PER WEEK", weekly)
print_top_low("WEEKLY SIMULATION TOP / LOW", weekly, "started", "started")
print_top_low("WEEKLY BASES TOP / LOW", weekly, "bases", "bases")

print_counter_table("BROWSERS", "Browser", browser_counter)
print_counter_table("INTERACTION TYPES", "Type", interaction_counter)

console.print("\n[bold cyan]FLAGS[/bold cyan]")
flag_table = Table(header_style="bold cyan")
flag_table.add_column("Feature", style="magenta")
flag_table.add_column("Count", justify="right", style="green")

if flag_counter:
    for flag, count in flag_counter.most_common():
        flag_table.add_row(flag, str(count))
else:
    flag_table.add_row("No external forces or ANM usage logged", "0")

console.print(flag_table)
console.print()
