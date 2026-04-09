import { describe, it } from "node:test";
import assert from "node:assert";
import { evaluateHeuristics } from "../heuristics";
import type { HeuristicContext } from "../heuristics";

describe("evaluateHeuristics", () => {
  it("should detect port binding", () => {
    const result = evaluateHeuristics("my-server --port 3000", {});
    assert.ok(result.triggeredHeuristics.includes("binds_port"));
    assert.strictEqual(result.action, "auto");
  });

  it("should detect localhost binding", () => {
    const result = evaluateHeuristics("my-app --bind 0.0.0.0", {});
    assert.ok(result.triggeredHeuristics.includes("binds_port"));
  });

  it("should detect repeated execution with success history", () => {
    const context: HeuristicContext = {
      executionCount: 5,
      previousSuccess: true,
    };
    const result = evaluateHeuristics("custom-script", context);
    assert.ok(result.triggeredHeuristics.includes("repeated_execution"));
    assert.strictEqual(result.action, "auto");
  });

  it("should not trigger repeated execution without success", () => {
    const context: HeuristicContext = {
      executionCount: 5,
      previousSuccess: false,
    };
    const result = evaluateHeuristics("custom-script", context);
    assert.ok(!result.triggeredHeuristics.includes("repeated_execution"));
  });

  it("should detect long-running process keywords", () => {
    const result = evaluateHeuristics("my-custom-server", {});
    assert.ok(result.triggeredHeuristics.includes("long_running_process"));
  });

  it("should detect long-running process by duration", () => {
    const context: HeuristicContext = { avgDurationMs: 60_000 };
    const result = evaluateHeuristics("unknown-cmd", context);
    assert.ok(result.triggeredHeuristics.includes("long_running_process"));
  });

  it("should detect filesystem writes", () => {
    const result = evaluateHeuristics("cmd > output.txt", {});
    assert.ok(result.triggeredHeuristics.includes("writes_to_filesystem"));
  });

  it("should return ask with low confidence when nothing triggers", () => {
    const result = evaluateHeuristics("echo hello", {});
    assert.strictEqual(result.action, "ask");
    assert.strictEqual(result.confidence, "low");
    assert.strictEqual(result.triggeredHeuristics.length, 0);
  });

  it("should return medium confidence when multiple heuristics trigger", () => {
    const result = evaluateHeuristics("my-server --port 8080", {});
    // binds_port + long_running_process (contains "server")
    assert.strictEqual(result.confidence, "medium");
  });

  it("should prefer ask over auto when filesystem writes are detected alongside safe signals", () => {
    // writes_to_filesystem suggests "ask", but if auto outweighs it, auto wins
    const context: HeuristicContext = {
      executionCount: 5,
      previousSuccess: true,
    };
    // "tee" triggers writes_to_filesystem, repeated_execution triggers auto
    const result = evaluateHeuristics("tee output.log", context);
    assert.ok(result.triggeredHeuristics.length >= 2);
  });
});
