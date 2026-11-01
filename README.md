# komari-plugin-route-autoprobe

Komari 面板插件：**三网回程自动探测**。

面板服务端 cron 定时向所有节点下发 traceroute，自动识别电信/联通/移动三网回程线路并保存快照。
新机器挂上探针即自动纳入探测，**不需要浏览器保持登录，也不需要任何人登录面板**。

## 为什么需要插件

主题自带的自动探测跑在浏览器里，必须有管理员登录态且页面处于活动状态。
本插件把同样的探测搬到面板服务端，由面板进程的 cron 驱动，因此真正无人值守。

## 能力

- `server.cron` 五段式定时（默认每小时第 17 分）
- `admin:exec` 向节点下发探测命令，`admin:getTaskById` 轮询结果
- 节点缺少 traceroute 且以 root 运行时自动安装（apt / apk / dnf / yum）
- 结果保存在插件自己的 `__storageDir__/route-snapshot.json`

## 接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/plugin/route-autoprobe/snapshot` | 公开 | 返回探测快照 |
| GET | `/api/plugin/route-autoprobe/debug` | 管理员 | 配置、运行状态、最近日志 |
| POST | `/api/plugin/route-autoprobe/run` | 管理员 | 立即跑一轮 |

RPC：`routeAutoprobe:run`、`routeAutoprobe:snapshot`

## 安装

面板 → 插件 → 上传 `komari-plugin-route-autoprobe.zip` → 启用。
上传后插件会把包内 `plugin/` 解到插件目录，注意保持目录结构。

## 数据结构

`snapshot.nodes[uuid]` 与主题 `pandaOpsRouteProbeResults` 的单项同构（`version: 2`，
`carriers.telecom/unicom/mobile` 含 `passage`、`landing`、`landingConfirmed`、`asns`、
`lastAttempt`、`lastSuccess`、`state`），可直接被主题读取或转发。

## 解析规则与主题保持一致

`plugin/lib/parser.js` 不是自创规则，而是逐函数移植主题
`Glassmorphism-Enhanced/src/utils/routeProbe.ts` 的实现：

| 函数 | 说明 |
| --- | --- |
| `resolvePrefix` | 八位组精确边界的前缀回退表（不是 BGP 数据库），含 CMIN2 的 25 个子段 |
| `parseHop` | 优先采用 `traceroute -A` 查到的 ASN，缺失时才用前缀表 |
| `summarizeRouteAttempt` | 取最后一段骨干作 `passage`，落地取最后识别骨干 |
| `classify` / `overall` | 多方法择优选，同等完整但结论不同则不下主标签 |
| `mergeRouteResult` | 本次失败时保留上次成功证据并标记 `stale`，不清空 |

因此插件快照与主题浏览器端探测**同构同结论**，两者可以直接对照。

## 与主题配合

主题 1.1.9 起会优先读取本插件快照（每 5 分钟一次），插件在线时**不再启动
浏览器端 traceroute**；插件不可用时自动回退到原有逻辑。

## 验证记录

在 4 节点真实环境（含美国、德国、香港、家庭 NAS）跑通，输出与主题原版逐项一致：

```text
Vmiss9929  telecom=10099 → 9929 (163)  unicom=9929   mobile=CMIN2
Nc1o       telecom=163 → 163           unicom=4837   mobile=CMI
飞牛Nas    telecom=163 → 163           unicom=163    mobile=163
Ty-HK      telecom=CN2-CTG             unicom=4837   mobile=CMI
```


## 许可

MIT
