/** 极简指标注册表 + Prometheus 文本格式导出。零依赖，够用即止。 */
const counters = new Map();
const gauges = new Map();
const histograms = new Map(); // name -> { buckets: number[], counts: number[], sum, count }

const KEY = (name, labels) => {
  const l = labels && Object.keys(labels).length
    ? `{${Object.entries(labels)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
        .join(",")}}`
    : "";
  return `${name}${l}`;
};

export function counter(name, labels, value = 1) {
  const k = KEY(name, labels);
  counters.set(k, (counters.get(k) || 0) + value);
}

export function gauge(name, labels, value) {
  gauges.set(KEY(name, labels), value);
}

export function histogram(name, labels, buckets) {
  const k = KEY(name, labels);
  if (!histograms.has(k)) histograms.set(k, { buckets, counts: new Array(buckets.length + 1).fill(0), sum: 0, count: 0 });
  return { key: k, entry: histograms.get(k) };
}

export function observe(name, labels, value, buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]) {
  const k = KEY(name, labels);
  if (!histograms.has(k)) histograms.set(k, { buckets, counts: new Array(buckets.length + 1).fill(0), sum: 0, count: 0 });
  const h = histograms.get(k);
  h.sum += value;
  h.count += 1;
  let i = 0;
  while (i < buckets.length && value > buckets[i]) i += 1;
  h.counts[i] += 1;
}

export function renderPrometheus() {
  const lines = [];
  const seen = new Set();
  for (const [k, v] of counters) {
    const name = k.split("{")[0];
    if (!seen.has(`c:${name}`)) {
      lines.push(`# TYPE ${name} counter`);
      seen.add(`c:${name}`);
    }
    lines.push(`${k} ${v}`);
  }
  for (const [k, v] of gauges) {
    const name = k.split("{")[0];
    if (!seen.has(`g:${name}`)) {
      lines.push(`# TYPE ${name} gauge`);
      seen.add(`g:${name}`);
    }
    lines.push(`${k} ${v}`);
  }
  for (const [k, h] of histograms) {
    const name = k.split("{")[0];
    if (!seen.has(`h:${name}`)) {
      lines.push(`# TYPE ${name} histogram`);
      seen.add(`h:${name}`);
    }
    let cum = 0;
    h.buckets.forEach((b, i) => {
      cum += h.counts[i];
      const labels = k.includes("{") ? k.slice(k.indexOf("{") + 1, -1) : "";
      const suffix = labels ? `${labels},le="${b}"` : `le="${b}"`;
      lines.push(`${name}_bucket{${suffix}} ${cum}`);
    });
    const infLabels = k.includes("{") ? k.slice(k.indexOf("{") + 1, -1) : "";
    lines.push(`${name}_bucket{${infLabels ? `${infLabels},` : ""}le="+Inf"} ${h.count}`);
    lines.push(`${name}_sum${k.includes("{") ? k.slice(k.indexOf("{")) : ""} ${h.sum}`);
    lines.push(`${name}_count${k.includes("{") ? k.slice(k.indexOf("{")) : ""} ${h.count}`);
  }
  return `${lines.join("\n")}\n`;
}

export function snapshot() {
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
  };
}
