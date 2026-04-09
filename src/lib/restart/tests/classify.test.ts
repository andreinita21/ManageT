import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * These tests exercise the classification pipeline in isolation from the DB.
 * Since the DB imports will fail in test context, the pipeline gracefully
 * falls through to built-in patterns and heuristics.
 */

// We need to import the functions directly to test them.
// The classify module uses dynamic imports for DB, which will fail gracefully.
import { classifyCommand } from "../classify";

describe("classifyCommand", () => {
  it("should classify safe commands as auto", async () => {
    const result = await classifyCommand("npm run dev");
    assert.strictEqual(result.action, "auto");
    assert.strictEqual(result.matchedBy, "builtin-safe");
    assert.strictEqual(result.confidence, "high");
  });

  it("should classify 'npm start' as safe", async () => {
    const result = await classifyCommand("npm start");
    assert.strictEqual(result.action, "auto");
    assert.strictEqual(result.matchedBy, "builtin-safe");
  });

  it("should classify dangerous commands as never", async () => {
    const result = await classifyCommand("rm -rf /tmp/data");
    assert.strictEqual(result.action, "never");
    assert.strictEqual(result.matchedBy, "builtin-dangerous");
    assert.strictEqual(result.confidence, "high");
  });

  it("should classify 'git push origin main' as dangerous", async () => {
    const result = await classifyCommand("git push origin main");
    assert.strictEqual(result.action, "never");
    assert.strictEqual(result.matchedBy, "builtin-dangerous");
  });

  it("should handle sudo-prefixed safe commands", async () => {
    const result = await classifyCommand("sudo npm start");
    assert.strictEqual(result.action, "auto");
    assert.strictEqual(result.matchedBy, "builtin-safe");
  });

  it("should handle sudo-prefixed dangerous commands", async () => {
    const result = await classifyCommand("sudo rm -rf /tmp");
    assert.strictEqual(result.action, "never");
    assert.strictEqual(result.matchedBy, "builtin-dangerous");
  });

  it("should handle chained commands where one is dangerous", async () => {
    const result = await classifyCommand("cd /app && rm -rf dist");
    assert.strictEqual(result.action, "never");
    assert.strictEqual(result.matchedBy, "builtin-dangerous");
  });

  it("should classify unknown commands as ask by default", async () => {
    const result = await classifyCommand("echo hello");
    assert.strictEqual(result.action, "ask");
    assert.strictEqual(result.matchedBy, "default");
    assert.strictEqual(result.confidence, "low");
  });

  it("should use heuristics when no pattern matches", async () => {
    const result = await classifyCommand("my-custom-tool --port 8080", undefined, undefined, {});
    // binds_port heuristic should fire
    assert.strictEqual(result.action, "auto");
    assert.strictEqual(result.matchedBy, "heuristic");
  });

  it("should handle piped safe commands", async () => {
    const result = await classifyCommand("npm run dev | tee log.txt");
    assert.strictEqual(result.action, "auto");
    assert.strictEqual(result.matchedBy, "builtin-safe");
  });

  it("should classify vite as safe", async () => {
    const result = await classifyCommand("vite");
    assert.strictEqual(result.action, "auto");
    assert.strictEqual(result.matchedBy, "builtin-safe");
  });

  it("should classify docker compose up as safe", async () => {
    const result = await classifyCommand("docker compose up -d");
    assert.strictEqual(result.action, "auto");
    assert.strictEqual(result.matchedBy, "builtin-safe");
  });

  it("should classify kubectl delete as dangerous", async () => {
    const result = await classifyCommand("kubectl delete pod my-pod");
    assert.strictEqual(result.action, "never");
    assert.strictEqual(result.matchedBy, "builtin-dangerous");
  });

  it("should classify terraform destroy as dangerous", async () => {
    const result = await classifyCommand("terraform destroy -auto-approve");
    assert.strictEqual(result.action, "never");
    assert.strictEqual(result.matchedBy, "builtin-dangerous");
  });

  it("should prioritize dangerous over safe in mixed chains", async () => {
    const result = await classifyCommand("npm run dev && rm -rf dist");
    assert.strictEqual(result.action, "never");
    assert.strictEqual(result.matchedBy, "builtin-dangerous");
  });

  it("should handle empty or whitespace commands", async () => {
    const result = await classifyCommand("   ");
    assert.strictEqual(result.action, "ask");
    assert.strictEqual(result.matchedBy, "default");
  });
});
