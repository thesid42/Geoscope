#!/usr/bin/env python3
"""Check the dedicated worker runtime and its assigned private IPv4 address."""
from __future__ import annotations

import ipaddress
import json
import os
import platform
import subprocess
import sys

PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def check_bind_address(value: str, interfaces: list[dict]) -> None:
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as exc:
        raise ValueError("Set WORKER_BIND_IP to this worker's private VPC IPv4 address.") from exc
    if not any(address in network for network in PRIVATE_NETWORKS):
        raise ValueError("WORKER_BIND_IP must be an RFC1918 private address, not a public, wildcard, or loopback address.")
    assigned = {entry.get("local") for interface in interfaces
                for entry in interface.get("addr_info", []) if entry.get("family") == "inet"}
    if str(address) not in assigned:
        raise ValueError(f"WORKER_BIND_IP {address} is not assigned to a host interface; configure the VPC first.")


def command(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise ValueError(f"{args[0]} check failed: {result.stderr.strip()[:500] or 'nonzero exit status'}")
    return result.stdout


def main() -> int:
    try:
        if platform.system() != "Linux":
            raise ValueError("Worker containment requires Linux.")
        if not os.getenv("WORKER_TOKEN", "").strip():
            raise ValueError("WORKER_TOKEN is empty.")
        bind_ip = os.getenv("WORKER_BIND_IP", "")
        check_bind_address(bind_ip, json.loads(command("ip", "-j", "-4", "address", "show")))
        runtimes = json.loads(command("docker", "info", "--format", "{{json .Runtimes}}"))
        if "runsc" not in runtimes:
            raise ValueError("Docker has no runsc runtime; no fallback is permitted.")
        image = os.getenv("SANDBOX_IMAGE", "parkscope-sandbox:local")
        command("docker", "image", "inspect", image)
        print(f"PASS: Linux, Docker, runsc, {image}, worker token, and private bind address {bind_ip} are ready.")
        return 0
    except (ValueError, TypeError, AttributeError, OSError, subprocess.SubprocessError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
