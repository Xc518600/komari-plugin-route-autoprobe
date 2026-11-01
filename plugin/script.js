// plugin/script.js
// Komari 插件：三网回程自动探测 (route-autoprobe)
// 读写分离：cron / 管理员手动触发执行探测并写快照；前台零阻塞读取快照。

const server = require("server");
const probeLib = require("./lib/probe.js");

let manager = null;
let startupTimer = null;
const PREFIX = "/api/plugin/route-autoprobe";

function sendJSON(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function isAdministrator(req) {
  const ctx = req && req.context;
  if (!ctx) return false;
  if (ctx.role === "admin") return true;
  if (ctx.principal && Array.isArray(ctx.principal.roles) && ctx.principal.roles.indexOf("admin") >= 0) return true;
  return false;
}

function load() {
  manager = probeLib.createProbeManager(server);

  // 读路径：公开返回快照，前台或主题可直接消费
  server.route("GET", PREFIX + "/snapshot", (req, res) => {
    const snap = manager.getSnapshot();
    sendJSON(res, 200, { status: "success", data: snap });
  });

  // 管理员诊断：配置、运行状态与最近日志
  server.route("GET", PREFIX + "/debug", (req, res) => {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    sendJSON(res, 200, {
      status: "success",
      data: {
        config: manager.getConfig(),
        running: manager.isRunning(),
        logs: manager.getLogs(),
      },
    });
  });

  // 管理员手动触发一轮
  server.route("POST", PREFIX + "/run", async (req, res) => {
    if (!isAdministrator(req)) {
      sendJSON(res, 403, { status: "error", message: "需要管理员权限" });
      return;
    }
    try {
      const result = await manager.runOnce("manual");
      sendJSON(res, 200, { status: "success", data: result });
    } catch (err) {
      sendJSON(res, 500, { status: "error", message: String((err && err.message) || err) });
    }
  });

  // 供其他插件/RPC 调用
  try {
    server.registerRPC("routeAutoprobe:run", async (params) => {
      return await manager.runOnce((params && params.reason) || "rpc");
    });
    server.registerRPC("routeAutoprobe:snapshot", async () => {
      return manager.getSnapshot();
    });
  } catch (err) {
    console.warn("[route-autoprobe] RPC 注册失败:", err && err.message);
  }

  // 配置同步与 cron 注册放到首帧之后，避免阻塞加载
  startupTimer = setTimeout(async () => {
    if (!manager) return;
    try {
      const cfg = await manager.init();
      console.info("[route-autoprobe] 就绪，cron=" + cfg.cronSpec + " autoInstall=" + cfg.autoInstall
        + " enabled=" + cfg.enabled);
    } catch (err) {
      console.warn("[route-autoprobe] 初始化失败:", err && err.message);
    }
  }, 800);

  console.info("[route-autoprobe] 插件已加载 " + PREFIX + "/snapshot");
}

function unload() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (manager) {
    manager.shutdown();
    manager = null;
  }
  console.info("[route-autoprobe] 插件已卸载");
}

// 注意：入口脚本运行在 goja 沙箱顶层，没有 module 对象。
// 运行时按函数名直接调用 load() / unload()，不要再写 module.exports。
