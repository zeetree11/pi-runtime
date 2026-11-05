const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;

const titles = {
  "zh-CN": "Tree-Agent — 记得住的个人 Agent 运行时",
  en: "Tree-Agent — a personal agent runtime that remembers",
};
const descriptions = {
  "zh-CN": "Tree-Agent 把 pi 编码代理包成个人运行时：SQLite 队列、证据记忆、飞书、QQ、Web 和命令行。数据留在你的机器上。",
  en: "Tree-Agent wraps the pi coding agent as a personal runtime: a SQLite queue, evidence-backed memory, Feishu, QQ, web, and the CLI. The data stays on your machine.",
};

function lang() {
  return root.lang === "en" ? "en" : "zh";
}

function applyChrome() {
  const key = root.lang === "en" ? "en" : "zh-CN";
  document.title = titles[key];
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute("content", descriptions[key]);
  document.querySelector("#lang-zh").setAttribute("aria-pressed", String(lang() !== "en"));
  document.querySelector("#lang-en").setAttribute("aria-pressed", String(lang() === "en"));
  const dark = root.dataset.theme === "dark";
  const themeBtn = document.querySelector("#theme");
  themeBtn.setAttribute("aria-pressed", String(dark));
  themeBtn.setAttribute("aria-label", lang() === "en" ? (dark ? "Switch to light" : "Switch to dark") : (dark ? "切换到浅色" : "切换到深色"));
  const color = document.querySelector('meta[name="theme-color"]');
  if (color) color.setAttribute("content", dark ? "#131110" : "#f3eee6");
}

function setLang(next) {
  root.lang = next === "en" ? "en" : "zh-CN";
  try { localStorage.setItem("tree-agent-lang", next === "en" ? "en" : "zh"); } catch (e) {}
  applyChrome();
  play(true);
}

function setTheme(dark) {
  if (dark) root.dataset.theme = "dark";
  else delete root.dataset.theme;
  try { localStorage.setItem("tree-agent-theme", dark ? "dark" : "light"); } catch (e) {}
  applyChrome();
}

document.querySelector("#lang-zh").addEventListener("click", () => setLang("zh"));
document.querySelector("#lang-en").addEventListener("click", () => setLang("en"));
document.querySelector("#theme").addEventListener("click", () => setTheme(root.dataset.theme !== "dark"));

const nav = document.querySelector(".nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
document.addEventListener("scroll", onScroll, { passive: true });
onScroll();

const menuBtn = document.querySelector(".menu-btn");
const navLinks = document.querySelector("#nav-links");
menuBtn.addEventListener("click", () => {
  const open = navLinks.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", String(open));
});
navLinks.addEventListener("click", (event) => {
  if (event.target.closest("a")) {
    navLinks.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
  }
});

const chips = {
  1: { zh: "读入", en: "reading" },
  2: { zh: "写入事件", en: "writing the event" },
  3: { zh: "memory_search", en: "memory_search" },
  4: { zh: "组装上下文", en: "composing" },
  5: { zh: "pi · rpc", en: "pi · rpc" },
};

const thread = document.querySelector("#thread");
const reply = document.querySelector("#reply");
const chipLabel = document.querySelector("#chip-label");
let timers = [];
let typing = 0;

function clearTimers() {
  timers.forEach((id) => window.clearTimeout(id));
  timers = [];
  window.clearInterval(typing);
}

function showChip(step) {
  const text = chips[step][lang()];
  chipLabel.textContent = text;
}

function typeReply() {
  const full = reply.getAttribute(lang() === "en" ? "data-en" : "data-zh");
  const span = reply.querySelector(lang() === "en" ? ".en" : ".zh");
  if (reduce) {
    span.textContent = full;
    return;
  }
  span.textContent = "";
  let i = 0;
  typing = window.setInterval(() => {
    i += 1;
    span.textContent = full.slice(0, i);
    if (i >= full.length) window.clearInterval(typing);
  }, 32);
}

function play(restart) {
  clearTimers();
  const steps = [...thread.querySelectorAll("[data-step]")];
  if (reduce) {
    thread.classList.add("settled");
    thread.classList.remove("play");
    showChip(5);
    const span = reply.querySelector(lang() === "en" ? ".en" : ".zh");
    span.textContent = reply.getAttribute(lang() === "en" ? "data-en" : "data-zh");
    return;
  }
  thread.classList.remove("settled");
  thread.classList.add("play");
  steps.forEach((node) => node.classList.remove("on"));
  reply.querySelectorAll("span").forEach((span) => {
    const which = span.classList.contains("en") ? "data-en" : "data-zh";
    span.textContent = reply.getAttribute(which);
  });
  const schedule = [450, 1400, 2400, 3400, 4500];
  steps.forEach((node, index) => {
    timers.push(window.setTimeout(() => {
      node.classList.add("on");
      showChip(index + 1);
      if (node === reply) typeReply();
    }, schedule[index]));
  });
  timers.push(window.setTimeout(play, 11000));
}

document.querySelector("#replay").addEventListener("click", () => play(true));

const tabs = [
  { button: document.querySelector("#tab-cli"), panel: document.querySelector("#panel-cli") },
  { button: document.querySelector("#tab-web"), panel: document.querySelector("#panel-web") },
];

function selectTab(index) {
  tabs.forEach((tab, i) => {
    const on = i === index;
    tab.button.setAttribute("aria-selected", String(on));
    tab.button.tabIndex = on ? 0 : -1;
    tab.panel.hidden = !on;
  });
}

tabs.forEach((tab, index) => {
  tab.button.addEventListener("click", () => selectTab(index));
  tab.button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : (index + tabs.length - 1) % tabs.length;
    selectTab(next);
    tabs[next].button.focus();
  });
});

const copyBtn = document.querySelector("#copy");
copyBtn.addEventListener("click", async () => {
  const panel = tabs.find((tab) => !tab.panel.hidden).panel;
  const text = panel.innerText.replace(/^\$\s/gm, "").trim();
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  const previous = copyBtn.innerHTML;
  copyBtn.classList.add("done");
  copyBtn.textContent = lang() === "en" ? "Copied" : "已复制";
  window.setTimeout(() => {
    copyBtn.classList.remove("done");
    copyBtn.innerHTML = previous;
  }, 1600);
});

applyChrome();
play(true);
