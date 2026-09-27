import importlib.util
from pathlib import Path
import subprocess

import pytest

SPEC = importlib.util.spec_from_file_location("worker_preflight", Path(__file__).parents[1] / "scripts" / "worker-preflight.py")
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


def interface(address):
    return [{"ifname": "ens7", "addr_info": [{"family": "inet", "local": address}]}]


@pytest.mark.parametrize("address", ["10.0.0.2", "172.16.0.2", "192.168.1.2"])
def test_private_bind_address_must_be_assigned(address):
    preflight.check_bind_address(address, interface(address))


@pytest.mark.parametrize("address", ["", "0.0.0.0", "127.0.0.1", "8.8.8.8", "169.254.169.254", "100.64.0.2", "::1"])
def test_non_vpc_bind_addresses_are_rejected(address):
    with pytest.raises(ValueError):
        preflight.check_bind_address(address, interface(address))


def test_bind_check_matches_whole_address():
    with pytest.raises(ValueError, match="not assigned"):
        preflight.check_bind_address("10.0.0.2", interface("10.0.0.20"))


@pytest.fixture
def ready(monkeypatch):
    monkeypatch.setattr(preflight.platform, "system", lambda: "Linux")
    monkeypatch.setenv("WORKER_TOKEN", "test-only-token")
    monkeypatch.setenv("WORKER_BIND_IP", "10.0.0.2")
    monkeypatch.setenv("SANDBOX_IMAGE", "parkscope-sandbox:local")
    calls = []
    def command(*args):
        calls.append(args)
        if args[0] == "ip":
            return '[{"addr_info":[{"family":"inet","local":"10.0.0.2"}]}]'
        if args[:2] == ("docker", "info"):
            return '{"runsc": {}}'
        return '[]'
    monkeypatch.setattr(preflight, "command", command)
    return calls, command


def test_readiness_checks_private_interface_runtime_and_image(ready, capsys):
    calls, _ = ready
    assert preflight.main() == 0
    assert [call[0] for call in calls] == ["ip", "docker", "docker"]
    assert calls[-1] == ("docker", "image", "inspect", "parkscope-sandbox:local")
    output = capsys.readouterr().out
    assert "PASS" in output and "test-only-token" not in output


def test_missing_token_fails_before_host_checks(ready, monkeypatch):
    monkeypatch.delenv("WORKER_TOKEN")
    assert preflight.main() == 1
    assert ready[0] == []


def test_missing_runsc_fails_without_fallback(ready, monkeypatch, capsys):
    _, command = ready
    monkeypatch.setattr(preflight, "command", lambda *args: '{"runc": {}}' if args[:2] == ("docker", "info") else command(*args))
    assert preflight.main() == 1
    assert "no fallback" in capsys.readouterr().err


@pytest.mark.parametrize("failure", [OSError("missing ip"), ValueError("bad interface data"), subprocess.TimeoutExpired("docker", 15)])
def test_host_check_failures_stop_startup(ready, monkeypatch, capsys, failure):
    def fail(*args):
        raise failure
    monkeypatch.setattr(preflight, "command", fail)
    assert preflight.main() == 1
    assert "FAIL" in capsys.readouterr().err
