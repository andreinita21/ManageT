import { describe, it } from "node:test";
import assert from "node:assert";
import { matchGlob, matchRegex, matchExact, matchPattern } from "../matcher";

describe("matchGlob", () => {
  it("should match exact strings without wildcards", () => {
    assert.strictEqual(matchGlob("npm start", "npm start"), true);
  });

  it("should match trailing wildcard", () => {
    assert.strictEqual(matchGlob("npm run dev", "npm run dev*"), true);
    assert.strictEqual(matchGlob("npm run dev:watch", "npm run dev*"), true);
  });

  it("should match leading wildcard", () => {
    assert.strictEqual(matchGlob("SELECT * FROM foo; DROP TABLE bar", "*DROP TABLE*"), true);
  });

  it("should match middle wildcard", () => {
    assert.strictEqual(matchGlob("node my-server.js", "node *server*"), true);
    assert.strictEqual(matchGlob("node app.js", "node *app*"), true);
  });

  it("should be case-insensitive", () => {
    assert.strictEqual(matchGlob("NPM START", "npm start"), true);
    assert.strictEqual(matchGlob("npm start", "NPM START"), true);
  });

  it("should not match when pattern does not fit", () => {
    assert.strictEqual(matchGlob("yarn start", "npm start"), false);
    assert.strictEqual(matchGlob("npm run build", "npm run dev*"), false);
  });

  it("should handle multiple wildcards", () => {
    assert.strictEqual(matchGlob("bundle exec thin server", "bundle exec *server*"), true);
  });

  it("should match 'service X start' pattern with middle wildcard", () => {
    assert.strictEqual(matchGlob("service nginx start", "service * start"), true);
    assert.strictEqual(matchGlob("service nginx stop", "service * start"), false);
  });

  it("should handle special regex characters in pattern", () => {
    assert.strictEqual(matchGlob("nginx -g 'daemon off;'", "nginx -g 'daemon off;'*"), true);
  });

  it("should match exact single-word patterns", () => {
    assert.strictEqual(matchGlob("htop", "htop"), true);
    assert.strictEqual(matchGlob("vite", "vite"), true);
    assert.strictEqual(matchGlob("air", "air"), true);
    assert.strictEqual(matchGlob("reboot", "reboot"), true);
    assert.strictEqual(matchGlob("poweroff", "poweroff"), true);
  });

  it("should not match partial words without wildcard", () => {
    assert.strictEqual(matchGlob("htop --something", "htop"), false);
  });
});

describe("matchRegex", () => {
  it("should match a simple regex", () => {
    assert.strictEqual(matchRegex("npm run dev", "npm run dev.*"), true);
  });

  it("should be case-insensitive", () => {
    assert.strictEqual(matchRegex("NPM START", "npm start"), true);
  });

  it("should handle invalid regex gracefully", () => {
    assert.strictEqual(matchRegex("test", "[invalid"), false);
  });

  it("should match partial strings (regex is not anchored)", () => {
    assert.strictEqual(matchRegex("foo bar baz", "bar"), true);
  });
});

describe("matchExact", () => {
  it("should match exact strings case-insensitively", () => {
    assert.strictEqual(matchExact("npm start", "npm start"), true);
    assert.strictEqual(matchExact("NPM START", "npm start"), true);
  });

  it("should not match partial strings", () => {
    assert.strictEqual(matchExact("npm start --watch", "npm start"), false);
  });
});

describe("matchPattern", () => {
  it("should dispatch to glob matcher", () => {
    assert.strictEqual(matchPattern("npm run dev:watch", "npm run dev*", "glob"), true);
  });

  it("should dispatch to regex matcher", () => {
    assert.strictEqual(matchPattern("npm run dev", "^npm run \\w+$", "regex"), true);
  });

  it("should dispatch to exact matcher", () => {
    assert.strictEqual(matchPattern("npm start", "npm start", "exact"), true);
  });
});
