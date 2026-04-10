#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

INTERRUPTION_MARKERS = {
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
}


def truncate_text(text: str | None, limit: int = 400) -> str | None:
    if text is None:
        return None
    text = text.strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def is_interruption_marker_text(text: str) -> bool:
    stripped = text.strip()
    if stripped in INTERRUPTION_MARKERS:
        return True
    return any(line.strip() in INTERRUPTION_MARKERS for line in stripped.splitlines())


def extract_message_text_parts(content: Any) -> list[str]:
    if isinstance(content, str):
        stripped = content.strip()
        return [stripped] if stripped else []
    if not isinstance(content, list):
        return []
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text" and isinstance(item.get("text"), str):
            stripped = item["text"].strip()
            if stripped:
                parts.append(stripped)
    return parts


def extract_tool_use_names(content: Any) -> list[str]:
    if not isinstance(content, list):
        return []
    names: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "tool_use" and isinstance(item.get("name"), str):
            names.append(item["name"])
    return names


def has_tool_result(content: Any) -> bool:
    if not isinstance(content, list):
        return False
    return any(isinstance(item, dict) and item.get("type") == "tool_result" for item in content)


def summarize_message_payload(message: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    if isinstance(message.get("role"), str):
        summary["role"] = message["role"]
    text_parts = extract_message_text_parts(message.get("content"))
    if text_parts:
        merged = "\n".join(text_parts)
        summary["text_preview"] = truncate_text(merged)
        summary["has_interruption_marker"] = is_interruption_marker_text(merged)
    tool_use_names = extract_tool_use_names(message.get("content"))
    if tool_use_names:
        summary["tool_use_names"] = tool_use_names
    if has_tool_result(message.get("content")):
        summary["has_tool_result"] = True
    return summary


def summarize_progress_payload(data: Any) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    if not isinstance(data, dict):
        return summary
    if isinstance(data.get("type"), str):
        summary["progress_type"] = data["type"]
    if isinstance(data.get("agentId"), str):
        summary["progress_agent_id"] = data["agentId"]

    raw_message = data.get("message")
    if isinstance(raw_message, dict):
        if isinstance(raw_message.get("type"), str):
            summary["progress_message_type"] = raw_message["type"]
        if isinstance(raw_message.get("timestamp"), str):
            summary["progress_message_timestamp"] = raw_message["timestamp"]
        nested_message = raw_message.get("message")
        if isinstance(nested_message, dict):
            nested_summary = summarize_message_payload(nested_message)
            if isinstance(nested_summary.get("role"), str):
                summary["nested_role"] = nested_summary["role"]
            if isinstance(nested_summary.get("text_preview"), str):
                summary["text_preview"] = nested_summary["text_preview"]
            if isinstance(nested_summary.get("tool_use_names"), list):
                summary["tool_use_names"] = nested_summary["tool_use_names"]
            if nested_summary.get("has_tool_result"):
                summary["has_tool_result"] = True
            if nested_summary.get("has_interruption_marker"):
                summary["has_interruption_marker"] = True
    return summary


def parse_jsonl(path: Path) -> tuple[list[dict[str, Any]], int]:
    records: list[dict[str, Any]] = []
    malformed_lines = 0
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
            if isinstance(record, dict):
                records.append(record)
    return records, malformed_lines


def summarize_subagents(session_dir: Path) -> list[dict[str, Any]]:
    subagents_dir = session_dir / "subagents"
    if not subagents_dir.exists():
        return []
    summaries: list[dict[str, Any]] = []
    for transcript in sorted(subagents_dir.glob("*.jsonl")):
        record_count = 0
        malformed_lines = 0
        last_timestamp: str | None = None
        with transcript.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    malformed_lines += 1
                    continue
                if not isinstance(record, dict):
                    continue
                record_count += 1
                if isinstance(record.get("timestamp"), str):
                    last_timestamp = record["timestamp"]
        meta_path = transcript.with_suffix(".meta.json")
        meta: dict[str, Any] | None = None
        if meta_path.exists():
            try:
                loaded = json.loads(meta_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    meta = loaded
            except Exception:
                meta = None
        summaries.append(
            {
                "transcript_path": str(transcript),
                "record_count": record_count,
                "malformed_lines": malformed_lines,
                "last_timestamp": last_timestamp,
                "meta": meta,
            }
        )
    return summaries


def summarize_tool_results(session_dir: Path) -> list[dict[str, Any]]:
    tool_results_dir = session_dir / "tool-results"
    if not tool_results_dir.exists():
        return []
    results: list[dict[str, Any]] = []
    for path in sorted(tool_results_dir.glob("*.txt")):
        try:
            preview = truncate_text(path.read_text(encoding="utf-8"), 300)
        except Exception:
            preview = None
        results.append({"path": str(path), "preview": preview})
    return results


def summarize_record(record: dict[str, Any], index: int) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "index": index,
        "type": record.get("type"),
        "timestamp": record.get("timestamp"),
    }

    if isinstance(record.get("sessionId"), str):
        summary["session_id"] = record["sessionId"]
    if isinstance(record.get("cwd"), str):
        summary["cwd"] = record["cwd"]

    message = record.get("message")
    if isinstance(message, dict):
        summary.update(summarize_message_payload(message))

    if record.get("type") == "last-prompt" and isinstance(record.get("lastPrompt"), str):
        summary["last_prompt"] = truncate_text(record["lastPrompt"])
    if record.get("type") == "system":
        if isinstance(record.get("subtype"), str):
            summary["subtype"] = record["subtype"]
        if isinstance(record.get("durationMs"), int):
            summary["duration_ms"] = record["durationMs"]
    if record.get("type") == "progress":
        summary.update(summarize_progress_payload(record.get("data")))
        if isinstance(record.get("toolUseID"), str):
            summary["tool_use_id"] = record["toolUseID"]
        if isinstance(record.get("parentToolUseID"), str):
            summary["parent_tool_use_id"] = record["parentToolUseID"]
    if record.get("type") == "file-history-snapshot":
        snapshot = record.get("snapshot")
        if isinstance(snapshot, dict) and isinstance(snapshot.get("timestamp"), str):
            summary["snapshot_timestamp"] = snapshot["timestamp"]

    return summary


def collect_records(records: list[dict[str, Any]], record_type: str, limit: int) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    matches: list[tuple[int, dict[str, Any]]] = []
    for index, record in enumerate(records, start=1):
        if record.get("type") == record_type:
            matches.append((index, record))
    matches = matches[-limit:]
    return [summarize_record(record, index) for index, record in matches]


def collect_message_role_records(records: list[dict[str, Any]], role: str, limit: int) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    matches: list[tuple[int, dict[str, Any]]] = []
    for index, record in enumerate(records, start=1):
        if record.get("type") not in {"user", "assistant"}:
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        if message.get("role") != role:
            continue
        matches.append((index, record))
    matches = matches[-limit:]
    return [summarize_record(record, index) for index, record in matches]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read one Claude Code session transcript and return structured evidence slices")
    parser.add_argument("--session-file", required=True, help="Path to a session JSONL file")
    parser.add_argument("--tail-records", type=int, default=25, help="How many trailing records to include")
    parser.add_argument("--user-records", type=int, default=5, help="How many recent user records to include")
    parser.add_argument("--assistant-records", type=int, default=5, help="How many recent assistant records to include")
    parser.add_argument("--progress-records", type=int, default=5, help="How many recent progress records to include")
    parser.add_argument("--last-prompt-records", type=int, default=3, help="How many recent last-prompt records to include")
    parser.add_argument("--include-subagents", action="store_true", help="List subagent sidecar files")
    parser.add_argument("--include-tool-results", action="store_true", help="List tool result text files")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    session_file = Path(args.session_file).expanduser().resolve()
    records, malformed_lines = parse_jsonl(session_file)

    record_counts: Counter[str] = Counter()
    interruption_count = 0
    first_timestamp: str | None = None
    last_timestamp: str | None = None
    session_id = session_file.stem
    cwd: str | None = None
    git_branch: str | None = None
    last_prompt_record: str | None = None

    for record in records:
        record_type = record.get("type")
        if isinstance(record_type, str):
            record_counts[record_type] += 1
        if first_timestamp is None and isinstance(record.get("timestamp"), str):
            first_timestamp = record["timestamp"]
        if isinstance(record.get("timestamp"), str):
            last_timestamp = record["timestamp"]
        if isinstance(record.get("sessionId"), str):
            session_id = record["sessionId"]
        if cwd is None and isinstance(record.get("cwd"), str):
            cwd = record["cwd"]
        if git_branch is None and isinstance(record.get("gitBranch"), str):
            git_branch = record["gitBranch"]
        if record_type == "last-prompt" and isinstance(record.get("lastPrompt"), str):
            last_prompt_record = record["lastPrompt"]
        message = record.get("message")
        if isinstance(message, dict):
            merged = "\n".join(extract_message_text_parts(message.get("content")))
            if merged and is_interruption_marker_text(merged):
                interruption_count += 1

    tail_count = max(args.tail_records, 0)
    tail_records = records[-tail_count:] if tail_count > 0 else []
    tail_summaries = [
        summarize_record(record, len(records) - len(tail_records) + offset + 1)
        for offset, record in enumerate(tail_records)
    ]

    session_dir = session_file.with_suffix("")
    payload: dict[str, Any] = {
        "session_file": str(session_file),
        "session_id": session_id,
        "cwd": cwd,
        "git_branch": git_branch,
        "record_count": len(records),
        "record_counts": dict(record_counts),
        "malformed_lines": malformed_lines,
        "interruption_count": interruption_count,
        "first_timestamp": first_timestamp,
        "last_timestamp": last_timestamp,
        "last_prompt_record": last_prompt_record,
        "tail_records_requested": tail_count,
        "tail_records": tail_summaries,
        "user_records": collect_message_role_records(records, "user", max(args.user_records, 0)),
        "assistant_records": collect_message_role_records(records, "assistant", max(args.assistant_records, 0)),
        "progress_records": collect_records(records, "progress", max(args.progress_records, 0)),
        "last_prompt_records": collect_records(records, "last-prompt", max(args.last_prompt_records, 0)),
    }
    if args.include_subagents:
        payload["subagents"] = summarize_subagents(session_dir)
    if args.include_tool_results:
        payload["tool_results"] = summarize_tool_results(session_dir)

    if args.json:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0

    print(f"session_file: {payload['session_file']}")
    print(f"session_id: {payload['session_id']}")
    print(f"cwd: {payload['cwd']}")
    print(f"git_branch: {payload['git_branch']}")
    print(f"record_count: {payload['record_count']}")
    print(f"record_counts: {payload['record_counts']}")
    print(f"malformed_lines: {payload['malformed_lines']}")
    print(f"interruption_count: {payload['interruption_count']}")
    print(f"first_timestamp: {payload['first_timestamp']}")
    print(f"last_timestamp: {payload['last_timestamp']}")
    print(f"last_prompt_record: {payload['last_prompt_record']}")
    print(f"tail_records_requested: {payload['tail_records_requested']}")
    print("tail_records:")
    for item in payload["tail_records"]:
        print(json.dumps(item, ensure_ascii=False))
    print("user_records:")
    for item in payload["user_records"]:
        print(json.dumps(item, ensure_ascii=False))
    print("assistant_records:")
    for item in payload["assistant_records"]:
        print(json.dumps(item, ensure_ascii=False))
    print("progress_records:")
    for item in payload["progress_records"]:
        print(json.dumps(item, ensure_ascii=False))
    print("last_prompt_records:")
    for item in payload["last_prompt_records"]:
        print(json.dumps(item, ensure_ascii=False))
    if args.include_subagents:
        print("subagents:")
        for item in payload["subagents"]:
            print(json.dumps(item, ensure_ascii=False))
    if args.include_tool_results:
        print("tool_results:")
        for item in payload["tool_results"]:
            print(json.dumps(item, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
