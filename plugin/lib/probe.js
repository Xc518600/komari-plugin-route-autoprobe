// plugin/lib/probe.js
// Komari 三网回程自动探测：cron 定时 -> admin:exec 下发 traceroute -> 轮询结果 -> 解析 -> 写快照
// 写路径完全在面板服务端，不依赖浏览器登录态，也不会产生登录告警。

const fs = require("fs");
const path = require("path");
const parser = require("./parser.js");

const SNAPSHOT_FILENAME = "route-snapshot.json";
const POLL_INTERVAL_MS = 3000;
const DEFAULT_BUDGET_SECONDS = 300;
const TOOL_INSTALL_BUDGET_SECONDS = 180;

const memoryLogs = [];
function log(level, message, data) {
  const timeStr = new Date().toISOString();
  memoryLogs.push({ time: timeStr, level: level, message: message, data: data || null });
  if (memoryLogs.length > 200) memoryLogs.shift();
  const formatted = "[route-autoprobe] [" + timeStr.slice(11, 19) + "] [" + level.toUpperCase() + "] "
    + message + (data ? (" " + JSON.stringify(data)) : "");
  if (level === "error") console.error(formatted);
  else if (level === "warn") console.warn(formatted);
  else console.info(formatted);
}

function getStorageDir() {
  return (typeof __storageDir__ === "string" && __storageDir__) ? __storageDir__ : ".";
}
function snapshotPath() {
  return path.join(getStorageDir(), SNAPSHOT_FILENAME);
}

function emptySnapshot() {
  return { version: 1, updatedAt: null, lastRunAt: null, lastError: null, nodes: {}, telemetry: { runs: 0 } };
}
function loadSnapshot() {
  try {
    const p = snapshotPath();
    if (!fs.existsSync(p)) return emptySnapshot();
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptySnapshot();
    if (!parsed.nodes || typeof parsed.nodes !== "object") parsed.nodes = {};
    if (!parsed.telemetry) parsed.telemetry = { runs: 0 };
    return parsed;
  } catch (err) {
    log("warn", "快照读取失败，重建", { error: String(err && err.message || err) });
    return emptySnapshot();
  }
}
function saveSnapshot(snap) {
  try {
    const dir = getStorageDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(snapshotPath(), JSON.stringify(snap, null, 2), "utf8");
  } catch (err) {
    log("error", "快照写入失败", { error: String(err && err.message || err) });
  }
}

function asBool(v, dflt) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  return dflt;
}
function asInt(v, dflt, min, max) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: asBool(cfg.enabled, true),
    cronSpec: String(cfg.cronSpec || "17 * * * *").trim() || "17 * * * *",
    autoInstall: asBool(cfg.autoInstall, true),
    budgetSeconds: asInt(cfg.budgetSeconds, DEFAULT_BUDGET_SECONDS, 60, 600),
    maxNodes: asInt(cfg.maxNodes, 50, 1, 500),
    targets: {
      telecom: String(cfg.targetTelecom || "219.141.140.10").trim() || "219.141.140.10",
      unicom: String(cfg.targetUnicom || "202.106.195.68").trim() || "202.106.195.68",
      mobile: String(cfg.targetMobile || "221.179.155.161").trim() || "221.179.155.161",
    },
  };
}

// 与主题 ROUTE_PROBE_COMMAND 保持一致，额外加一段可选的工具自举。
function buildProbeCommand(cfg, ensureTools) {
  const guard = ensureTools
    ? `
ensure_tools() {
  command -v traceroute >/dev/null 2>&1 && return 0
  [ "$(id -u)" = 0 ] || return 0
  if command -v apt-get >/dev/null 2>&1; then
    timeout -k 5 120 apt-get update >/dev/null 2>&1
    timeout -k 5 120 env DEBIAN_FRONTEND=noninteractive apt-get install -y traceroute >/dev/null 2>&1
  elif command -v apk >/dev/null 2>&1; then
    timeout -k 5 120 apk add --no-cache traceroute >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    timeout -k 5 120 dnf install -y traceroute >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    timeout -k 5 120 yum install -y traceroute >/dev/null 2>&1
  fi
  return 0
}
ensure_tools
`
    : "";
  return guard + `
command -v traceroute >/dev/null 2>&1 || { echo ROUTE_PROBE_ERROR:missing_traceroute; exit 127; }
command -v timeout >/dev/null 2>&1 || { echo ROUTE_PROBE_ERROR:missing_timeout; exit 127; }
A=''; timeout -k 1 3 traceroute --help 2>&1 | grep -q -- '-A' && A='-A'
probe() {
  echo "ROUTE_PROBE_CARRIER:$1"
  echo "ROUTE_ATTEMPT:icmp:$2"
  out=$(timeout -k 2 40 traceroute -I $A -n -q 2 -w 2 -m 24 "$2" 2>&1)
  rc=$?
  printf '%s\\n' "$out"
  echo "ROUTE_EXIT:$rc"
  if [ "$rc" -ne 0 ] && [ -n "$A" ]; then
    echo "ROUTE_ATTEMPT:icmp_plain:$2"
    out=$(timeout -k 2 34 traceroute -I -n -q 2 -w 2 -m 24 "$2" 2>&1)
    rc=$?
    printf '%s\\n' "$out"
    echo "ROUTE_EXIT:$rc"
  fi
  valid=$(printf '%s' "$out" | grep -cE '^[[:space:]]*[0-9]+[[:space:]]+[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+')
  if [ "\${valid:-0}" -lt 3 ]; then
    echo "ROUTE_ATTEMPT:udp:$2"
    timeout -k 2 40 traceroute $A -n -q 2 -w 2 -m 24 "$2" 2>&1
    echo "ROUTE_EXIT:$?"
  fi
}
probe telecom ${cfg.targets.telecom}
probe unicom ${cfg.targets.unicom}
probe mobile ${cfg.targets.mobile}
exit 0
`;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function listClients(server) {
  const resp = await server.call("admin:listClients");
  let rows = [];
  if (Array.isArray(resp)) rows = resp;
  else if (resp && Array.isArray(resp.clients)) rows = resp.clients;
  else if (resp && Array.isArray(resp.data)) rows = resp.data;
  return rows
    .filter(function (r) { return r && typeof r.uuid === "string" && r.uuid; })
    .map(function (r) { return { uuid: r.uuid, name: String(r.name || r.uuid.slice(0, 8)) }; });
}

async function runProbeOnClients(server, uuids, command, budgetMs) {
  const execResp = await server.call("admin:exec", { command: command, clients: uuids });
  const taskId = execResp && (execResp.task_id || (execResp.data && execResp.data.task_id));
  if (!taskId) throw new Error("admin:exec 未返回 task_id: " + JSON.stringify(execResp).slice(0, 200));

  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let resp;
    try {
      resp = await server.call("admin:getTaskById", { task_id: String(taskId) });
    } catch (err) {
      continue;
    }
    const rows = (resp && (resp.results || resp.data)) || [];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const done = rows.filter(function (r) {
      return r && typeof r.finished_at === "string" && r.finished_at.length > 0;
    });
    if (done.length >= uuids.length) {
      const out = {};
      done.forEach(function (r) {
        out[r.client || r.uuid] = typeof r.result === "string" ? r.result : "";
      });
      return out;
    }
  }
  log("warn", "任务等待超时", { taskId: String(taskId) });
  return null;
}

function createProbeManager(server) {
  let cfg = normalizeConfig({});
  let cronRegistered = false;
  let running = false;
  let unloaded = false;

  async function runOnce(reason) {
    if (unloaded || running) return { triggered: false, reason: running ? "already-running" : "unloaded" };
    running = true;
    const snap = loadSnapshot();
    try {
      const clients = await listClients(server);
      if (clients.length === 0) {
        log("warn", "没有可用节点");
        return { triggered: true, probed: 0 };
      }
      const targets = clients.slice(0, cfg.maxNodes);
      log("info", "开始探测", { reason: reason, nodes: targets.length });

      const command = buildProbeCommand(cfg, cfg.autoInstall);
      const budgetMs = (cfg.budgetSeconds + (cfg.autoInstall ? TOOL_INSTALL_BUDGET_SECONDS : 0)) * 1000;
      const outputs = await runProbeOnClients(server, targets.map(function (t) { return t.uuid; }), command, budgetMs);

      let probed = 0;
      if (outputs) {
        const nameByUuid = {};
        targets.forEach(function (t) { nameByUuid[t.uuid] = t.name; });
        for (const uuid in outputs) {
          const raw = outputs[uuid];
          if (!raw || raw.indexOf("ROUTE_PROBE_CARRIER:") < 0) continue;
          const parsed = parser.parseRouteProbeOutput(raw, Date.now());
          const previous = snap.nodes[uuid];
          snap.nodes[uuid] = previous ? parser.mergeRouteResult(previous, parsed) : parsed;
          probed += 1;
          log("info", "节点完成", {
            node: nameByUuid[uuid] || uuid.slice(0, 8),
            telecom: parser.labelOf(snap.nodes[uuid], "telecom"),
            unicom: parser.labelOf(snap.nodes[uuid], "unicom"),
            mobile: parser.labelOf(snap.nodes[uuid], "mobile"),
          });
        }
      }

      snap.lastRunAt = new Date().toISOString();
      snap.updatedAt = snap.lastRunAt;
      snap.lastError = null;
      snap.telemetry.runs = (snap.telemetry.runs || 0) + 1;
      saveSnapshot(snap);
      log("info", "本轮结束", { probed: probed });
      return { triggered: true, probed: probed };
    } catch (err) {
      const message = String((err && err.message) || err);
      snap.lastError = message;
      snap.lastRunAt = new Date().toISOString();
      saveSnapshot(snap);
      log("error", "探测失败", { error: message });
      return { triggered: true, error: message };
    } finally {
      running = false;
    }
  }

  async function syncConfig() {
    let raw = {};
    try { raw = await server.getConfig(); } catch (err) { log("warn", "读取配置失败，用默认值", { error: String(err && err.message || err) }); }
    cfg = normalizeConfig(raw);
    if (!cronRegistered) {
      try {
        server.cron(cfg.cronSpec, async function () {
          if (!unloaded && cfg.enabled) await runOnce("scheduled_cron");
        });
        cronRegistered = true;
        log("info", "已注册定时任务", { cron: cfg.cronSpec });
      } catch (err) {
        log("error", "cron 注册失败", { error: String(err && err.message || err), cron: cfg.cronSpec });
      }
    }
    return cfg;
  }

  function shutdown() { unloaded = true; }

  return {
    init: syncConfig,
    runOnce: runOnce,
    shutdown: shutdown,
    getConfig: function () { return cfg; },
    getSnapshot: function () { return loadSnapshot(); },
    getLogs: function () { return memoryLogs.slice(-100); },
    isRunning: function () { return running; },
  };
}

module.exports = { createProbeManager: createProbeManager, log: log };
