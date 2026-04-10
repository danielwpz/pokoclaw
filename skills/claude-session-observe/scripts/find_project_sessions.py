#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


def resolve_claude_dir(raw: str | None) -> Path:
    return Path(raw).expanduser().resolve() if raw else (Path.home() / ".claude")


def encode_project_path(project_path: Path) -> str:
    resolved = project_path.expanduser().resolve()
    normalized = resolved.as_posix().replace("\\", "/")
    return re.sub(r"[^A-Za-z0-9._-]", "-", normalized)


def safe_read_json(path: Path) -> dict[str, Any] | None:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return loaded if isinstance(loaded, dict) else None


def parse_iso_timestamp(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        if value.endswith("Z"):
            return dt.datetime.fromisoformat(value[:-1] + "+00:00")
        return dt.datetime.fromisoformat(value)
    except ValueError:
        return None


def iter_active_sessions(project_path: Path, sessions_dir: Path) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    wanted = str(project_path)
    if not sessions_dir.exists():
        return matches
    for session_file in sorted(sessions_dir.glob("*.json")):
        data = safe_read_json(session_file)
        if data is None or data.get("cwd") != wanted:
            continue
        matches.append(
            {
                "pid_file": str(session_file),
                "pid": data.get("pid"),
                "session_id": data.get("sessionId"),
                "cwd": data.get("cwd"),
                "started_at": data.get("startedAt"),
            }
        )
    return matches


def transcript_matches_project(path: Path, project_path: Path) -> bool:
    wanted = str(project_path)
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict) and record.get("cwd") == wanted:
                    return True
    except OSError:
        return False
    return False


def summarize_session_file(path: Path, active_session_ids: set[str]) -> dict[str, Any]:
    latest_timestamp: dt.datetime | None = None
    latest_timestamp_raw: str | None = None
    last_prompt_record: str | None = None
    last_user_timestamp: str | None = None
    last_assistant_timestamp: str | None = None
    last_progress_timestamp: str | None = None
    session_id = path.stem
    cwd: str | None = None
    git_branch: str | None = None
    parsed_lines = 0
    malformed_lines = 0
    record_counts: Counter[str] = Counter()
    user_assistant_count = 0

    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                malformed_lines += 1
                continue
            parsed_lines += 1
            if not isinstance(record, dict):
                continue

            record_type = record.get("type")
            if isinstance(record_type, str):
                record_counts[record_type] += 1
                if record_type in {"user", "assistant"}:
                    user_assistant_count += 1

            if cwd is None and isinstance(record.get("cwd"), str):
                cwd = record["cwd"]
            if git_branch is None and isinstance(record.get("gitBranch"), str):
                git_branch = record["gitBranch"]
            if isinstance(record.get("sessionId"), str):
                session_id = record["sessionId"]

            timestamp_candidates: list[str] = []
            if isinstance(record.get("timestamp"), str):
                timestamp_candidates.append(record["timestamp"])
            snapshot = record.get("snapshot")
            if isinstance(snapshot, dict) and isinstance(snapshot.get("timestamp"), str):
                timestamp_candidates.append(snapshot["timestamp"])
            for raw in timestamp_candidates:
                parsed = parse_iso_timestamp(raw)
                if parsed is not None and (latest_timestamp is None or parsed > latest_timestamp):
                    latest_timestamp = parsed
                    latest_timestamp_raw = raw

            if record_type == "user" and isinstance(record.get("timestamp"), str):
                last_user_timestamp = record["timestamp"]
            if record_type == "assistant" and isinstance(record.get("timestamp"), str):
                last_assistant_timestamp = record["timestamp"]
            if record_type == "progress" and isinstance(record.get("timestamp"), str):
                last_progress_timestamp = record["timestamp"]
            if record_type == "last-prompt" and isinstance(record.get("lastPrompt"), str):
                last_prompt_record = record["lastPrompt"]

    session_dir = path.with_suffix("")
    subagents_dir = session_dir / "subagents"
    tool_results_dir = session_dir / "tool-results"
    stat = path.stat()
    return {
        "session_id": session_id,
        "transcript_path": str(path),
        "cwd": cwd,
        "git_branch": git_branch,
        "is_active_match": session_id in active_session_ids,
        "last_timestamp": latest_timestamp_raw,
        "last_user_timestamp": last_user_timestamp,
        "last_assistant_timestamp": last_assistant_timestamp,
        "last_progress_timestamp": last_progress_timestamp,
        "last_prompt_record": last_prompt_record,
        "file_mtime": dt.datetime.fromtimestamp(stat.st_mtime, tz=dt.timezone.utc).isoformat(),
        "parsed_lines": parsed_lines,
        "malformed_lines": malformed_lines,
        "record_counts": dict(record_counts),
        "user_assistant_count": user_assistant_count,
        "has_sidecar_dir": session_dir.exists(),
        "subagent_count": len(list(subagents_dir.glob("*.jsonl"))) if subagents_dir.exists() else 0,
        "tool_result_file_count": len(list(tool_results_dir.glob("*.txt"))) if tool_results_dir.exists() else 0,
    }


def sort_key(item: dict[str, Any]) -> tuple[int, str, str]:
    return (
        1 if item.get("is_active_match") else 0,
        item.get("last_timestamp") or "",
        item.get("file_mtime") or "",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="List candidate Claude Code sessions for a project")
    parser.add_argument("--project", required=True, help="Absolute or user-relative project path")
    parser.add_argument("--claude-dir", help="Override Claude data dir (defaults to ~/.claude)")
    parser.add_argument("--limit", type=int, default=10, help="Max sessions to print")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument("--include-active", action="store_true", help="Include active-session PID entries in text output")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    claude_dir = resolve_claude_dir(args.claude_dir)
    projects_dir = claude_dir / "projects"
    sessions_dir = claude_dir / "sessions"

    project_path = Path(args.project).expanduser().resolve()
    project_dir = projects_dir / encode_project_path(project_path)

    active_sessions = iter_active_sessions(project_path, sessions_dir)
    active_session_ids = {
        item["session_id"] for item in active_sessions if isinstance(item.get("session_id"), str)
    }

    transcript_paths: list[Path] = []
    discovery_mode = "encoded-project-dir"
    if project_dir.exists():
        transcript_paths = sorted(project_dir.glob("*.jsonl"))
    if not transcript_paths:
        discovery_mode = "cwd-fallback-scan"
        for transcript in sorted(projects_dir.glob("*/*.jsonl")):
            if transcript_matches_project(transcript, project_path):
                transcript_paths.append(transcript)

    sessions = [summarize_session_file(transcript, active_session_ids) for transcript in transcript_paths]
    sessions.sort(key=sort_key, reverse=True)
    sessions = sessions[: max(args.limit, 0)]

    payload = {
        "claude_dir": str(claude_dir),
        "project_path": str(project_path),
        "encoded_project_dir": str(project_dir),
        "project_dir_exists": project_dir.exists(),
        "discovery_mode": discovery_mode,
        "active_sessions": active_sessions,
        "sessions": sessions,
    }

    if args.json:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0

    print(f"claude_dir: {payload['claude_dir']}")
    print(f"project_path: {payload['project_path']}")
    print(f"encoded_project_dir: {payload['encoded_project_dir']}")
    print(f"project_dir_exists: {payload['project_dir_exists']}")
    print(f"discovery_mode: {payload['discovery_mode']}")
    if args.include_active:
        print("active_sessions:")
        if active_sessions:
            for item in active_sessions:
                print(f"  - session_id={item.get('session_id')} pid={item.get('pid')} pid_file={item.get('pid_file')}")
        else:
            print("  - none")
    print("sessions:")
    if not sessions:
        print("  - none")
        return 0
    for item in sessions:
        print(
            f"  - session_id={item['session_id']} active={item['is_active_match']} last_timestamp={item['last_timestamp']} user_assistant_count={item['user_assistant_count']} malformed_lines={item['malformed_lines']}"
        )
        print(f"    transcript_path={item['transcript_path']}")
        print(f"    subagent_count={item['subagent_count']} tool_result_file_count={item['tool_result_file_count']}")
        if item.get("last_prompt_record"):
            print(f"    last_prompt_record={item['last_prompt_record']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
