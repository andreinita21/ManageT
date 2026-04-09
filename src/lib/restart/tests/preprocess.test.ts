import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizeCommand,
  stripSudo,
  splitChain,
  getFirstPipeCommand,
  preprocessCommand,
} from "../preprocess";

describe("normalizeCommand", () => {
  it("should trim whitespace", () => {
    assert.strictEqual(normalizeCommand("  npm start  "), "npm start");
  });

  it("should collapse multiple spaces", () => {
    assert.strictEqual(normalizeCommand("npm   run   dev"), "npm run dev");
  });

  it("should handle tabs and newlines", () => {
    assert.strictEqual(normalizeCommand("npm\t\tstart"), "npm start");
  });
});

describe("stripSudo", () => {
  it("should strip simple sudo prefix", () => {
    assert.strictEqual(stripSudo("sudo npm start"), "npm start");
  });

  it("should strip sudo with flags", () => {
    assert.strictEqual(stripSudo("sudo -E npm start"), "npm start");
  });

  it("should strip sudo -u user", () => {
    assert.strictEqual(stripSudo("sudo -u www-data nginx"), "nginx");
  });

  it("should return command unchanged if no sudo", () => {
    assert.strictEqual(stripSudo("npm start"), "npm start");
  });
});

describe("splitChain", () => {
  it("should split on &&", () => {
    const result = splitChain("cd /app && npm start");
    assert.deepStrictEqual(result, ["cd /app", "npm start"]);
  });

  it("should split on ||", () => {
    const result = splitChain("npm start || echo failed");
    assert.deepStrictEqual(result, ["npm start", "echo failed"]);
  });

  it("should split on ;", () => {
    const result = splitChain("cd /app; npm start");
    assert.deepStrictEqual(result, ["cd /app", "npm start"]);
  });

  it("should not split inside double quotes", () => {
    const result = splitChain('echo "a && b"');
    assert.deepStrictEqual(result, ['echo "a && b"']);
  });

  it("should not split inside single quotes", () => {
    const result = splitChain("echo 'a && b'");
    assert.deepStrictEqual(result, ["echo 'a && b'"]);
  });

  it("should handle multiple chain operators", () => {
    const result = splitChain("a && b; c || d");
    assert.deepStrictEqual(result, ["a", "b", "c", "d"]);
  });

  it("should handle empty segments", () => {
    const result = splitChain("a && && b");
    assert.deepStrictEqual(result, ["a", "b"]);
  });
});

describe("getFirstPipeCommand", () => {
  it("should return the first command before a pipe", () => {
    assert.strictEqual(getFirstPipeCommand("ls -la | grep foo"), "ls -la");
  });

  it("should return the full command if no pipe", () => {
    assert.strictEqual(getFirstPipeCommand("npm start"), "npm start");
  });

  it("should not split on || (logical OR)", () => {
    assert.strictEqual(
      getFirstPipeCommand("npm start || echo fail"),
      "npm start || echo fail"
    );
  });

  it("should respect quotes around pipes", () => {
    assert.strictEqual(
      getFirstPipeCommand('echo "hello | world"'),
      'echo "hello | world"'
    );
  });
});

describe("preprocessCommand", () => {
  it("should normalize, strip sudo, and split chains", () => {
    const result = preprocessCommand("sudo  npm run dev && sudo  tail -f log.txt");
    assert.strictEqual(result.normalized, "sudo npm run dev && sudo tail -f log.txt");
    assert.deepStrictEqual(result.commands, ["npm run dev", "tail -f log.txt"]);
  });

  it("should extract first pipe command from each chain element", () => {
    const result = preprocessCommand("npm start | tee log.txt");
    assert.deepStrictEqual(result.commands, ["npm start"]);
  });
});
