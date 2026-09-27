#!/usr/bin/env python3
"""Runs conformance/scenarios.json through the Python binding.

    MOCK_URL=http://127.0.0.1:18990 TRAFFICNETWORK_LIB=path/to/libtrafficnetwork.so \
        python conformance/run_python.py

The mock server (conformance/mock-server.mjs) has to be running. Every other
language's runner does exactly what this one does — see conformance/README.md
for the scenario format.
"""

import json
import os
import shutil
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bindings", "python"))

from trafficnetwork import Client, TrafficNetworkError  # noqa: E402

MOCK = os.environ.get("MOCK_URL", "http://127.0.0.1:18990")


def http(method, url, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("content-type", "application/json")
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8") or "null")


def subset(expected, actual, path="$"):
    """Returns None if `actual` contains `expected`, otherwise a description of the difference."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return f"{path}: expected an object, got {actual!r}"
        for key, value in expected.items():
            if key not in actual:
                return f"{path}.{key}: missing (got {sorted(actual)})"
            problem = subset(value, actual[key], f"{path}.{key}")
            if problem:
                return problem
        return None
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return f"{path}: expected a list of {len(expected)}, got {actual!r}"
        for index, (want, got) in enumerate(zip(expected, actual)):
            problem = subset(want, got, f"{path}[{index}]")
            if problem:
                return problem
        return None
    if isinstance(expected, bool) or expected is None or isinstance(expected, str):
        return None if expected == actual and type(expected) is type(actual) else f"{path}: expected {expected!r}, got {actual!r}"
    # numbers: 50 equals 50.0
    if isinstance(actual, (int, float)) and not isinstance(actual, bool) and float(expected) == float(actual):
        return None
    return f"{path}: expected {expected!r}, got {actual!r}"


def run_scenario(scenario):
    servers = {}  # name -> {"url", "rootKey"}
    replacements = {}
    for name, config in scenario.get("servers", {}).items():
        config_text = json.dumps(config)
        for key, value in replacements.items():
            config_text = config_text.replace(key, value)
        created = http("POST", f"{MOCK}/__instances", json.loads(config_text))
        servers[name] = created["url"]
        replacements["${" + name + "}"] = created["url"]
        replacements["${" + name + ".rootKey}"] = created["rootPublicKey"]

    def substitute(value):
        text = json.dumps(value)
        for key, replacement in replacements.items():
            text = text.replace(key, replacement)
        return json.loads(text)

    storage = tempfile.mkdtemp(prefix="tn-conformance-")
    options = substitute(scenario["options"])
    options["storagePath"] = storage
    client = Client(options)
    failures = []
    try:
        for number, step in enumerate(scenario["steps"], 1):
            label = f"step {number} ({step.get('call') or next(iter(k for k in step if k != 'expect'))})"
            if "call" in step:
                args = substitute(step.get("args", {}))
                try:
                    result, error = client.call(step["call"], args), None
                except TrafficNetworkError as failure:
                    result, error = None, failure
                if "expectError" in step:
                    if error is None:
                        failures.append(f"{label}: expected the error {step['expectError']!r}, got {result!r}")
                    elif error.code != step["expectError"]:
                        failures.append(f"{label}: expected the error {step['expectError']!r}, got {error.code!r} ({error.message})")
                    continue
                if error is not None:
                    failures.append(f"{label}: unexpected error {error}")
                    continue
                if "expect" in step:
                    problem = subset(substitute(step["expect"]), result)
                    if problem:
                        failures.append(f"{label}: {problem}")
                if "expectKeys" in step:
                    for key in step["expectKeys"]:
                        if not isinstance(result, dict) or key not in result:
                            failures.append(f"{label}: the result has no {key!r}: {result!r}")
                if "expectSome" in step:
                    spec = step["expectSome"]
                    items = result.get(spec["path"]) if isinstance(result, dict) else None
                    if not isinstance(items, list) or not any(subset(spec["match"], item) is None for item in items):
                        failures.append(f"{label}: no element of {spec['path']} matches {spec['match']!r}: {items!r}")
            elif "mockFail" in step:
                spec = step["mockFail"]
                http("POST", f"{servers[spec['server']]}/__fail",
                     {"route": spec["route"], "status": spec["status"], "times": spec.get("times", 1)})
            elif "mockLog" in step:
                spec = step["mockLog"]
                log = http("GET", f"{servers[spec['server']]}/__log")
                entries = [entry for entry in log if entry["key"] == spec["route"]]
                if "count" in spec and len(entries) != spec["count"]:
                    failures.append(f"{label}: {spec['route']} was asked {len(entries)} times, expected {spec['count']}")
                    continue
                if "bodyIncludes" in spec:
                    if not entries or subset(spec["bodyIncludes"], entries[0].get("body")):
                        failures.append(f"{label}: the body of {spec['route']} lacks {spec['bodyIncludes']!r}: {entries[:1]!r}")
                if "signatureValid" in spec:
                    if not entries or any(entry.get("signatureValid") is not spec["signatureValid"] for entry in entries):
                        failures.append(f"{label}: signatureValid of {spec['route']} is not {spec['signatureValid']!r}: {entries!r}")
            else:
                failures.append(f"{label}: unknown step {step!r}")
    finally:
        client.free()
        shutil.rmtree(storage, ignore_errors=True)
    return failures


def main():
    scenarios = json.load(open(os.path.join(HERE, "scenarios.json"), encoding="utf-8"))["scenarios"]
    failed = 0
    for scenario in scenarios:
        failures = run_scenario(scenario)
        if failures:
            failed += 1
            print(f"FAIL  {scenario['name']}")
            for failure in failures:
                print(f"        {failure}")
        else:
            print(f"ok    {scenario['name']}")
    print(f"\n{len(scenarios) - failed} of {len(scenarios)} scenarios passed (python)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
