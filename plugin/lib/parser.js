// plugin/lib/parser.js
// 三网回程输出解析，逐函数对齐 Glassmorphism-Enhanced src/utils/routeProbe.ts。
// 不再自创判定规则：resolvePrefix / parseHop / summarizeRouteAttempt / classify /
// overall / parseRouteProbeOutput / mergeRouteResult 全部照原版移植，
// 保证插件产出与主题浏览器端探测同构同结论。

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOP_RE = /^\s*(\d+)\s+/;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ASN_RE = /\bAS(\d+)\b/gi;
const ATTEMPT_RE = /ROUTE_ATTEMPT:(\w+):(\d+\.\d+\.\d+\.\d+)\n([\s\S]*?)(?:ROUTE_EXIT:(\d+)|$)/g;
const ERROR_RE = /ROUTE_PROBE_ERROR:(\w+)/;
const CARRIERS = ["telecom", "unicom", "mobile"];

const NAMES = {
  4809: "CN2",
  4134: "163",
  9929: "9929",
  4837: "4837",
  58807: "CMIN2",
  58453: "CMI",
  9808: "CMNET",
  10099: "10099",
  23764: "CN2-CTG",
};
const CARRIER_ASNS = {
  telecom: [4809, 4134, 23764],
  unicom: [9929, 4837, 10099],
  mobile: [58807, 58453, 9808],
};
// 已知接入 ASN 不改标为骨干 ASN。只有观察到的前置骨干才描述为国内交付网。
const ACCESS_ASNS = {
  telecom: [],
  // CUG(10099) 是联通国际入口，回国内骨干是 9929/4837，它们才前置 passage 标签。
  unicom: [10099],
  mobile: [56048],
};

const CMIN2_THIRD_OCTETS = [
  8, 9, 10, 11, 12, 13, 14, 15, 26, 27, 28, 29, 32, 33, 34, 35, 36, 37,
  74, 75, 88, 89, 100, 252, 253,
];
const PREFIXES = [
  [59, 43, 4809],
  [202, 97, 4134],
  [218, 105, 9929],
  [210, 51, 9929],
  [219, 158, 4837],
  [223, 118, 58453],
  [223, 119, 58453],
  [223, 120, 58453],
  [223, 121, 58453],
  [221, 183, 9808],
  [111, 24, 9808],
];

/** 精确到八位组的有限回退证据，不是 BGP 数据库。 */
function resolvePrefix(ip) {
  if (!IPV4_RE.test(ip)) return undefined;
  const octets = ip.split(".").map(Number);
  if (octets.some(function (n) { return n > 255; })) return undefined;
  const a = octets[0], b = octets[1], c = octets[2];
  if (a === 223 && (
    (b === 118 && c === 32)
    || (b === 120 && c >= 128)
    || (b === 119 && CMIN2_THIRD_OCTETS.indexOf(c) >= 0)
  )) {
    return 58807;
  }
  for (let i = 0; i < PREFIXES.length; i += 1) {
    if (a === PREFIXES[i][0] && b === PREFIXES[i][1]) return PREFIXES[i][2];
  }
  return undefined;
}

function parseHop(raw) {
  const distance = (raw.match(HOP_RE) || [])[1];
  if (!distance) return null;
  const ips = Array.from(raw.matchAll(IP_RE)).map(function (m) { return m[0]; })
    .filter(function (ip) { return ip.split(".").every(function (n) { return Number(n) <= 255; }); });
  const queried = Array.from(raw.matchAll(ASN_RE)).map(function (m) { return Number(m[1]); })
    .filter(function (n) { return n > 0; });
  const prefixes = ips.map(resolvePrefix).filter(function (n) { return n !== undefined; });
  const conflict = queried.length > 0 && prefixes.some(function (n) { return queried.indexOf(n) < 0; });
  return {
    distance: Number(distance),
    ips: ips,
    asns: queried.length ? queried : prefixes,
    source: conflict ? "conflict" : queried.length ? "query" : prefixes.length ? "prefix" : "none",
    timeout: raw.indexOf("*") >= 0,
    raw: raw.slice(0, 1000),
  };
}

/** 有序标签；不建立到达性或服务质量。 */
function getRouteProfile(carrier, asns) {
  const known = asns.filter(function (n) { return CARRIER_ASNS[carrier].indexOf(n) >= 0; });
  const runs = known.filter(function (n, i) { return n !== known[i - 1]; });
  if (new Set(runs).size < runs.length) return "混合线路";
  return NAMES[runs[0]] || "未识别";
}

function getRouteQuality(carrier, asns) {
  const profile = getRouteProfile(carrier, asns);
  if (profile === "混合线路" || profile === "未识别") return "未识别";
  return ["CN2", "9929", "CMIN2"].indexOf(profile) >= 0 ? "优质" : "普通";
}

function summarizeRouteAttempt(carrier, attempt) {
  const hops = attempt.hops.slice().sort(function (a, b) { return a.distance - b.distance; });
  // 接入／入口网（如 CUG 10099）永不前置 passage 标签；
  // 前面只放回国内骨干段。
  const known = [];
  hops.forEach(function (hop, index) {
    const uniq = hop.asns.filter(function (v, i, arr) { return arr.indexOf(v) === i; });
    uniq.forEach(function (asn) {
      if (NAMES[asn] && ACCESS_ASNS[carrier].indexOf(asn) < 0) known.push({ asn: asn, index: index });
    });
  });
  const runs = known.filter(function (item, i) { return item.asn !== (known[i - 1] && known[i - 1].asn); });
  const conflict = hops.some(function (h) {
    return h.source === "conflict"
      || new Set(h.asns.filter(function (n) { return NAMES[n]; })).size > 1;
  });
  const last = runs.length ? runs[runs.length - 1] : undefined;
  // 宽松落地：任何观察到的骨干 ASN 都算，不只最后一跳。
  // 探测打的是测速点，核心跳常被过滤，而中转跳仍能识别骨干；
  // 要求最后一跳就会把这些证据丢掉。
  const backboneRuns = runs.filter(function (r) { return CARRIER_ASNS[carrier].indexOf(r.asn) >= 0; });
  const delivery = backboneRuns.length
    ? backboneRuns[backboneRuns.length - 1]
    : (last && CARRIER_ASNS[carrier].indexOf(last.asn) >= 0 ? last : undefined);
  let deliveryEnd = -1;
  if (delivery) {
    const same = known.filter(function (h) { return h.asn === delivery.asn; });
    deliveryEnd = same[same.length - 1].index;
  }
  const suffix = delivery ? hops.slice(deliveryEnd + 1) : [];
  const suffixLast = suffix.length ? suffix[suffix.length - 1] : undefined;
  const suffixKnown = suffix.length === 0 || Boolean(
    suffixLast && suffixLast.asns.length
    && suffixLast.ips.indexOf(attempt.target) >= 0
    && suffix.every(function (h) {
      return h.asns.every(function (n) { return ACCESS_ASNS[carrier].indexOf(n) >= 0; });
    })
  );
  const complete = Boolean(delivery && attempt.reached && attempt.exitCode === 0
    && suffixKnown && !conflict);
  const path = runs.map(function (r) { return NAMES[r.asn]; });
  // 只有目标一跳描述的是观察到的最后网络，不是中转。
  const transit = delivery && runs.length > 1 ? path.slice(0, -1) : path;
  const destinationOnly = runs.length === 1 && last
    && hops[last.index] && hops[last.index].ips.indexOf(attempt.target) >= 0;
  const passage = (conflict || destinationOnly) ? "" : transit.join(" → ");
  const landing = (!conflict && delivery) ? NAMES[delivery.asn] : "";
  const reentry = new Set(runs.map(function (r) { return r.asn; })).size < runs.length;
  const notes = [];
  if (conflict) notes.push("ASN 查询／前缀来源冲突，不能确定线路");
  if (reentry) notes.push("观察到网络重入／交替；保留有序路径，不等同质量差");
  if (!complete) notes.push("落地仅为最后观察网络；未确认目标到达或末段未知");
  if (suffix.length && complete) notes.push("落地表示最后识别骨干／国内交付网；最终接入 ASN 另见逐跳证据");
  if (hops.some(function (h) { return h.timeout || !h.asns.length; })) notes.push("含未知／超时跳，不能证明相邻网络直接互联");
  return {
    passage: passage,
    landing: landing,
    landingConfirmed: complete,
    notes: notes,
    conflict: conflict,
    reentry: reentry,
    rank: conflict ? 0 : complete ? 3 : passage ? 2 : landing ? 1 : 0,
  };
}

function classify(carrier, attempts, at) {
  const summaries = attempts.map(function (a) { return summarizeRouteAttempt(carrier, a); });
  let bestIndex = -1;
  summaries.forEach(function (s, i) {
    const bestRank = bestIndex >= 0 ? summaries[bestIndex].rank : -1;
    if (s.rank > bestRank) bestIndex = i;
  });
  const best = bestIndex >= 0 ? summaries[bestIndex] : undefined;
  function signature(s) { return s.passage + "|" + s.landing; }
  const differences = summaries.some(function (s) {
    return s.rank > 0 && best && (signature(s) !== signature(best) || s.landingConfirmed !== best.landingConfirmed);
  });
  const ambiguous = summaries.some(function (s) {
    return best && s.rank === best.rank && s.rank > 0 && signature(s) !== signature(best);
  });
  const notes = best ? best.notes.slice() : [];
  if (summaries.some(function (s) { return s.conflict; })) notes.push("存在来源冲突的探测方法，详见逐跳证据");
  if (differences) {
    notes.push("方法差异：" + summaries.map(function (s, i) {
      return attempts[i].method + ": " + (s.passage || "--") + " → " + (s.landing || "--")
        + " (" + (s.landingConfirmed ? "到达" : "末段未确认") + ")";
    }).join("；"));
  }
  if (ambiguous) notes.push("同等完整方法结论不同，主标签暂不选择；不是物理混合判定");
  const passage = ambiguous ? "" : (best && best.passage) || "";
  const landing = ambiguous ? "" : (best && best.landing) || "";
  const identified = Boolean(passage || landing);
  const asns = (attempts[bestIndex] && attempts[bestIndex].hops)
    ? attempts[bestIndex].hops.reduce(function (acc, h) { return acc.concat(h.asns); }, [])
    : [];
  return {
    label: passage || "未识别",
    passage: passage,
    landing: landing,
    landingConfirmed: !ambiguous && Boolean(best && best.landingConfirmed),
    notes: notes,
    asns: asns,
    route: asns.map(function (n) { return "AS" + n; }).join(" → ") || "—",
    state: identified ? (best && best.reentry ? "mixed" : "identified") : (attempts.length ? "unknown" : "failed"),
    attempts: attempts,
    lastAttempt: at,
    lastSuccess: identified ? at : undefined,
    stale: false,
    error: identified ? undefined : "本次证据不足、来源冲突或方法差异",
  };
}

function overall(carriers) {
  if (CARRIERS.some(function (c) { return carriers[c].state === "mixed"; })) return "mixed";
  const allOk = CARRIERS.every(function (c) {
    return carriers[c].state === "identified" && !carriers[c].stale;
  });
  return allOk ? "ok" : "unknown";
}

function parseRouteProbeOutput(output, testedAt) {
  const at = testedAt || Date.now();
  const text = String(output || "");
  const carriers = {};
  CARRIERS.forEach(function (carrier) {
    const attempts = [];
    const segments = text.split("ROUTE_PROBE_CARRIER:" + carrier + "\n");
    const block = segments.length > 1 ? segments[1].split("ROUTE_PROBE_CARRIER:")[0] : "";
    const matches = Array.from(block.matchAll(ATTEMPT_RE));
    matches.forEach(function (match) {
      const hops = match[3].split("\n").map(parseHop).filter(function (h) { return h !== null; });
      attempts.push({
        method: match[1],
        target: match[2],
        exitCode: match[4] ? Number(match[4]) : null,
        reached: hops.some(function (h) { return h.ips.indexOf(match[2]) >= 0; }),
        hops: hops,
      });
    });
    carriers[carrier] = classify(carrier, attempts, at);
  });
  const error = (text.match(ERROR_RE) || [])[1];
  if (error) {
    CARRIERS.forEach(function (c) { carriers[c].error = error; });
  }
  return {
    version: 2,
    testedAt: at,
    direction: "egress",
    carriers: carriers,
    state: error === "missing_traceroute" ? "missing_traceroute" : overall(carriers),
    message: error,
  };
}

function mergeRouteResult(previous, next) {
  const carriers = {};
  CARRIERS.forEach(function (c) { carriers[c] = next.carriers[c]; });
  CARRIERS.forEach(function (c) {
    const old = previous && previous.carriers && previous.carriers[c];
    const fresh = next.carriers[c];
    if (old && old.lastAttempt > fresh.lastAttempt) {
      carriers[c] = old;
      return;
    }
    if (old && old.lastSuccess && fresh.state !== "identified" && fresh.state !== "mixed") {
      const merged = {};
      for (const k in old) merged[k] = old[k];
      merged.lastAttempt = fresh.lastAttempt;
      merged.error = fresh.error || next.message || "本次采集失败";
      merged.stale = true;
      merged.attempts = old.attempts;
      merged.latestAttempts = fresh.attempts;
      carriers[c] = merged;
    }
  });
  const result = {};
  for (const k in next) result[k] = next[k];
  result.carriers = carriers;
  result.state = overall(carriers);
  return result;
}

function failedRouteResult(message, at) {
  const result = parseRouteProbeOutput("", at);
  result.message = message;
  CARRIERS.forEach(function (c) { result.carriers[c].error = message; });
  return result;
}

module.exports = {
  CARRIERS: CARRIERS,
  NAMES: NAMES,
  CARRIER_ASNS: CARRIER_ASNS,
  ACCESS_ASNS: ACCESS_ASNS,
  resolvePrefix: resolvePrefix,
  parseHop: parseHop,
  getRouteProfile: getRouteProfile,
  getRouteQuality: getRouteQuality,
  summarizeRouteAttempt: summarizeRouteAttempt,
  classify: classify,
  overall: overall,
  parseRouteProbeOutput: parseRouteProbeOutput,
  mergeRouteResult: mergeRouteResult,
  failedRouteResult: failedRouteResult,
  labelOf: function (result, carrier) {
    if (!result || !result.carriers || !result.carriers[carrier]) return "--";
    const c = result.carriers[carrier];
    return c.passage || c.label || "--";
  },
};
