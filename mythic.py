"""Validate authoritative Xbox BaseGame completion; never infer an award."""
from __future__ import annotations
from datetime import datetime


def parse_mythic(data: dict, title_id: str) -> tuple[dict | None, dict[str, bool]]:
    if not isinstance(data, dict) or data.get("schema") != 1 or data.get("titleId") != title_id:
        raise ValueError("Invalid Mythic response.")
    group = data.get("mythic")
    if not isinstance(group, dict):
        return None, {}
    group_id = group.get("groupId")
    total, unlocked = group.get("totalCount"), group.get("unlockedCount")
    if (not isinstance(group_id, str) or not group_id or len(group_id) > 180
            or type(total) is not int or not 0 < total <= 500
            or type(unlocked) is not int or not 0 <= unlocked <= total
            or type(group.get("unlocked")) is not bool):
        return None, {}
    date = group.get("completedTime")
    completed_at = None
    if isinstance(date, str) and len(date) <= 40:
        try:
            parsed = datetime.fromisoformat(date.replace("Z", "+00:00"))
            if parsed.tzinfo is not None and parsed.timestamp() >= 0:
                completed_at = int(parsed.timestamp() * 1000)
        except (ValueError, OverflowError, OSError):
            pass
    members = {}
    items = data.get("items")
    if isinstance(items, list) and len(items) <= 500:
        for item in items:
            if (isinstance(item, dict) and isinstance(item.get("id"), str)
                    and 0 < len(item["id"]) <= 180 and type(item.get("baseGame")) is bool):
                members[item["id"]] = item["baseGame"]
    return {"groupId": group_id, "unlocked": group["unlocked"], "totalCount": total,
            "unlockedCount": unlocked, "completedAt": completed_at}, members


class MythicTracker:
    def __init__(self):
        self.seen = {}

    def observe(self, account: str, title_id: str, group: dict) -> bool:
        if not account:
            return False
        key = (account, title_id, group["groupId"])
        previous = self.seen.get(key)
        earned = group["unlocked"] is True
        self.seen[key] = previous is True or earned
        # Seed history silently; a later authoritative false -> true is new.
        return previous is False and earned
