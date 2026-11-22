import { Columns, HBars, Stacked } from './charts';
import { Insights } from './insights';
import { mount, button } from '../testing/harness';
import { settings, summary } from '../testing/fixtures';
import { TestBed } from '@angular/core/testing';

describe('charts', () => {
  it('columns: round axis steps, bars, a line, and labels that fit', async () => {
    TestBed.configureTestingModule({ imports: [Columns] });
    const f = TestBed.createComponent(Columns);
    const days = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);
    f.componentRef.setInput('labels', days);
    f.componentRef.setInput('bars', days.map((_, i) => i * 70));
    f.componentRef.setInput('line', days.map(() => 100));
    f.componentRef.setInput('barLabel', 'Revenue');
    f.componentRef.setInput('lineLabel', 'Cost');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('text.axis')].slice(0, 6).map((t) => t.textContent)).toEqual(['€0', '€500', '€1,000', '€1,500', '€2,000', '€2,500']);
    expect(el.querySelectorAll('rect.bar').length).toBe(30);
    expect(el.querySelector('rect.bar title')!.textContent).toBe('1 Jun: Revenue €0, Cost €100');
    expect(el.querySelectorAll('circle.dot').length).toBe(30);
    expect([...el.querySelectorAll('text.axis')].filter((t) => /Jun/.test(t.textContent ?? '')).length).toBe(10);
    f.componentRef.setInput('money', false);
    f.componentRef.setInput('bars', [0, 3, 4]);
    f.componentRef.setInput('line', []);
    f.componentRef.setInput('labels', ['2026-06-01', '2026-06-02', '2026-06-03']);
    f.detectChanges();
    expect([...el.querySelectorAll('text.axis')].slice(0, 3).map((t) => t.textContent)).toEqual(['0', '1', '2']);
    expect(el.querySelector('polyline')).toBeNull();
    expect(el.querySelector('.legend')!.textContent).not.toContain('Cost');
  });
  it('horizontal bars scale to the largest value, and show an empty state', () => {
    TestBed.configureTestingModule({ imports: [HBars] });
    const f = TestBed.createComponent(HBars);
    f.componentRef.setInput('rows', [{ label: 'A', value: 100, note: '2 orders' }, { label: 'B', value: 25 }]);
    f.detectChanges();
    const fills = [...(f.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.hbar-f')].map((x) => x.style.width);
    expect(fills).toEqual(['100%', '25%']);
    expect((f.nativeElement as HTMLElement).textContent).toContain('€100.00');
    f.componentRef.setInput('money', false);
    f.componentRef.setInput('rows', []);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('No data for this period');
    expect(f.componentInstance.fmt(3)).toBe('3');
  });
  it('stacked bars split a group into outcomes', () => {
    TestBed.configureTestingModule({ imports: [Stacked] });
    const f = TestBed.createComponent(Stacked);
    f.componentRef.setInput('defs', [{ key: 'a', label: 'Paid more', color: 'blue' }, { key: 'b', label: 'Best', color: 'green' }, { key: 'c', label: 'Left', color: 'grey' }]);
    f.componentRef.setInput('rows', [{ label: 'MARTA10', note: 'Marta', segments: [{ key: 'a', value: 3 }, { key: 'b', value: 1 }, { key: 'c', value: 0 }] }]);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const segs = [...el.querySelectorAll<HTMLElement>('.stack-s')];
    expect(segs.map((s) => s.style.width)).toEqual(['75%', '25%']);
    expect(segs[0].title).toBe('Paid more: 3 (75%)');
    expect(el.querySelector('.stack-t')!.getAttribute('aria-label')).toBe('MARTA10: Paid more 3, Best 1');
    f.componentRef.setInput('rows', []);
    f.detectChanges();
    expect(el.textContent).toContain('No shopper had this choice');
  });
});

describe('Insights page', () => {
  const choice = { discountId: 'm', name: 'Marta', label: 'Marta', campaign: 'Creators', code: 'MARTA10', shown: 5, ordered: 4, notOrdered: 1, tookBest: 1, choseCodePayingMore: 3, choseAutomaticPayingMore: 1, lessFavourable: 4, lessFavourableRate: 100, codeChosen: 3, extraPaid: 15, avgExtraWhenLessFavourable: 5 };
  async function answer(m: Awaited<ReturnType<typeof mount<Insights>>>, from: string, to: string, s = summary()) {
    const q = `from=${from}&to=${to}`;
    await m.reply('GET', `/api/reports/summary?${q}`, s);
    await m.reply('GET', `/api/reports/discounts?${q}&groupBy=day`, { items: [{ day: '2026-06-14', orders: 2, ordersWithDiscount: 1, revenue: 100, discountCost: 10 }, { day: '2026-06-15', orders: 1, ordersWithDiscount: 1, revenue: 50, discountCost: 5 }], total: 2 });
    await m.reply('GET', `/api/reports/discounts?${q}&groupBy=discount`, { items: [{ discountId: 'w', name: 'Winter', label: 'Winter', campaign: 'Winter', trigger: 'automatic', orders: 1, discountCost: 10, revenue: 100, avgOrderValue: 100 }], total: 1 });
    await m.reply('GET', `/api/reports/discounts?${q}&groupBy=campaign`, { items: [{ campaign: 'Winter', orders: 2, discountCost: 10, revenue: 100, avgOrderValue: 50 }], total: 1 });
    await m.reply('GET', `/api/reports/choices?${q}&groupBy=code`, { items: [choice, { ...choice, code: 'FAIR', choseCodePayingMore: 0, choseAutomaticPayingMore: 0, notOrdered: 0 }, { ...choice, code: 'NONE', ordered: 0, notOrdered: 2 }], total: 3 });
    await m.reply('GET', `/api/reports/choices?${q}&groupBy=day`, { items: [{ day: '2026-06-15', ...choice }], total: 1 });
    await m.reply('GET', `/api/reports/saved-for-later?${q}`, { items: [{ discountId: 'v', name: 'Vase lovers', orders: 1, extraPaid: 10 }], total: 1 });
    await m.reply('GET', `/api/reports/search-misses?${q}`, { items: [{ q: 'teapot', count: 7, days: 3, lastAt: '2026-06-15T10:00:00Z', findsNow: 0 }, { q: 'jug', count: 2, days: 1, lastAt: '2026-06-14T10:00:00Z', findsNow: 2 }], total: 2 });
  }
  it('loads the last 30 days in shop time and shows KPIs, charts and the choice analysis', async () => {
    const m = await mount(Insights);
    await m.reply('GET', '/api/settings', settings());
    await answer(m, '2026-05-17', '2026-06-15');
    const kpis = m.all('.kpi').map((k) => k.textContent!.replace(/\s+/g, ' ').trim());
    expect(kpis[0]).toContain('€900.00');
    expect(kpis[0]).toContain('▼ 10% vs previous period');
    expect(kpis[1]).toContain('▲ 25% vs previous period');
    expect(kpis[2]).toContain('60% of orders');
    expect(m.all('svg.chart').length).toBe(2);
    expect(m.text('.insight-list')).toContain('3 of 4 shoppers who ordered (75%) picked MARTA10 although the automatic offers were cheaper, paying €15.00 more in total. 1 chose the automatic offers although MARTA10 was cheaper. 1 saw the choice but didn\'t order.');
    expect(m.text('.insight-list')).toContain('All 4 shoppers who ordered took the best price.');
    expect(m.text('.insight-list')).toContain("2 saw the choice but didn't order.");
    expect(m.all('.stack').length).toBe(3);
    expect(m.text()).toContain('Vase lovers');
    expect(m.text()).toContain('2 orders did, paying €20.00 more');
    expect(m.text('.misses')).toContain('teapot');
    expect(m.text('.misses')).toContain('still nothing');
    expect(m.text('.misses')).toContain('finds 2 products');
    expect(m.cmp.delta(0, 0)).toBe('');
    expect(m.cmp.delta(5, 0)).toBe('new this period');
    expect(m.cmp.deltaClass(5, 0)).toBe('muted');
    expect(m.cmp.day('2026-06-15')).toBe('15 Jun');
  });
  it('switches periods, downloads CSV with the same filters, and reports errors', async () => {
    const m = await mount(Insights);
    await m.reply('GET', '/api/settings', settings());
    await answer(m, '2026-05-17', '2026-06-15');
    await m.click(button(m.el, 'Last 7 days'));
    await answer(m, '2026-06-09', '2026-06-15');
    m.cmp.custom('2026-01-01', '2026-01-31');
    await m.settle();
    await answer(m, '2026-01-01', '2026-01-31', summary({ previous: { ...summary().previous, revenue: 0 }, choices: { ...summary().choices, shown: 0 } }));
    m.cmp.custom('', '2026-01-31');
    m.http.expectNone(/reports/ as never);
    const dl = vi.spyOn((m.cmp as unknown as { api: { downloadCsv: (...a: unknown[]) => unknown } }).api, 'downloadCsv').mockReturnValue({ subscribe: () => undefined } as never);
    await m.click(button(m.el, 'Download CSV'));
    expect(dl).toHaveBeenCalledWith('/api/reports/discounts', 'discounts-day-2026-01-01-2026-01-31.csv', { from: '2026-01-01', to: '2026-01-31', groupBy: 'day' });
    m.cmp.csv('/api/reports/saved-for-later');
    expect(dl).toHaveBeenLastCalledWith('/api/reports/saved-for-later', 'saved-for-later-all-2026-01-01-2026-01-31.csv', { from: '2026-01-01', to: '2026-01-31' });
    m.cmp.load();
    await m.reply('GET', '/api/reports/summary?from=2026-01-01&to=2026-01-31', { error: 'the period must be 1 to 366 days' }, 400);
    expect(m.text('[role=alert]')).toBe('the period must be 1 to 366 days');
    // one failing report cancels the others (forkJoin): nothing half-loaded is shown
    const rest = m.http.match(() => true);
    const sales = rest.filter((r) => !r.request.url.includes('search-misses'));
    expect(sales.length).toBe(6);
    expect(sales.every((r) => r.cancelled)).toBe(true);
    expect(rest.length - sales.length).toBe(1); // the search report is loaded on its own
  });
});
