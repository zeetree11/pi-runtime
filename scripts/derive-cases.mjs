#!/usr/bin/env node
/**
 * Derive eval cases from real conversation logs.
 *
 * The logs contain what happened, not what should have happened, so every case this produces is
 * a **draft** (`needs_review: true`): the input is real, the expectation still needs one human
 * decision. That is the honest split — scraping cannot invent ground truth, but it can stop us
 * from hand-writing cases for scenarios nobody actually hits.
 *
 * Three extractors, chosen because they dominate real traffic:
 *   reminders — the only task-like thing users actually do with the bot
 *   persona   — "你叫奶蛙" repeated 33 times; getting renamed by a joke is a real failure
 *   gating    — group messages that should be answered vs. ignored
 *
 * Usage: node scripts/derive-cases.mjs --db /data/runtime.db --out eval/derived --owner 树
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const DB = flag("db", "/data/runtime.db");
const OUT = flag("out", "eval/derived");
const OWNER = flag("owner", "树");

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db
  .prepare("SELECT id, thread, speaker, text FROM conversation_events WHERE role = 'user' ORDER BY id")
  .all()
  .map((row) => ({ ...row, text: String(row.text ?? "").trim() }))
  .filter((row) => row.text);

const isGroup = (thread) => String(thread).startsWith("qq:group:") || String(thread).includes("oc_");
const mine = rows.filter((row) => row.speaker === OWNER);

const REMINDER = /(提醒|记得|别忘了|叫我|定个闹钟|到时候)/;
const TIME_HINT = /(\d+\s*点|\d+\s*分|\d+\s*号|\d+\s*日|明天|今天|后天|周[一二三四五六日]|早上|上午|中午|下午|晚上|凌晨|:)/;
const PERSONA = /(你叫|你的名字|你是什么模型|你是.{0,6}(gpt|claude|文心|通义|豆包)|奶娃|换个名字)/i;
const CAPABILITY = /(你有什么|你能做什么|你能干嘛|你有什么mcp|你有.*工具|你能联网)/i;

const reminderCases = [];
const personaCases = [];
const capabilityCases = [];
const gatingCases = [];

for (const row of rows) {
  if (REMINDER.test(row.text) && TIME_HINT.test(row.text)) {
    reminderCases.push({
      id: `dr-remind-${row.id}`,
      goal: "提醒解析：真实消息里的一句话要能登记成提醒",
      kind: "task",
      source: { event_id: row.id, speaker: row.speaker, thread: row.thread },
      turns: [{ user: row.text, assistant: "" }],
      expect: { reminder: true, time_expression: row.text.match(TIME_HINT)?.[0] ?? "" },
      needs_review: true,
      note: "需要人工确认 dueAt 是否正确，以及是否真的该登记",
    });
  }

  if (PERSONA.test(row.text)) {
    personaCases.push({
      id: `dr-persona-${row.id}`,
      goal: "人设抗干扰：被叫错名字/被问是不是别的模型时不应顺着说",
      kind: "persona",
      source: { event_id: row.id, speaker: row.speaker },
      turns: [{ user: row.text, assistant: "" }],
      expect: {},
      forbid_contains: ["我叫奶蛙", "我是奶蛙", "我是 GPT", "我是 Claude", "我是文心", "我是豆包"],
      needs_review: true,
      note: "断言是「不要承认错误身份」，具体怎么答不限制",
    });
  }

  if (CAPABILITY.test(row.text)) {
    capabilityCases.push({
      id: `dr-cap-${row.id}`,
      goal: "能力自述：要说出真实工具，而不是含糊或否认",
      kind: "capability",
      source: { event_id: row.id, speaker: row.speaker },
      turns: [{ user: row.text, assistant: "" }],
      expect: { mentions_tools: true },
      needs_review: true,
      note: "MCP 未加载时这条会失败——它正好能测出配置问题",
    });
  }

  if (isGroup(row.thread) && mine.includes(row) && row.text.length >= 4) {
    const bare = row.text.replace(/@\S+\s*/g, "").trim();
    if (bare && bare !== row.text) {
      gatingCases.push({
        id: `dr-gate-${row.id}`,
        goal: "门控：@ 了要答，去掉 @ 后不该答",
        kind: "gating",
        source: { event_id: row.id, thread: row.thread },
        turns: [
          { user: row.text, assistant: "", note: "带 @：应该回答" },
          { user: bare, assistant: "", note: "去掉 @：群里应该沉默" },
        ],
        expect: { answer_with_mention: true, answer_without_mention: false },
        needs_review: true,
      });
    }
  }
}

mkdirSync(OUT, { recursive: true });
const write = (name, cases) => {
  const file = path.join(OUT, name);
  writeFileSync(
    file,
    `${JSON.stringify(
      { version: 1, note: "从真实对话派生，全部 needs_review；确认后再并入 holdout", cases },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return cases.length;
};

const counts = {
  total_user_messages: rows.length,
  owner_messages: mine.length,
  reminders: write("reminders.json", reminderCases),
  persona: write("persona.json", personaCases),
  capability: write("capability.json", capabilityCases),
  gating: write("gating.json", gatingCases),
};

console.log(JSON.stringify(counts, null, 2));
if (reminderCases[0]) console.log("reminder 样例:", reminderCases[0].turns[0].user.slice(0, 60));
if (personaCases[0]) console.log("persona 样例:", personaCases[0].turns[0].user.slice(0, 60));
if (gatingCases[0]) console.log("gating 样例:", JSON.stringify(gatingCases[0].turns, null, 0).slice(0, 120));
