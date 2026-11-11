import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent } from "undici";
import { dispatcher } from "../src/http.js";
import { listSpeakers } from "../src/official.js";

test("discovers connected speakers through the official integration API", async (t) => {
  process.env.PROTECT_HOST = "protect.test.invalid";
  process.env.PROTECT_API_KEY = "test-only";
  process.env.PROTECT_CONSOLE_ID = "";
  const agent = new MockAgent();
  agent.disableNetConnect();
  t.after(() => agent.close());
  t.mock.method(dispatcher, "dispatch", agent.dispatch.bind(agent));

  const speakers = [{ id: "test-speaker", name: "Classroom", state: "CONNECTED" }];
  agent.get("https://protect.test.invalid")
    .intercept({
      method: "GET",
      path: "/proxy/protect/integration/v1/speakers",
      headers: { "x-api-key": "test-only" },
    })
    .reply(200, speakers);

  const result = await listSpeakers();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, speakers);
  agent.assertNoPendingInterceptors();
});
