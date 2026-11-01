// 本地仿真：用假的 server 对象跑一遍插件主流程，验证 cron 注册、exec 下发、轮询、解析、写快照
const path = require("path");
const os = require("os");
const fs = require("fs");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-autoprobe-"));
global.__storageDir__ = tmpDir;

const probeLib = require("/vol1/1000/openclaw/komari-plugin-route-autoprobe/plugin/lib/probe.js");

// 真实形态的 traceroute 输出（带 ASN，模拟主机开了 -A）
function fakeOutput(carrier, target, hops) {
  const lines = ["ROUTE_PROBE_CARRIER:" + carrier, "ROUTE_ATTEMPT:icmp:" + target];
  hops.forEach(function (h, i) {
    lines.push(" " + (i + 1) + "  " + (h.asn ? "AS" + h.asn + " " : "") + h.ip + "  1.0 ms  1.1 ms");
  });
  lines.push("ROUTE_EXIT:0");
  return lines.join("\n");
}

const T = "219.141.140.10", U = "202.106.195.68", M = "221.179.155.161";

const fakeClients = [
  { uuid: "aaaa-1111", name: "Ty-HK" },
  { uuid: "bbbb-2222", name: "飞牛Nas" },
  { uuid: "cccc-3333", name: "Broken" },
];

const outputs = {
  "aaaa-1111": [
    fakeOutput("telecom", T, [{ ip: "192.168.1.1" }, { asn: 4134, ip: "59.43.1.1" }, { asn: 4134, ip: T }]),
    fakeOutput("unicom", U, [{ ip: "192.168.1.1" }, { asn: 4837, ip: "219.158.1.1" }, { asn: 4837, ip: U }]),
    fakeOutput("mobile", M, [{ ip: "192.168.1.1" }, { asn: 58453, ip: "223.120.1.1" }, { asn: 58453, ip: M }]),
  ].join("\n"),
  "bbbb-2222": [
    fakeOutput("telecom", T, [{ ip: "10.0.0.1" }, { asn: 4809, ip: "59.43.2.1" }, { asn: 4809, ip: T }]),
    fakeOutput("unicom", U, [{ ip: "10.0.0.1" }, { asn: 9929, ip: "218.105.1.1" }, { asn: 9929, ip: U }]),
    fakeOutput("mobile", M, [{ ip: "10.0.0.1" }, { asn: 58807, ip: "223.120.2.1" }, { asn: 58807, ip: M }]),
  ].join("\n"),
  "cccc-3333": "ROUTE_PROBE_ERROR:missing_traceroute\n",
};

const calls = [];
let taskCounter = 0;
const tasks = {};

const fakeServer = {
  call: async function (method, params) {
    calls.push({ method: method, params: params });
    if (method === "admin:listClients") return fakeClients;
    if (method === "admin:exec") {
      taskCounter += 1;
      const id = "task-" + taskCounter;
      tasks[id] = { params: params, readyAt: Date.now() + 500 };
      return { task_id: id };
    }
    if (method === "admin:getTaskById") {
      const t = tasks[params.task_id];
      if (!t) return { results: [] };
      if (Date.now() < t.readyAt) return { results: [] };
      return {
        results: t.params.clients.map(function (uuid) {
          return {
            client: uuid,
            result: outputs[uuid] || "",
            finished_at: new Date().toISOString(),
          };
        }),
      };
    }
    throw new Error("unexpected call: " + method);
  },
  cron: function (spec, handler) {
    calls.push({ method: "server.cron", params: { spec: spec } });
    fakeServer._cronHandler = handler;
    fakeServer._cronSpec = spec;
  },
  getConfig: async function () {
    return { enabled: true, cronSpec: "*/30 * * * *", autoInstall: true };
  },
};

(async function () {
  const manager = probeLib.createProbeManager(fakeServer);
  const cfg = await manager.init();
  console.log("=== 配置 ===");
  console.log(JSON.stringify(cfg));

  console.log("\n=== cron 注册 ===");
  console.log("spec:", fakeServer._cronSpec, "| handler 存在:", typeof fakeServer._cronHandler);

  console.log("\n=== 手动跑一轮 ===");
  const t0 = Date.now();
  const result = await manager.runOnce("local_simulation");
  console.log("耗时:", Date.now() - t0, "ms");
  console.log("结果:", JSON.stringify(result));

  console.log("\n=== 下发的命令首尾 ===");
  const execCall = calls.find(function (c) { return c.method === "admin:exec"; });
  const cmd = execCall.params.command;
  const lines = cmd.split("\n");
  console.log("命令行数:", lines.length, "| 探测节点:", execCall.params.clients.length);
  console.log("--- 前 6 行 ---");
  lines.slice(0, 6).forEach(function (l) { console.log("|" + l); });
  console.log("--- 后 6 行 ---");
  lines.slice(-6).forEach(function (l) { console.log("|" + l); });

  console.log("\n=== 快照解析结果 ===");
  const snap = manager.getSnapshot();
  console.log("updatedAt:", snap.updatedAt, "| runs:", snap.telemetry.runs, "| nodes:", Object.keys(snap.nodes).length);
  for (const uuid in snap.nodes) {
    const n = snap.nodes[uuid];
    const name = (fakeClients.find(function (c) { return c.uuid === uuid; }) || {}).name;
    console.log("\n[" + name + "] state=" + n.state);
    ["telecom", "unicom", "mobile"].forEach(function (c) {
      const r = n.carriers[c];
      console.log("  " + c + ": passage=" + JSON.stringify(r.passage)
        + " landing=" + JSON.stringify(r.landing)
        + " confirmed=" + r.landingConfirmed + " state=" + r.state);
    });
  }

  console.log("\n=== cron 触发验证 ===");
  await fakeServer._cronHandler();
  console.log("cron 跑完后 runs:", manager.getSnapshot().telemetry.runs);

  console.log("\n=== 快照已落盘? ===");
  console.log("路径:", path.join(tmpDir, "route-snapshot.json"));
  console.log("存在:", fs.existsSync(path.join(tmpDir, "route-snapshot.json")));

  manager.shutdown();
  console.log("\n=== 全部通过 ===");
})().catch(function (e) {
  console.error("失败:", e && e.stack || e);
  process.exit(1);
});
