import { Component, input, output } from '@angular/core';
import type { Theme } from '@openshop/renderer';

@Component({
  selector: 'os-slider',
  template: `
    <div class="ctl">
      <div class="ctl-h">
        <span>{{ label() }}</span>
        @if (own()) { <i class="dot" title="Set for this device"></i> }
        @if (value() !== undefined) { <button class="rst" (click)="change.emit(undefined)" title="Reset">Reset</button> }
      </div>
      <div class="ctl-r">
        <input type="range" [min]="min()" [max]="max()" [step]="step()" [value]="value() ?? placeholder() ?? min()" (input)="emit($event)">
        <input type="number" class="num" [value]="value() ?? ''" [placeholder]="placeholder() ?? ''" (input)="emit($event)">
        <span class="u">{{ unit() }}</span>
      </div>
    </div>`,
})
export class OsSlider {
  label = input(''); value = input<number | undefined>(); min = input(0); max = input(100); step = input(1);
  unit = input('px'); placeholder = input<number | undefined>(); own = input(false);
  change = output<number | undefined>();
  emit(e: Event) { const v = (e.target as HTMLInputElement).value; this.change.emit(v === '' ? undefined : +v); }
}

@Component({
  selector: 'os-seg',
  template: `
    <div class="ctl">
      @if (label()) {
        <div class="ctl-h"><span>{{ label() }}</span>@if (own()) { <i class="dot" title="Set for this device"></i> }@if (resettable() && value() !== undefined) { <button class="rst" (click)="change.emit(undefined)">Reset</button> }</div>
      }
      <div class="seg">
        @for (o of options(); track o.v) {
          <button type="button" [class.on]="value() === o.v" [title]="o.title ?? o.label" (click)="change.emit(o.v)">{{ o.label }}</button>
        }
      </div>
    </div>`,
})
export class OsSeg {
  label = input(''); value = input<string | number | boolean | undefined>(); own = input(false); resettable = input(true);
  options = input.required<{ v: string | number | boolean; label: string; title?: string }[]>();
  change = output<any>();
}

@Component({
  selector: 'os-switch',
  template: `
    <label class="sw">
      <span>{{ label() }}</span>
      <input type="checkbox" [checked]="value()" (change)="change.emit($any($event.target).checked)">
      <i></i>
    </label>`,
})
export class OsSwitch {
  label = input(''); value = input(false);
  change = output<boolean>();
}

@Component({
  selector: 'os-color',
  template: `
    <div class="ctl">
      <div class="ctl-h">
        <span>{{ label() }}</span>
        @if (own()) { <i class="dot" title="Set for this device"></i> }
        @if (value() !== undefined && clearable()) { <button class="rst" (click)="change.emit(undefined)">Reset</button> }
      </div>
      <div class="clr">
        @for (c of chips(); track c.v) {
          <button type="button" class="chip" [class.on]="value() === c.v" [style.background]="c.css" [title]="c.name" (click)="change.emit(c.v)"></button>
        }
        <label class="pick" title="Custom colour">
          <input type="color" [value]="hex()" (input)="change.emit($any($event.target).value)">
        </label>
        <input class="hex" [value]="value() ?? ''" placeholder="#hex" maxlength="9" (change)="commit($event)">
      </div>
    </div>`,
})
export class OsColor {
  label = input(''); value = input<string | undefined>(); own = input(false); clearable = input(true);
  theme = input.required<Theme>();
  change = output<string | undefined>();
  chips() {
    const t = this.theme();
    return [
      { v: 'var(--primary)', css: t.primary, name: 'Primary' }, { v: 'var(--accent)', css: t.accent, name: 'Accent' },
      { v: 'var(--text)', css: t.text, name: 'Text' }, { v: 'var(--bg)', css: t.bg, name: 'Background' }, { v: 'var(--surface)', css: t.surface, name: 'Surface' },
      { v: '#ffffff', css: '#ffffff', name: 'White' }, { v: '#000000', css: '#000000', name: 'Black' },
    ];
  }
  hex() { const v = this.value(); if (v && /^#[0-9a-f]{6}$/i.test(v)) return v; const m = this.chips().find((c) => c.v === v); return m && /^#[0-9a-f]{6}$/i.test(m.css) ? m.css : '#000000'; }
  commit(e: Event) { const v = (e.target as HTMLInputElement).value.trim(); this.change.emit(v === '' ? undefined : v); }
}
