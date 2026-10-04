// Runs conformance/scenarios.json through a JS binding. The same logic as
// run_python.py, written once for both JS bindings so they cannot disagree
// about what a scenario means: `bindings/node` (Node.js, FFI over the C ABI,
// run_node.mjs) and `bindings/wasm` (a real headless browser, run_web.mjs).
//
// Environment-neutral on purpose — only `fetch` and `JSON`, no Node APIs —
// so it loads unchanged in a page. Each runner supplies `createClient`.
//
// The scenario format is described in conformance/README.md; every runner
// does exactly what this one does.

/** `null` if `actual` contains `expected`, otherwise a description of the difference. */
export function subset(expected, actual, path = "$") {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return `${path}: expected a list of ${expected.length}, got ${JSON.stringify(actual)}`;
    }
    for (let i = 0; i < expected.length; i += 1) {
      const problem = subset(expected[i], actual[i], `${path}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      return `${path}: expected an object, got ${JSON.stringify(actual)}`;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual)) {
        return `${path}.${key}: missing (got ${JSON.stringify(Object.keys(actual).sort())})`;
      }
      const problem = subset(value, actual[key], `${path}.${key}`);
      if (problem) return problem;
    }
    return null;
  }
  // Scalars: 50 equals 50.0 is automatic in JS (one number type), exactly
  // what the Python runner has to special-case.
  return expected === actual
    ? null
    : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

async function http(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Runs one scenario and returns the list of failures (empty = passed).
 *
 * @param {object} scenario one entry of scenarios.json's `scenarios`
 * @param {object} env
 * @param {string} env.mockUrl base URL of conformance/mock-server.mjs
 * @param {(options: object) => Promise<{call(method: string, args: object): Promise<unknown>, free(): void}>} env.createClient
 *        builds a client for the options (with `storagePath` already set); `call`
 *        resolves with the result or rejects with an error that has a `.code`
 * @param {(name: string) => string} env.storagePathFor a unique storage location for this scenario
 * @param {() => Promise<void>} [env.cleanup] called after the scenario
 */
export async function runScenario(scenario, env) {
  const servers = {};
  const replacements = {};
  for (const [name, config] of Object.entries(scenario.servers ?? {})) {
    let configText = JSON.stringify(config);
    for (const [key, value] of Object.entries(replacements)) configText = configText.split(key).join(value);
    const created = await http("POST", `${env.mockUrl}/__instances`, JSON.parse(configText));
    servers[name] = created.url;
    replacements["${" + name + "}"] = created.url;
    replacements["${" + name + ".rootKey}"] = created.rootPublicKey;
  }

  const substitute = (value) => {
    let text = JSON.stringify(value);
    for (const [key, replacement] of Object.entries(replacements)) text = text.split(key).join(replacement);
    return JSON.parse(text);
  };

  const options = substitute(scenario.options);
  options.storagePath = env.storagePathFor(scenario.name);
  const client = await env.createClient(options);
  const failures = [];
  try {
    let number = 0;
    for (const step of scenario.steps) {
      number += 1;
      const label = `step ${number} (${step.call ?? Object.keys(step).find((k) => k !== "expect")})`;
      if ("call" in step) {
        const args = substitute(step.args ?? {});
        let result;
        let error = null;
        try {
          result = await client.call(step.call, args);
        } catch (failure) {
          error = failure;
        }
        if ("expectError" in step) {
          if (error === null) {
            failures.push(`${label}: expected the error ${JSON.stringify(step.expectError)}, got ${JSON.stringify(result)}`);
          } else if (error.code !== step.expectError) {
            failures.push(
              `${label}: expected the error ${JSON.stringify(step.expectError)}, got ${JSON.stringify(error.code)} (${error.message})`,
            );
          }
          continue;
        }
        if (error !== null) {
          failures.push(`${label}: unexpected error ${error.code ?? ""} ${error.message}`);
          continue;
        }
        if ("expect" in step) {
          const problem = subset(substitute(step.expect), result);
          if (problem) failures.push(`${label}: ${problem}`);
        }
        if ("expectKeys" in step) {
          for (const key of step.expectKeys) {
            if (result === null || typeof result !== "object" || !(key in result)) {
              failures.push(`${label}: the result has no ${JSON.stringify(key)}: ${JSON.stringify(result)}`);
            }
          }
        }
        if ("expectSome" in step) {
          const spec = step.expectSome;
          const items = result !== null && typeof result === "object" ? result[spec.path] : null;
          if (!Array.isArray(items) || !items.some((item) => subset(spec.match, item) === null)) {
            failures.push(`${label}: no element of ${spec.path} matches ${JSON.stringify(spec.match)}: ${JSON.stringify(items)}`);
          }
        }
      } else if ("mockFail" in step) {
        const spec = step.mockFail;
        await http("POST", `${servers[spec.server]}/__fail`, {
          route: spec.route,
          status: spec.status,
          times: spec.times ?? 1,
        });
      } else if ("mockSet" in step) {
        const spec = step.mockSet;
        await http("POST", `${servers[spec.server]}/__set`, spec.config);
      } else if ("mockLog" in step) {
        const spec = step.mockLog;
        const log = await http("GET", `${servers[spec.server]}/__log`);
        const entries = log.filter((entry) => entry.key === spec.route);
        if ("count" in spec && entries.length !== spec.count) {
          failures.push(`${label}: ${spec.route} was asked ${entries.length} times, expected ${spec.count}`);
          continue;
        }
        if ("bodyIncludes" in spec) {
          if (entries.length === 0 || subset(spec.bodyIncludes, entries[0].body)) {
            failures.push(
              `${label}: the body of ${spec.route} lacks ${JSON.stringify(spec.bodyIncludes)}: ${JSON.stringify(entries.slice(0, 1))}`,
            );
          }
        }
        if ("signatureValid" in spec) {
          if (entries.length === 0 || entries.some((entry) => entry.signatureValid !== spec.signatureValid)) {
            failures.push(
              `${label}: signatureValid of ${spec.route} is not ${JSON.stringify(spec.signatureValid)}: ${JSON.stringify(entries)}`,
            );
          }
        }
      } else {
        failures.push(`${label}: unknown step ${JSON.stringify(step)}`);
      }
    }
  } finally {
    client.free();
    if (env.cleanup) await env.cleanup();
  }
  return failures;
}

/**
 * Runs every scenario, prints one line each, and returns the number that failed.
 *
 * @param {object} scenariosFile the parsed scenarios.json
 * @param {object} env see {@link runScenario}
 * @param {string} label which binding this is, for the summary line
 * @param {(line: string) => void} [print]
 */
export async function runAll(scenariosFile, env, label, print = console.log) {
  let failed = 0;
  const { scenarios } = scenariosFile;
  for (const scenario of scenarios) {
    let failures;
    try {
      failures = await runScenario(scenario, env);
    } catch (error) {
      failures = [`the scenario could not run: ${error?.stack ?? error}`];
    }
    if (failures.length > 0) {
      failed += 1;
      print(`FAIL  ${scenario.name}`);
      for (const failure of failures) print(`        ${failure}`);
    } else {
      print(`ok    ${scenario.name}`);
    }
  }
  print(`\n${scenarios.length - failed} of ${scenarios.length} scenarios passed (${label})`);
  return failed;
}
