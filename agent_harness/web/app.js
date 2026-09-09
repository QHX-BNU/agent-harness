const state = {
  currentRunId: null,
  currentSessionId: localStorage.getItem("agent-harness-session") || crypto.randomUUID(),
  serverApiKey: sessionStorage.getItem("agent-harness-api-key") || "",
  pollTimer: null,
  lastRenderedStatus: null,
};

const el = Object.fromEntries([
  "providerPill", "configButton", "newSessionButton", "historyList", "runState", "chatFeed",
  "approvalCard", "approvalTitle", "approvalReason", "denyButton", "approveButton", "promptForm",
  "promptInput", "runButton", "eventCount", "runMeta", "timeline", "configDialog", "configForm",
  "providerType", "realModelFields", "baseUrl", "modelName", "modelApiKey", "serverApiKey",
  "configStatus", "saveConfigButton", "closeConfigButton", "toast",
].map((id) => [id, document.getElementById(id)]));

const statusLabels = { running: "运行中", waiting_approval: "等待审批", completed: "已完成", failed: "失败", max_steps: "达到步数上限" };
const eventInfo = {
  "run.started": ["运行已创建", "RUN", "run"], "model.started": ["模型开始推理", "AI", "model"],
  "model.completed": ["模型返回决策", "AI", "model"], "model.retry": ["模型调用重试", "↻", "failure"],
  "policy.checked": ["策略检查", "P", "policy"], "tool.started": ["工具开始执行", "T", "tool"],
  "tool.completed": ["工具执行完成", "T", "tool"], "tool.failed": ["工具执行失败", "×", "failure"],
  "approval.requested": ["请求人工审批", "!", "approval"], "approval.resolved": ["人工审批已处理", "✓", "approval"],
  "run.completed": ["运行完成", "✓", "tool"], "run.failed": ["运行失败", "×", "failure"],
  "run.max_steps": ["触发停止条件", "■", "failure"],
};

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (state.serverApiKey) headers["X-API-Key"] = state.serverApiKey;
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function toast(message, isError = false) {
  el.toast.textContent = message; el.toast.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.toast.className = "toast"; }, 3200);
}
function timeLabel(value) { return value ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : ""; }
function setRunState(status = "idle") { el.runState.className = `run-state ${status}`; el.runState.querySelector("b").textContent = statusLabels[status] || "待命"; }

function renderRuns(runs) {
  if (!runs.length) { el.historyList.innerHTML = '<div class="history-empty">还没有运行记录</div>'; return; }
  el.historyList.innerHTML = runs.map((run) => `
    <button class="history-item ${run.run_id === state.currentRunId ? "active" : ""}" data-run-id="${escapeHtml(run.run_id)}" type="button">
      <div class="history-top"><strong>${escapeHtml(run.preview || "未命名任务")}</strong><span class="status-dot ${escapeHtml(run.status)}"></span></div>
      <p>${escapeHtml(statusLabels[run.status] || run.status)} · step ${run.step}</p><time>${escapeHtml(timeLabel(run.updated_at))}</time>
    </button>`).join("");
  el.historyList.querySelectorAll("[data-run-id]").forEach((button) => button.addEventListener("click", () => selectRun(button.dataset.runId)));
}

async function loadRuns() {
  try { const data = await api("/v1/runs?limit=40"); renderRuns(data.runs || []); }
  catch (error) { el.historyList.innerHTML = `<div class="history-empty">${escapeHtml(error.message)}</div>`; if (error.message === "unauthorized") openConfig("请先填写控制台访问密钥"); }
}

function currentTurnMessages(messages) {
  let index = -1; messages.forEach((message, i) => { if (message.role === "user") index = i; });
  return messages.slice(Math.max(0, index));
}

function renderConversation(run) {
  const messages = currentTurnMessages(run.messages || []).filter((message) => message.role === "user" || (message.role === "assistant" && message.content));
  const cards = messages.map((message) => `<article class="message ${escapeHtml(message.role)}"><div class="avatar">${message.role === "user" ? "YOU" : "AI"}</div><div class="bubble">${escapeHtml(message.content)}</div></article>`);
  if (run.status === "running") cards.push('<article class="message assistant pending"><div class="avatar">AI</div><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></article>');
  el.chatFeed.innerHTML = cards.join("") || '<div class="history-empty">没有可展示的消息</div>'; el.chatFeed.scrollTop = el.chatFeed.scrollHeight;
}

function eventDetail(event) {
  if (event.tool) return `${event.tool}${event.duration_ms != null ? ` · ${event.duration_ms}ms` : ""}`;
  if (event.reason) return event.reason;
  if (event.step) return `step ${event.step}${event.tool_count != null ? ` · ${event.tool_count} tool calls` : ""}`;
  return event.error || event.session_id || "";
}

function renderTimeline(events) {
  el.eventCount.textContent = `${events.length} events`;
  if (!events.length) { el.timeline.innerHTML = '<div class="timeline-empty"><span>◎</span><p>运行事件正在写入，请稍候…</p></div>'; return; }
  el.timeline.innerHTML = events.map((event) => {
    const info = eventInfo[event.event] || [event.event, "·", "run"];
    return `<article class="event ${info[2]}"><div class="event-icon">${info[1]}</div><div class="event-body"><div class="event-title"><strong>${escapeHtml(info[0])}</strong><time>${escapeHtml(timeLabel(event.timestamp))}</time></div><p>${escapeHtml(eventDetail(event))}</p></div></article>`;
  }).join(""); el.timeline.scrollTop = el.timeline.scrollHeight;
}

function renderApproval(run) {
  const pending = run.pending_approval;
  if (!pending || run.status !== "waiting_approval") { el.approvalCard.classList.add("hidden"); return; }
  el.approvalTitle.textContent = `${pending.tool_call.name}(${Object.keys(pending.tool_call.arguments || {}).join(", ")})`;
  el.approvalReason.textContent = pending.reason; el.approvalCard.classList.remove("hidden");
}

async function refreshCurrentRun() {
  if (!state.currentRunId) return;
  try {
    const [run, trace] = await Promise.all([api(`/v1/runs/${encodeURIComponent(state.currentRunId)}`), api(`/v1/runs/${encodeURIComponent(state.currentRunId)}/events`)]);
    setRunState(run.status); renderConversation(run); renderTimeline(trace.events || []); renderApproval(run);
    el.runMeta.innerHTML = `<span>RUN ID</span><code title="${escapeHtml(run.run_id)}">${escapeHtml(run.run_id)}</code>`;
    if (run.status !== state.lastRenderedStatus && ["completed", "failed", "max_steps"].includes(run.status)) toast(run.status === "completed" ? "Agent 运行完成" : `运行结束：${statusLabels[run.status]}`, run.status !== "completed");
    state.lastRenderedStatus = run.status;
    if (["completed", "failed", "max_steps", "waiting_approval"].includes(run.status)) stopPolling();
    await loadRuns();
  } catch (error) { stopPolling(); toast(error.message, true); }
}

function startPolling() { stopPolling(); refreshCurrentRun(); state.pollTimer = setInterval(refreshCurrentRun, 700); }
function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }

async function selectRun(runId) {
  state.currentRunId = runId; state.lastRenderedStatus = null; await refreshCurrentRun();
  const run = await api(`/v1/runs/${encodeURIComponent(runId)}`); if (run.status === "running") startPolling();
}

async function startRun(prompt) {
  el.runButton.disabled = true; setRunState("running");
  try {
    const result = await api("/v1/runs", { method: "POST", body: JSON.stringify({ input: prompt, session_id: state.currentSessionId, async: true, metadata: { channel: "web-console" } }) });
    state.currentRunId = result.run_id; state.lastRenderedStatus = null; el.promptInput.value = ""; startPolling(); await loadRuns();
  } catch (error) { setRunState(); toast(error.message, true); }
  finally { el.runButton.disabled = false; }
}

async function resolveApproval(approved) {
  if (!state.currentRunId) return;
  el.approveButton.disabled = true; el.denyButton.disabled = true; setRunState("running");
  try {
    await api(`/v1/runs/${encodeURIComponent(state.currentRunId)}/approval`, { method: "POST", body: JSON.stringify({ approved, approver: "web-console-user" }) });
    el.approvalCard.classList.add("hidden"); startPolling();
  } catch (error) { toast(error.message, true); await refreshCurrentRun(); }
  finally { el.approveButton.disabled = false; el.denyButton.disabled = false; }
}

function toggleProviderFields() { el.realModelFields.classList.toggle("hidden", el.providerType.value === "demo"); }
async function loadConfig() {
  try {
    const config = await api("/v1/config"); el.providerType.value = config.type;
    if (config.base_url) el.baseUrl.value = config.base_url; if (config.model && config.type !== "demo") el.modelName.value = config.model;
    el.serverApiKey.value = state.serverApiKey; el.providerPill.classList.toggle("connected", Boolean(config.configured));
    el.providerPill.querySelector("span").textContent = config.type === "demo" ? "离线 Demo" : config.model;
    el.configStatus.textContent = config.api_key_set ? "已配置密钥" : "无需密钥"; toggleProviderFields();
  } catch (error) { el.providerPill.querySelector("span").textContent = "需要配置"; if (error.message === "unauthorized") openConfig("请填写控制台访问密钥"); }
}
function openConfig(message = "") { el.configStatus.textContent = message; if (!el.configDialog.open) el.configDialog.showModal(); }

async function saveConfig(event) {
  event.preventDefault(); state.serverApiKey = el.serverApiKey.value.trim();
  if (state.serverApiKey) sessionStorage.setItem("agent-harness-api-key", state.serverApiKey); else sessionStorage.removeItem("agent-harness-api-key");
  el.saveConfigButton.disabled = true;
  try {
    const payload = { type: el.providerType.value };
    if (payload.type === "openai-compatible") Object.assign(payload, { base_url: el.baseUrl.value.trim(), model: el.modelName.value.trim(), api_key: el.modelApiKey.value.trim() });
    await api("/v1/config", { method: "POST", body: JSON.stringify(payload) }); el.modelApiKey.value = "";
    await loadConfig(); el.configDialog.close(); toast("模型配置已应用"); await loadRuns();
  } catch (error) { el.configStatus.textContent = error.message; }
  finally { el.saveConfigButton.disabled = false; }
}

el.promptForm.addEventListener("submit", (event) => { event.preventDefault(); const prompt = el.promptInput.value.trim(); if (prompt) startRun(prompt); });
el.promptInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); el.promptForm.requestSubmit(); } });
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => { el.promptInput.value = button.dataset.prompt; el.promptInput.focus(); }));
el.newSessionButton.addEventListener("click", () => {
  stopPolling(); state.currentRunId = null; state.currentSessionId = crypto.randomUUID(); state.lastRenderedStatus = null;
  localStorage.setItem("agent-harness-session", state.currentSessionId);
  el.chatFeed.innerHTML = '<section class="welcome-card"><span class="welcome-kicker">New session</span><h2>新的会话已经准备好。</h2><p>历史运行仍保留在左侧，新任务将使用独立的会话上下文。</p></section>';
  el.timeline.innerHTML = '<div class="timeline-empty"><span>◎</span><p>等待 Agent 开始运行。</p></div>'; el.runMeta.innerHTML = "<span>尚未选择运行</span>";
  el.eventCount.textContent = "0 events"; el.approvalCard.classList.add("hidden"); setRunState(); loadRuns();
});
el.configButton.addEventListener("click", () => openConfig()); el.providerType.addEventListener("change", toggleProviderFields);
el.closeConfigButton.addEventListener("click", () => el.configDialog.close());
el.configForm.addEventListener("submit", saveConfig); el.approveButton.addEventListener("click", () => resolveApproval(true)); el.denyButton.addEventListener("click", () => resolveApproval(false));
localStorage.setItem("agent-harness-session", state.currentSessionId); loadConfig(); loadRuns();
