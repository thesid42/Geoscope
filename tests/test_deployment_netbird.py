import importlib.util
import sys
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location("netbird_policy", Path(__file__).parents[1] / "scripts" / "NetBird" / "policy.py")
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)


def test_policy_is_exactly_one_way_controller_to_worker_port_8100():
    value = policy.policy_payload("controller-id", "worker-id")
    assert value["enabled"] is True
    assert len(value["rules"]) == 1
    assert policy.is_narrow_policy(value, "controller-id", "worker-id")


def test_policy_refuses_same_or_missing_group_ids():
    for source, destination in [("same", "same"), ("", "worker")]:
        with pytest.raises(ValueError):
            policy.policy_payload(source, destination)


def test_verifier_accepts_official_api_group_objects_and_rejects_broad_rule():
    actual_api_shape = {
        "enabled": True,
        "rules": [{"enabled": True, "action": "accept", "bidirectional": False,
            "protocol": "tcp", "ports": ["8100"],
            "sources": [{"id": "controller-id", "name": "geoscope-controller"}],
            "destinations": [{"id": "worker-id", "name": "geoscope-worker"}] }],
    }
    assert policy.is_narrow_policy(actual_api_shape, "controller-id", "worker-id")
    actual_api_shape["rules"][0]["bidirectional"] = True
    assert not policy.is_narrow_policy(actual_api_shape, "controller-id", "worker-id")
    actual_api_shape["rules"][0]["bidirectional"] = False
    actual_api_shape["rules"][0]["port_ranges"] = [{"start": 1, "end": 65535}]
    assert not policy.is_narrow_policy(actual_api_shape, "controller-id", "worker-id")
    del actual_api_shape["rules"][0]["port_ranges"]
    actual_api_shape["rules"][0]["sourceResource"] = {"id": "unverified-selector", "type": "host"}
    assert not policy.is_narrow_policy(actual_api_shape, "controller-id", "worker-id")


def test_disable_put_payload_strips_response_only_group_metadata():
    response = {"id": "default-id", "name": "Default", "description": "broad", "enabled": True,
        "rules": [{"name": "Default", "enabled": True, "action": "accept", "bidirectional": True,
            "protocol": "tcp", "ports": ["*"], "sources": [{"id": "all-id", "name": "All"}],
            "destinations": [{"id": "all-id", "name": "All"}],
            "sourceResource": {"id": "resource", "type": "host", "peer_count": 4}}]}
    payload = policy.disable_payload(response)
    assert payload["enabled"] is False
    assert payload["rules"][0]["sources"] == ["all-id"]
    assert payload["rules"][0]["sourceResource"] == {"id": "resource", "type": "host"}
    assert "peer_count" not in payload["rules"][0]["sourceResource"]
    assert "id" not in payload


def test_group_creation_is_empty_and_explicit():
    assert policy.dedicated_group_payloads() == [
        {"name": "geoscope-controller", "peers": []},
        {"name": "geoscope-worker", "peers": []},
    ]


def test_create_groups_refuses_existing_name_without_mutation(monkeypatch):
    calls = []

    def fake_request(path, token, method="GET", payload=None):
        calls.append((path, method))
        if path == "/groups" and method == "GET":
            return [{"id": "someone-elses", "name": "geoscope-controller", "peers_count": 4}]
        raise AssertionError((path, method))

    monkeypatch.setattr(policy, "request", fake_request)
    monkeypatch.setenv("NETBIRD_API_TOKEN", "test-token")
    monkeypatch.setattr(sys, "argv", ["policy.py", "--create-groups", "--apply"])
    assert policy.main() == 2
    assert calls == [("/groups", "GET")]


def test_apply_verifies_narrow_policy_before_disabling_existing_policy(monkeypatch, capsys):
    narrow = {"id": "new-policy", "name": policy.POLICY_NAME, "enabled": True,
        "rules": [{"enabled": True, "action": "accept", "bidirectional": False, "protocol": "tcp", "ports": ["8100"],
            "sources": [{"id": "controller-id"}], "destinations": [{"id": "worker-id"}]}]}
    old = {"id": "default-id", "name": "Default", "description": "broad", "enabled": True,
        "rules": [{"name": "Default", "enabled": True, "action": "accept", "bidirectional": True, "protocol": "tcp",
            "ports": ["*"], "sources": [{"id": "all-id", "name": "All"}], "destinations": [{"id": "all-id", "name": "All"}]}]}
    calls = []

    def fake_request(path, token, method="GET", payload=None):
        calls.append((path, method, payload))
        if path == "/policies" and method == "GET": return []
        if path == "/policies" and method == "POST": return {"id": "new-policy"}
        if path == "/policies/new-policy": return narrow
        if path == "/policies/default-id" and method == "GET":
            return {**old, "enabled": False} if any(item[0] == path and item[1] == "PUT" for item in calls) else old
        if path == "/policies/default-id" and method == "PUT": return {"ok": True}
        raise AssertionError((path, method))

    monkeypatch.setattr(policy, "request", fake_request)
    monkeypatch.setenv("NETBIRD_API_TOKEN", "test-token")
    monkeypatch.setattr(sys, "argv", ["policy.py", "--controller-group-id", "controller-id", "--worker-group-id", "worker-id",
        "--apply", "--disable-default-policy-id", "default-id", "--confirm-narrow-policy-tested"])
    assert policy.main() == 0
    put = [call for call in calls if call[1] == "PUT"]
    assert len(put) == 1 and put[0][0] == "/policies/default-id"
    assert put[0][2]["enabled"] is False
    assert "id" not in put[0][2]
    assert "Verified narrow policy" in capsys.readouterr().out


def test_second_apply_reuses_matching_policy_then_explicitly_disables_default(monkeypatch, capsys):
    narrow = {"id": "new-policy", "name": policy.POLICY_NAME, "enabled": True,
        "rules": [{"enabled": True, "action": "accept", "bidirectional": False, "protocol": "tcp", "ports": ["8100"],
            "sources": [{"id": "controller-id", "name": "controller"}],
            "destinations": [{"id": "worker-id", "name": "worker"}]}]}
    default = {"id": "default-id", "name": "Default", "enabled": True,
        "rules": [{"name": "Default", "enabled": True, "action": "accept", "bidirectional": True,
            "protocol": "tcp", "ports": ["*"], "sources": [{"id": "all"}], "destinations": [{"id": "all"}]}]}
    calls = []

    def fake_request(path, token, method="GET", payload=None):
        calls.append((path, method, payload))
        if path == "/policies" and method == "GET": return [narrow]
        if path == "/policies/new-policy": return narrow
        if path == "/policies/default-id" and method == "GET":
            return {**default, "enabled": False} if any(item[0] == path and item[1] == "PUT" for item in calls) else default
        if path == "/policies/default-id" and method == "PUT": return {"ok": True}
        raise AssertionError((path, method))

    monkeypatch.setattr(policy, "request", fake_request)
    monkeypatch.setenv("NETBIRD_API_TOKEN", "test-token")
    monkeypatch.setattr(sys, "argv", ["policy.py", "--controller-group-id", "controller-id", "--worker-group-id", "worker-id",
        "--apply", "--disable-default-policy-id", "default-id", "--confirm-narrow-policy-tested"])
    assert policy.main() == 0
    assert not any(path == "/policies" and method == "POST" for path, method, _ in calls)
    put = [call for call in calls if call[1] == "PUT"]
    assert len(put) == 1 and put[0][2]["enabled"] is False
    assert "Reusing existing verified narrow policy" in capsys.readouterr().out


def test_apply_does_not_touch_existing_policy_when_verification_fails(monkeypatch):
    calls = []

    def fake_request(path, token, method="GET", payload=None):
        calls.append((path, method))
        if path == "/policies" and method == "GET": return []
        if path == "/policies" and method == "POST": return {"id": "new-policy"}
        if path == "/policies/new-policy":
            return {"id": "new-policy", "enabled": True, "rules": [{"enabled": True, "action": "accept", "bidirectional": True,
                "protocol": "tcp", "ports": ["8100"], "sources": [{"id": "controller-id"}], "destinations": [{"id": "worker-id"}]}]}
        raise AssertionError((path, method))

    monkeypatch.setattr(policy, "request", fake_request)
    monkeypatch.setenv("NETBIRD_API_TOKEN", "test-token")
    monkeypatch.setattr(sys, "argv", ["policy.py", "--controller-group-id", "controller-id", "--worker-group-id", "worker-id",
        "--apply", "--disable-default-policy-id", "default-id", "--confirm-narrow-policy-tested"])
    assert policy.main() == 2
    assert not any(method == "PUT" for _, method in calls)
