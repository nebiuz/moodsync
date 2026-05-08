import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

function makeReq({ method = "GET", headers = {}, remoteAddress = "127.0.0.1" } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress };
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
    },
  };
}

test("internal gservices endpoint is hidden by default", async () => {
  process.env.MOODSYNC_DISABLE_SERVER = "1";
  delete process.env.MOODSYNC_ENABLE_INTERNAL;
  process.env.MOODSYNC_INTERNAL_TOKEN = "token";

  const mod = await import("../server.js");
  const req = makeReq({
    headers: { host: "localhost:4173", "x-moodsync-internal-token": "token" },
  });
  const res = makeRes();
  const url = new URL("http://localhost:4173/api/_internal/gservices");

  await mod.handleApi(req, res, url);
  assert.equal(res.statusCode, 404);
});

test("internal gservices endpoint requires token + loopback", async () => {
  process.env.MOODSYNC_DISABLE_SERVER = "1";
  process.env.MOODSYNC_ENABLE_INTERNAL = "1";
  process.env.MOODSYNC_INTERNAL_TOKEN = "secret-token";

  const mod = await import("../server.js");

  {
    const req = makeReq({
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost:4173", "x-moodsync-internal-token": "wrong" },
    });
    const res = makeRes();
    const url = new URL("http://localhost:4173/api/_internal/gservices");
    await mod.handleApi(req, res, url);
    assert.equal(res.statusCode, 401);
  }

  {
    const req = makeReq({
      remoteAddress: "10.0.0.5",
      headers: { host: "localhost:4173", "x-moodsync-internal-token": "secret-token" },
    });
    const res = makeRes();
    const url = new URL("http://localhost:4173/api/_internal/gservices");
    await mod.handleApi(req, res, url);
    assert.equal(res.statusCode, 403);
  }

  {
    const req = makeReq({
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost:4173", "x-moodsync-internal-token": "secret-token" },
    });
    const res = makeRes();
    const url = new URL("http://localhost:4173/api/_internal/gservices");
    await mod.handleApi(req, res, url);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.snapshot);
    assert.equal(typeof data.snapshot, "object");
  }
});

