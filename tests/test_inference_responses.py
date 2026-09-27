import asyncio
import json
from dataclasses import replace

import pytest

from app import controller
from app.sandbox import SandboxFailure, _verify_result


class Response:
    def __init__(self, content, finish="stop"):
        self.content, self.finish = content, finish

    def raise_for_status(self):
        pass

    def json(self):
        return {"choices": [{"finish_reason": self.finish, "message": {
            "content": self.content, "reasoning_content": "Never execute reasoning as source."}}]}


class Client:
    def __init__(self, *responses):
        self.responses, self.calls = iter(responses), []

    async def post(self, url, **kwargs):
        self.calls.append(kwargs["json"])
        return next(self.responses)


@pytest.mark.parametrize("first", [Response(None), Response(""), Response("```python\nimport", "length")])
def test_incomplete_inference_retries_before_accepting_python(first, monkeypatch):
    monkeypatch.setattr(controller, "settings", replace(controller.settings, vultr_model_id="deepseek-v4.1-flash"))
    client = Client(first, Response("print('complete')"))
    source = asyncio.run(controller._chat(client, "Write only Python", "test", max_tokens=3500))
    assert source == "print('complete')"
    assert [call["max_tokens"] for call in client.calls] == [3500, 8192]
    assert all(call["reasoning_effort"] == "none" for call in client.calls)
    assert client.calls[0]["messages"] == client.calls[1]["messages"]


@pytest.mark.parametrize("response", [Response(None), Response("partial", "length")])
def test_inference_retry_is_bounded_and_never_returns_incomplete_source(response):
    client = Client(response, response)
    with pytest.raises(RuntimeError, match="No incomplete script was executed"):
        asyncio.run(controller._chat(client, "Write only Python", "test", max_tokens=10000))
    assert len(client.calls) == 2
    assert client.calls[1]["max_tokens"] == 20000


def test_filtered_inference_is_not_retried():
    client = Client(Response(None, "content_filter"))
    with pytest.raises(RuntimeError, match="declined"):
        asyncio.run(controller._chat(client, "test", "test"))
    assert len(client.calls) == 1


@pytest.mark.parametrize("source", [None, "None", "null", "", "```python\nimport json"])
def test_empty_or_unterminated_code_is_not_executed(source):
    with pytest.raises(RuntimeError, match="script was executed"):
        controller._extract_python(source)


def test_complete_fenced_code_is_extracted():
    assert controller._extract_python("```python\nprint('ok')\n```") == "print('ok')"


def test_repair_preserves_source_tail_contract_and_valid_json_with_long_diagnostics():
    source = "# padding\n" * 5000 + "print('source tail')"
    context = {"analysis_mode": "scenario", "analysis_inputs": {"study_area": [-122.433,37.758,-122.417,37.776]},
               "trusted_inspection": {"mode": "scenario", "metrics": {"candidates": [], "building": {}}}}
    data = json.loads(controller._repair_payload(source, {"message": "schema mismatch", "stderr": "x" * 50000}, context))
    assert data["script"] == source
    assert data["analysis_mode"] == "scenario"
    assert data["analysis_inputs"] == context["analysis_inputs"]
    assert data["expected_result_fields"] == ["mode", "metrics"]
    assert data["expected_metric_fields"] == ["candidates", "building"]
    assert len(data["worker_diagnostics"]["stderr"]) <= 12000
    assert '"mode": "scenario"' in controller._script_instructions("scenario")


def test_summary_retains_winners_after_large_check_inventory():
    result = {"mode":"scenario", "metrics":{"site_checks":[{"source":"x"*1000}]*100,
              "candidates":[{"id":"winner"}], "baseline":{"served_population":10}},
              "comparison":{"preferred_candidate":"winner"}}
    payload=json.loads(controller._summary_payload({"question":"Where does it fit?", "synthetic":True, "result":result}))
    assert payload["result"]["comparison"]["preferred_candidate"] == "winner"
    assert payload["result"]["metrics"]["candidates"] == [{"id":"winner"}]
    assert "site_checks" not in payload["result"]["metrics"]
    assert "site_checks" in result["metrics"]


def test_mode_error_supplies_required_envelope_without_accepting_bad_output():
    with pytest.raises(SandboxFailure, match="top-level mode='scenario'"):
        _verify_result({"analysis_mode":"scenario", "metrics":{}}, {"mode":"scenario", "metrics":{}})


def test_non_json_worker_failure_has_actionable_status():
    import httpx
    error = controller._worker_detail(httpx.Response(500, text="Internal Server Error"))
    assert "HTTP 500" in error and "worker service logs" in error
