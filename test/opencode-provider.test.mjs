import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpencodeProvider } from "../dist/providers/opencode/provider.js";
import { resolveDatabasePath } from "../dist/providers/opencode/database.js";
import { detectProvider } from "../dist/providers/registry.js";
import {
  assistantMessage,
  buildOpencodeDatabase,
  FIXTURE,
  sessionRow,
} from "./helpers/opencode-database.mjs";

const SESSION_ID = FIXTURE.session.id;

async function withDataRoot(run, extras) {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-opencode-"));
  buildOpencodeDatabase(join(root, "opencode.db"), extras);
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a captured opencode session becomes one normalized provider session", async () => {
  await withDataRoot(async (root) => {
    const provider = new OpencodeProvider(root);
    const found = await provider.findSession(SESSION_ID.slice(0, 10));
    assert.equal(found.sessionId, SESSION_ID);
    assert.equal(found.transcriptPath, join(root, "opencode.db"));
    assert.equal(found.projectPath, "C:/work/sample-project");

    const { sessionData, transcriptData } = await provider.readSession(
      found.transcriptPath,
      found.sessionId,
    );
    assert.equal(sessionData.provider, "opencode");
    assert.equal(sessionData.sessionId, SESSION_ID);

    // Two turns of 400 input / 250 output / 90 reasoning / 800 cache read.
    // Reasoning bills as output, so output is 250 + 90 per turn.
    assert.equal(sessionData.inputTokens, 800);
    assert.equal(sessionData.outputTokens, 680);
    assert.equal(sessionData.cacheReadTokens, 1600);
    assert.equal(sessionData.cacheCreationTokens, 0);

    assert.equal(transcriptData.userMessageCount, 2);
    assert.equal(transcriptData.assistantMessageCount, 2);
    assert.equal(transcriptData.projectName, "sample-project");
    assert.equal(transcriptData.firstPrompt, '"First turn"');
    assert.equal(transcriptData.cwd, "C:/work/sample-project");
  });
});

test("one session splits into a breakdown per model", async () => {
  await withDataRoot(async (root) => {
    const provider = new OpencodeProvider(root);
    const { sessionData } = await provider.readSession(
      join(root, "opencode.db"),
      SESSION_ID,
    );

    const models = sessionData.modelBreakdowns.map((entry) => entry.modelName).sort();
    assert.deepEqual(models, ["claude-sonnet-4-5", "mock-model"]);

    const sonnet = sessionData.modelBreakdowns.find(
      (entry) => entry.modelName === "claude-sonnet-4-5",
    );
    assert.equal(sonnet.displayName, "Claude Sonnet 4.5");
    // $3 input, $15 output, $0.30 cache read per MTok.
    const expected =
      (400 * 3 + 340 * 15 + 800 * 0.3) / 1_000_000;
    assert.ok(Math.abs(sonnet.cost - expected) < 1e-9, `${sonnet.cost} != ${expected}`);
  });
});

test("a model neither table prices is surfaced, never billed as free", async () => {
  await withDataRoot(async (root) => {
    const provider = new OpencodeProvider(root);
    const { unknownModels, sessionData } = await provider.readSession(
      join(root, "opencode.db"),
      SESSION_ID,
    );
    assert.deepEqual(unknownModels, ["mock-model"]);
    const mock = sessionData.modelBreakdowns.find(
      (entry) => entry.modelName === "mock-model",
    );
    assert.equal(mock.cost, 0);
  });
});

test("opencode's own cost stands in where our tables have no rate", async () => {
  await withDataRoot(
    async (root) => {
      const provider = new OpencodeProvider(root);
      const { unknownModels, sessionData } = await provider.readSession(
        join(root, "opencode.db"),
        SESSION_ID,
      );
      // The host priced this model, so it is not an unpriced model.
      assert.deepEqual(unknownModels, []);
      const mock = sessionData.modelBreakdowns.find(
        (entry) => entry.modelName === "mock-model",
      );
      assert.equal(mock.cost, 0.25);
    },
    {
      // A second turn on the same model, this one opencode costed itself.
      messages: [
        assistantMessage({
          id: "msg_host_priced",
          modelId: "mock-model",
          timeCreated: 1787253501276,
          cost: 0.25,
          input: 10,
          output: 20,
        }),
      ],
    },
  );
});

test("a damaged message body skips that row and never sinks the session", async () => {
  await withDataRoot(
    async (root) => {
      const provider = new OpencodeProvider(root);
      const { sessionData } = await provider.readSession(
        join(root, "opencode.db"),
        SESSION_ID,
      );
      // Exactly the intact totals: the damaged row contributed nothing and
      // raised nothing.
      assert.equal(sessionData.inputTokens, 800);
      assert.equal(sessionData.outputTokens, 680);
    },
    {
      messages: [
        {
          id: "msg_truncated",
          session_id: SESSION_ID,
          time_created: 1787253503000,
          data: '{"role":"assistant","tokens":{"input":999',
        },
      ],
    },
  );
});

test("subagent sessions fold into the session that spawned them", async () => {
  await withDataRoot(
    async (root) => {
      const provider = new OpencodeProvider(root);
      const sessions = await provider.findAllSessions();
      // The child is reached through its parent, never reconciled separately.
      assert.deepEqual(sessions.map((session) => session.sessionId), [SESSION_ID]);

      const { sessionData } = await provider.readSession(
        join(root, "opencode.db"),
        SESSION_ID,
      );
      assert.equal(sessionData.inputTokens, 800 + 100);
      assert.equal(sessionData.outputTokens, 680 + 60);
    },
    {
      sessions: [
        sessionRow({
          id: "ses_child",
          parent_id: SESSION_ID,
          slug: "child-task",
          tokens_input: 100,
          tokens_output: 50,
          tokens_reasoning: 10,
        }),
      ],
      messages: [
        assistantMessage({
          id: "msg_child",
          sessionId: "ses_child",
          modelId: "claude-sonnet-4-5",
          timeCreated: 1787253504000,
          input: 100,
          output: 50,
          reasoning: 10,
        }),
      ],
    },
  );
});

test("the fingerprint is stable across reads and moves when usage does", async () => {
  await withDataRoot(async (root) => {
    const provider = new OpencodeProvider(root);
    const [found] = await provider.findAllSessions();
    const first = await provider.fingerprintSession(found);
    const second = await provider.fingerprintSession(found);
    assert.equal(first, second);

    await withDataRoot(
      async (changed) => {
        const other = new OpencodeProvider(changed);
        const [changedSession] = await other.findAllSessions();
        assert.notEqual(await other.fingerprintSession(changedSession), first);
      },
      {
        messages: [
          assistantMessage({
            id: "msg_extra",
            modelId: "claude-sonnet-4-5",
            timeCreated: 1787253505000,
            input: 5,
            output: 5,
          }),
        ],
      },
    );
  });
});

test("reading the database without a session id is refused, not guessed", async () => {
  await withDataRoot(async (root) => {
    const provider = new OpencodeProvider(root);
    await assert.rejects(
      () => provider.readSession(join(root, "opencode.db"), ""),
      /session id is required/i,
    );
  });
});

test("a transcript inside the opencode data root detects as opencode", async () => {
  await withDataRoot(async (root) => {
    const database = join(root, "opencode.db");
    const detected = await detectProvider(database, {
      providerDataRoots: { opencode: root },
    });
    assert.equal(detected.name, "opencode");
  });
});

test("OPENCODE_DB selects the database opencode is actually writing", () => {
  const root = join(tmpdir(), "opencode-root");
  assert.equal(
    resolveDatabasePath(root, {}),
    join(root, "opencode.db"),
  );
  assert.equal(
    resolveDatabasePath(root, { OPENCODE_DB: "opencode-dev.db" }),
    join(root, "opencode-dev.db"),
  );
  const absolute = join(tmpdir(), "elsewhere", "custom.db");
  assert.equal(
    resolveDatabasePath(root, { OPENCODE_DB: absolute }),
    absolute,
  );
});

test("a missing opencode install yields no sessions rather than an error", async () => {
  const provider = new OpencodeProvider(join(tmpdir(), "agent-usage-stat-absent-opencode"));
  assert.deepEqual(await provider.findAllSessions(), []);
});
