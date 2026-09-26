#!/usr/bin/env python3
"""Create one narrowly scoped NetBird controller-to-worker policy."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.getenv("NETBIRD_API_URL", "https://api.netbird.io/api").rstrip("/")
POLICY_NAME = "geoscope-controller-to-worker-8100"
CONTROLLER_GROUP = "geoscope-controller"
WORKER_GROUP = "geoscope-worker"


def policy_payload(controller_group: str, worker_group: str) -> dict:
    if not controller_group or not worker_group or controller_group == worker_group:
        raise ValueError("Provide distinct, existing controller and worker group IDs.")
    return {
        "name": POLICY_NAME,
        "description": "GeoScope controller can call only the worker API over NetBird.",
        "enabled": True,
        "rules": [{
            "name": "controller-to-worker-api",
            "description": "TCP 8100, controller source group to worker destination group.",
            "enabled": True,
            "action": "accept",
            "bidirectional": False,
            "protocol": "tcp",
            "ports": ["8100"],
            "sources": [controller_group],
            "destinations": [worker_group],
        }],
    }


def dedicated_group_payloads() -> list[dict]:
    """Create empty groups only; a human assigns the intended peers after review."""
    return [{"name": CONTROLLER_GROUP, "peers": []}, {"name": WORKER_GROUP, "peers": []}]


def is_narrow_policy(value: dict, controller_group: str, worker_group: str) -> bool:
    rules = value.get("rules") or []
    def ids(items):
        return [item.get("id") if isinstance(item, dict) else item for item in (items or [])]
    return bool(
        value.get("enabled") is True and len(rules) == 1
        and rules[0].get("enabled") is True
        and rules[0].get("action") == "accept"
        and rules[0].get("bidirectional") is False
        and rules[0].get("protocol") == "tcp"
        and rules[0].get("ports") == ["8100"]
        and not rules[0].get("port_ranges")
        and not rules[0].get("sourceResource")
        and not rules[0].get("destinationResource")
        and ids(rules[0].get("sources")) == [controller_group]
        and ids(rules[0].get("destinations")) == [worker_group]
    )


def disable_payload(policy: dict) -> dict:
    """Build a writable PUT shape; response-only group/resource metadata is discarded."""
    rule_fields = {"name", "description", "enabled", "action", "bidirectional", "protocol", "ports", "port_ranges", "authorized_groups", "id", "sources", "destinations", "sourceResource", "destinationResource"}
    rules = []
    for rule in policy.get("rules", []):
        item = {key: rule[key] for key in rule_fields if key in rule}
        for key in ("sources", "destinations"):
            if key in item:
                item[key] = [group.get("id") if isinstance(group, dict) else group for group in item[key]]
        for key in ("sourceResource", "destinationResource"):
            if key in item and isinstance(item[key], dict):
                item[key] = {subkey: item[key][subkey] for subkey in ("id", "type") if subkey in item[key]}
        rules.append(item)
    result = {"name": policy["name"], "enabled": False, "rules": rules}
    for key in ("description", "source_posture_checks"):
        if key in policy:
            result[key] = policy[key]
    return result


def request(path: str, token: str, method: str = "GET", payload: dict | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={
        "Authorization": f"Token {token}", "Accept": "application/json", "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read()
    return json.loads(body) if body else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controller-group-id")
    parser.add_argument("--worker-group-id")
    parser.add_argument("--create-groups", action="store_true", help="Safely create two empty, dedicated groups only; assign peers manually before creating the policy.")
    parser.add_argument("--apply", action="store_true", help="Create the policy; default is dry-run.")
    parser.add_argument("--disable-default-policy-id", help="After the new policy is verified, disable this exact existing policy ID.")
    parser.add_argument("--confirm-narrow-policy-tested", action="store_true", help="Confirm that dedicated peer assignments and an actual controller-to-worker TCP/8100 connection were tested.")
    args = parser.parse_args()
    if args.create_groups:
        if args.controller_group_id or args.worker_group_id or args.disable_default_policy_id:
            parser.error("--create-groups is a separate step; do not combine it with policy group IDs or policy changes.")
        token = os.getenv("NETBIRD_API_TOKEN", "")
        if args.apply and not token:
            parser.error("NETBIRD_API_TOKEN is required with --apply.")
        groups = dedicated_group_payloads()
        if not args.apply:
            print(json.dumps(groups, indent=2))
            print("Dry run only. Applying creates two empty groups; no peers or policies are modified.")
            return 0
        try:
            existing = request("/groups", token)
            collisions = [group["name"] for group in groups if any(item.get("name") == group["name"] for item in existing)]
            if collisions:
                raise RuntimeError(f"Group names already exist: {', '.join(collisions)}. Inspect membership manually; refusing reuse or modification.")
            created_groups = [request("/groups", token, "POST", group) for group in groups]
            if any(group.get("name") != expected["name"] or not group.get("id")
                   or group.get("peers_count", 0) != 0 or group.get("resources_count", 0) != 0
                   or group.get("peers") for group, expected in zip(created_groups, groups)):
                raise RuntimeError("New group unexpectedly has members/resources. Inspect the NetBird account before proceeding.")
            print(json.dumps([{"name": group["name"], "id": group["id"]} for group in created_groups], indent=2))
            print("Assign only the intended controller and worker peers in NetBird, verify membership, then run the policy step with these IDs.")
            return 0
        except (urllib.error.URLError, json.JSONDecodeError, RuntimeError, ValueError) as exc:
            print(f"NetBird group operation failed: {exc}", file=sys.stderr)
            return 2
    if not args.controller_group_id or not args.worker_group_id:
        parser.error("Provide both --controller-group-id and --worker-group-id, or use --create-groups as the first step.")
    if args.disable_default_policy_id and not args.confirm_narrow_policy_tested:
        parser.error("Disabling an existing policy requires --confirm-narrow-policy-tested after checking group membership and the live connection.")
    token = os.getenv("NETBIRD_API_TOKEN", "")
    if args.apply and not token:
        parser.error("NETBIRD_API_TOKEN is required with --apply (NetBird personal access token).")
    try:
        payload = policy_payload(args.controller_group_id, args.worker_group_id)
        if not args.apply:
            print(json.dumps(payload, indent=2))
            print("Dry run only. Create dedicated groups and assign only the two intended peers before applying.")
            return 0
        existing = request("/policies", token)
        matches = [item for item in existing if item.get("name") == POLICY_NAME]
        if len(matches) > 1:
            raise RuntimeError(f"Multiple policies named {POLICY_NAME!r} exist; inspect them manually.")
        if matches:
            policy_id = matches[0].get("id")
            if not policy_id:
                raise RuntimeError("Existing named policy has no ID; refusing modification.")
            verified = request(f"/policies/{policy_id}", token)
            if not is_narrow_policy(verified, args.controller_group_id, args.worker_group_id):
                raise RuntimeError("Existing named policy does not exactly match the narrow requested rule; refusing to modify it.")
            print(f"Reusing existing verified narrow policy {policy_id}.")
        else:
            created = request("/policies", token, "POST", payload)
            policy_id = created.get("id")
            verified = request(f"/policies/{policy_id}", token) if policy_id else {}
        if not policy_id or not is_narrow_policy(verified, args.controller_group_id, args.worker_group_id):
            raise RuntimeError("Created policy did not exactly match the requested single TCP/8100 rule. No existing policy was changed.")
        print(f"Verified narrow policy {policy_id}: controller group -> worker group, TCP 8100, one-way.")
        if args.disable_default_policy_id:
            if args.disable_default_policy_id == policy_id:
                raise RuntimeError("The identified default policy is the narrow policy itself; refusing to disable it.")
            broad = request(f"/policies/{args.disable_default_policy_id}", token)
            if broad.get("id") != args.disable_default_policy_id:
                raise RuntimeError("NetBird returned a different policy ID; refusing to disable it.")
            request(f"/policies/{args.disable_default_policy_id}", token, "PUT", disable_payload(broad))
            disabled = request(f"/policies/{args.disable_default_policy_id}", token)
            if disabled.get("id") != args.disable_default_policy_id or disabled.get("enabled") is not False:
                raise RuntimeError("NetBird did not confirm the identified policy is disabled; inspect it manually.")
            print(f"Disabled explicitly identified policy {args.disable_default_policy_id} after narrow policy verification.")
        else:
            print("Existing policies were left unchanged. Review any broad default allow policy manually; pass its exact ID to disable it only after verifying peer assignments.")
        return 0
    except (urllib.error.URLError, json.JSONDecodeError, RuntimeError, ValueError) as exc:
        print(f"NetBird policy operation failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
