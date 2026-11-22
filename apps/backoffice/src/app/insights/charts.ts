import { Component, computed, input } from '@angular/core';

// Small dependency-free charts: SVG for the time series, HTML/CSS for bars (responsive and accessible).

const eur = (n: number) => `€${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDay = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/** Columns per day with an optional line on the same scale (e.g. revenue and discount cost). */
@Component({
  selector: 'os-columns',
  template: `
    <div class="legend">
      <span><i class="sw-bar"></i>{{ barLabel() }}</span>
      @if (line().length) { <span><i class="sw-line"></i>{{ lineLabel() }}</span> }
    </div>
    <svg class="chart" [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="ariaLabel()">
      @for (t of g().ticks; track t.y) {
        <line [attr.x1]="L" [attr.x2]="W - R" [attr.y1]="t.y" [attr.y2]="t.y" class="grid"></line>
        <text [attr.x]="L - 8" [attr.y]="t.y + 4" text-anchor="end" class="axis">{{ t.label }}</text>
      }
      @for (b of g().bars; track b.i) {
        <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" rx="2" class="bar"><title>{{ b.title }}</title></rect>
        @if (b.showLabel) { <text [attr.x]="b.x + b.w / 2" [attr.y]="H - 8" text-anchor="middle" class="axis">{{ b.label }}</text> }
      }
      @if (g().path) {
        <polyline [attr.points]="g().path" class="line"></polyline>
        @for (p of g().points; track p.i) { <circle [attr.cx]="p.x" [attr.cy]="p.y" r="2.6" class="dot"><title>{{ p.title }}</title></circle> }
      }
    </svg>`,
})
export class Columns {
  labels = input.required<string[]>(); bars = input.required<number[]>(); line = input<number[]>([]);
  barLabel = input('Value'); lineLabel = input(''); money = input(true); ariaLabel = input('Chart');
  W = 760; H = 240; L = 56; R = 10; T = 10; B = 28;
  g = computed(() => {
    const bars = this.bars(), line = this.line(), labels = this.labels(), n = Math.max(bars.length, 1);
    const fmt = (v: number) => (this.money() ? eur(v) : String(Math.round(v)));
    const max = Math.max(1, ...bars, ...line);
    // Round tick steps (1, 2 or 5 × 10^n), at most 5 steps: the axis always reads 0, 2, 4, 6 or €0, €500, €1,000...
    const step = (() => { const raw = max / 5, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p; return Math.max(this.money() ? 0.01 : 1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p); })();
    const nice = Math.ceil(max / step) * step;
    const plotH = this.H - this.T - this.B, plotW = this.W - this.L - this.R, slot = plotW / n;
    const y = (v: number) => this.T + plotH - (v / nice) * plotH;
    const every = Math.ceil(n / 10);
    const ticks = Array.from({ length: Math.round(nice / step) + 1 }, (_, i) => ({ y: y(i * step), label: fmt(i * step) }));
    const rows = bars.map((v, i) => ({ i, x: this.L + i * slot + slot * 0.15, w: Math.max(1, slot * 0.7), y: y(v), h: Math.max(0, this.T + plotH - y(v)), label: shortDay(labels[i] ?? ''), showLabel: i % every === 0,
      title: `${shortDay(labels[i] ?? '')}: ${this.barLabel()} ${fmt(v)}${line.length ? `, ${this.lineLabel()} ${fmt(line[i] ?? 0)}` : ''}` }));
    const points = line.map((v, i) => ({ i, x: this.L + i * slot + slot / 2, y: y(v), title: `${shortDay(labels[i] ?? '')}: ${this.lineLabel()} ${fmt(v)}` }));
    return { ticks, bars: rows, points, path: points.map((p) => `${p.x},${p.y}`).join(' ') };
  });
}

/** Horizontal bars, one per row. */
@Component({
  selector: 'os-hbars',
  template: `
    <div class="hbars">
      @for (r of rows(); track r.label) {
        <div class="hbar">
          <div class="hbar-l"><b>{{ r.label }}</b>@if (r.note) { <small>{{ r.note }}</small> }</div>
          <div class="hbar-t"><div class="hbar-f" [style.width.%]="pct(r.value)" [style.background]="color()"></div></div>
          <div class="hbar-v">{{ fmt(r.value) }}</div>
        </div>
      } @empty { <p class="cell-sub">No data for this period.</p> }
    </div>`,
})
export class HBars {
  rows = input.required<{ label: string; value: number; note?: string }[]>(); money = input(true); color = input('var(--cobalt)');
  max = computed(() => Math.max(1, ...this.rows().map((r) => r.value)));
  pct = (v: number) => Math.max(0.5, (v / this.max()) * 100);
  fmt = (v: number) => (this.money() ? `€${v.toFixed(2)}` : String(v));
}

export interface Segment { key: string; value: number }
export interface SegmentDef { key: string; label: string; color: string }

/** 100% stacked bars: how a group splits into outcomes (e.g. what shoppers did when offered a choice). */
@Component({
  selector: 'os-stacked',
  template: `
    <div class="legend">@for (d of defs(); track d.key) { <span><i [style.background]="d.color"></i>{{ d.label }}</span> }</div>
    <div class="stacks">
      @for (r of rows(); track r.label) {
        <div class="stack">
          <div class="stack-l"><b>{{ r.label }}</b>@if (r.note) { <small>{{ r.note }}</small> }</div>
          <div class="stack-t" role="img" [attr.aria-label]="aria(r)">
            @for (s of parts(r); track s.key) {
              <div class="stack-s" [style.width.%]="s.pct" [style.background]="s.color" [title]="s.label + ': ' + s.value + ' (' + s.pct.toFixed(0) + '%)'">@if (s.pct >= 9) { {{ s.value }} }</div>
            }
          </div>
        </div>
      } @empty { <p class="cell-sub">No shopper had this choice in this period.</p> }
    </div>`,
})
export class Stacked {
  rows = input.required<{ label: string; note?: string; segments: Segment[] }[]>(); defs = input.required<SegmentDef[]>();
  parts(r: { segments: Segment[] }) {
    const total = r.segments.reduce((a, s) => a + s.value, 0) || 1;
    return this.defs().map((d) => { const v = r.segments.find((s) => s.key === d.key)?.value ?? 0; return { ...d, value: v, pct: (v / total) * 100 }; }).filter((s) => s.value > 0);
  }
  aria(r: { label: string; segments: Segment[] }) { return `${r.label}: ${this.parts(r).map((s) => `${s.label} ${s.value}`).join(', ')}`; }
}
