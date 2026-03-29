import { Injectable } from '@nestjs/common';

type CounterKey = string;

@Injectable()
export class MetricsService {
  private counters = new Map<CounterKey, number>();
  private timings = new Map<string, { count: number; sumMs: number; maxMs: number }>();

  inc(name: string, labels?: Record<string, string>, by = 1) {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observeMs(name: string, ms: number, labels?: Record<string, string>) {
    const key = this.key(name, labels);
    const cur = this.timings.get(key) ?? { count: 0, sumMs: 0, maxMs: 0 };
    cur.count += 1;
    cur.sumMs += ms;
    cur.maxMs = Math.max(cur.maxMs, ms);
    this.timings.set(key, cur);
  }

  renderPrometheusText(): string {
    const lines: string[] = [];

    for (const [key, val] of this.counters.entries()) {
      // key format: name{a="b",...}
      lines.push(`${key} ${val}`);
    }

    for (const [key, t] of this.timings.entries()) {
      lines.push(`${key}_count ${t.count}`);
      lines.push(`${key}_sum_ms ${t.sumMs}`);
      lines.push(`${key}_max_ms ${t.maxMs}`);
    }

    return lines.join('\n') + '\n';
  }

  private key(name: string, labels?: Record<string, string>) {
    if (!labels || !Object.keys(labels).length) return name;
    const body = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
      .join(',');
    return `${name}{${body}}`;
  }
}
