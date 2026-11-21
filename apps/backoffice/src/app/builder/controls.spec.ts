import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_THEME } from '@openshop/renderer';
import { OsColor, OsSeg, OsSlider, OsSwitch } from './controls';

function make<T>(cmp: Type<T>, inputs: Record<string, unknown>) {
  TestBed.configureTestingModule({ imports: [cmp] });
  const f = TestBed.createComponent(cmp);
  for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
  f.detectChanges();
  const out: unknown[] = [];
  (f.componentInstance as { change: { subscribe: (fn: (v: unknown) => void) => void } }).change.subscribe((v) => out.push(v));
  return { f, el: f.nativeElement as HTMLElement, out };
}
const fire = (i: HTMLInputElement, value: string, type = 'input') => { i.value = value; i.dispatchEvent(new Event(type)); };

describe('builder controls', () => {
  it('slider: number in, number or empty (reset) out', () => {
    const { el, out, f } = make(OsSlider, { label: 'Gap', value: 10, own: true, unit: 'px' });
    expect(el.querySelector('.dot')).not.toBeNull();
    fire(el.querySelector('input[type=number]')!, '24');
    fire(el.querySelector('input[type=number]')!, '');
    (el.querySelector('.rst') as HTMLElement).click();
    expect(out).toEqual([24, undefined, undefined]);
    f.componentRef.setInput('value', undefined);
    f.detectChanges();
    expect(el.querySelector('.rst')).toBeNull();
  });
  it('segmented choice: emits the chosen value, optional reset', () => {
    const { el, out, f } = make(OsSeg, { label: 'Align', value: 'left', own: true, options: [{ v: 'left', label: 'Left' }, { v: 'right', label: 'Right', title: 'To the right' }] });
    expect(el.querySelector('button.on')!.textContent).toBe('Left');
    (el.querySelectorAll('.seg button')[1] as HTMLElement).click();
    (el.querySelector('.rst') as HTMLElement).click();
    expect(out).toEqual(['right', undefined]);
    f.componentRef.setInput('label', '');
    f.detectChanges();
    expect(el.querySelector('.ctl-h')).toBeNull();
  });
  it('switch: emits checked state', () => {
    const { el, out } = make(OsSwitch, { label: 'Hide', value: false });
    const i = el.querySelector('input')!;
    i.checked = true; i.dispatchEvent(new Event('change'));
    expect(out).toEqual([true]);
  });
  it('colour: theme chips, custom colour, hex field, reset', () => {
    const { el, out, f } = make(OsColor, { label: 'Colour', value: 'var(--primary)', theme: DEFAULT_THEME, own: true });
    expect(el.querySelectorAll('.chip').length).toBe(7);
    expect((el.querySelector('input[type=color]') as HTMLInputElement).value).toBe(DEFAULT_THEME.primary.toLowerCase());
    (el.querySelectorAll('.chip')[6] as HTMLElement).click();
    fire(el.querySelector('input[type=color]')!, '#123456');
    fire(el.querySelector('input.hex')!, ' #abcdef ', 'change');
    fire(el.querySelector('input.hex')!, '', 'change');
    (el.querySelector('.rst') as HTMLElement).click();
    expect(out).toEqual(['#000000', '#123456', '#abcdef', undefined, undefined]);
    f.componentRef.setInput('value', '#FA0000');
    f.detectChanges();
    expect(f.componentInstance.hex()).toBe('#FA0000');
    f.componentRef.setInput('value', 'rgb(1,2,3)');
    expect(f.componentInstance.hex()).toBe('#000000');
  });
});

describe('builder controls: native change events stay inside', () => {
  // Regression: a bubbling native `change` used to reach the host's (change) listener as a second, bogus value.
  for (const [name, cmp, inputs, selector] of [
    ['slider number', OsSlider, { label: 'Gap', value: 1 }, 'input[type=number]'],
    ['slider range', OsSlider, { label: 'Gap', value: 1 }, 'input[type=range]'],
    ['switch', OsSwitch, { label: 'Hide', value: false }, 'input'],
    ['colour picker', OsColor, { label: 'C', value: '#000000', theme: DEFAULT_THEME }, 'input[type=color]'],
    ['colour hex', OsColor, { label: 'C', value: '#000000', theme: DEFAULT_THEME }, 'input.hex'],
  ] as const) {
    it(name, () => {
      const { el } = make(cmp as Type<unknown>, inputs);
      let leaked = 0;
      el.addEventListener('change', () => leaked++);
      el.querySelector(selector)!.dispatchEvent(new Event('change', { bubbles: true }));
      expect(leaked).toBe(0);
    });
  }
});
