import { SettingsPage } from './settings';
import { mount, button } from './testing/harness';
import { settings } from './testing/fixtures';

describe('Settings page', () => {
  it('reviews a time zone change before applying it', async () => {
    const m = await mount(SettingsPage);
    await m.reply('GET', '/api/settings', settings({ timezoneConfirmed: false }));
    expect(m.text()).toContain('Europe/Lisbon');
    expect(m.text()).toContain('Not confirmed');
    expect(button(m.el, 'Confirm').textContent).toContain('Confirm');
    await m.type('input[name=tz]', 'America/New_York');
    await m.click(button(m.el, 'Review change'));
    await m.reply('GET', '/api/settings/timezone-impact?tz=America/New_York', { timezone: 'America/New_York', offset: 'UTC-04:00', changes: [{ id: 'd1', name: 'Winter', startsAt: '2026-12-01T00:00:00.000Z', endsAt: null, newStartsAt: '2026-12-01T05:00:00.000Z', newEndsAt: null }] });
    expect(m.text('.impact')).toContain('1 offer moves');
    expect(m.text('.impact')).toContain('1 Dec 2026, 00:00');
    expect(m.text('.impact')).toContain('never');
    await m.click(button(m.el, 'Use America/New_York'));
    const req = await m.reply('PATCH', '/api/settings', settings({ timezone: 'America/New_York' }));
    expect(req.request.body).toEqual({ timezone: 'America/New_York' });
    expect(m.text('[role=status]')).toContain('Shop time zone set to America/New_York');
  });
  it('handles unknown zones, no impact, cancel, and save errors', async () => {
    const m = await mount(SettingsPage);
    await m.reply('GET', '/api/settings', settings());
    await m.type('input[name=tz]', 'Mars/Base');
    await m.click(button(m.el, 'Review change'));
    await m.reply('GET', '/api/settings/timezone-impact?tz=Mars/Base', {}, 400);
    expect(m.text('[role=alert]')).toContain('Unknown time zone');
    await m.type('input[name=tz]', 'UTC');
    await m.click(button(m.el, 'Review change'));
    await m.reply('GET', '/api/settings/timezone-impact?tz=UTC', { timezone: 'UTC', offset: 'UTC+00:00', changes: [] });
    expect(m.text('.impact')).toContain('No offers are affected');
    await m.click(button(m.el, 'Cancel'));
    expect(m.el.querySelector('.impact')).toBeNull();
    await m.click(button(m.el, 'Review change'));
    await m.reply('GET', '/api/settings/timezone-impact?tz=UTC', { timezone: 'UTC', offset: 'UTC+00:00', changes: [] });
    await m.click(button(m.el, 'Use UTC'));
    await m.reply('PATCH', '/api/settings', { error: 'nope' }, 400);
    expect(m.text('[role=alert]')).toBe('nope');
  });
  it('saves display switches one by one', async () => {
    const m = await mount(SettingsPage);
    await m.reply('GET', '/api/settings', settings());
    await m.check('label.sw:nth-of-type(2) input', false);
    const req = await m.reply('PATCH', '/api/settings', settings({ display: { showOriginalPrice: true, showBadge: false, showAlternatives: true } }));
    expect(req.request.body).toEqual({ display: { showBadge: false } });
  });
});
