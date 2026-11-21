import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { permission } from '@openshop/iam';
import { ActivityItem, ActivityQuery, ApiService, FullAuditEntry } from '../api.service';

export const KIND_GROUPS: { id: string; label: string; kinds: string[] }[] = [
  { id: 'signins', label: 'Sign-ins', kinds: ['sign_in', 'sign_in_failed', 'sign_out', 'session_ended'] },
  { id: 'links', label: 'Links', kinds: ['link_created', 'link_opened', 'link_used', 'link_revoked', 'link_invalid'] },
  { id: 'views', label: 'Page views', kinds: ['page_view'] },
  { id: 'changes', label: 'Changes', kinds: ['change'] },
  // Refused old sessions (removed, suspended, reset) are both a sign-in matter and a refusal.
  { id: 'denied', label: 'Denied access', kinds: ['page_denied', 'api_denied', 'api_unauthenticated', 'session_ended', 'dropped'] },
];
const REASON: Record<string, string> = {
  bad_password: 'wrong password', unknown_account: 'no such account', invited: 'invitation not accepted yet', suspended: 'account suspended', removed: 'account removed',
  throttled: 'too many attempts', no_token: 'not signed in', bad_token: 'invalid session', expired: 'session expired', session_ended: 'session was ended', inactive: 'account not active',
  active: 'account active', password_change_required: 'must change password', via_invite_link: 'after joining', via_reset_link: 'after a password reset',
};
const perm = (p?: string | null) => (p ? p.split(/ \+ | or /).map((x) => (x === 'sudo' ? 'owner only' : permission(x)?.label ?? x)).join(p.includes(' or ') ? ' or ' : ' + ') : '');
const reason = (r?: string | null) => (r ? REASON[r] ?? r : '');

/** One line of plain language for an event. */
export function describe(e: ActivityItem): string {
  const who = e.targetName ?? 'someone';
  const what = e.purpose === 'reset' ? 'password reset' : 'invitation';
  switch (e.kind) {
    case 'sign_in': return `Signed in${e.reason ? ` (${reason(e.reason)})` : ''}`;
    case 'sign_in_failed': return `Sign-in refused: ${reason(e.reason)}${e.count ? ` ×${e.count}` : ''}`;
    case 'sign_out': return 'Signed out';
    case 'session_ended': return `Old session refused (${reason(e.reason)}) on ${e.method} ${e.path}${e.count && e.count > 1 ? ` ×${e.count}` : ''}`;
    case 'link_created': return `Created an ${what} link for ${who}`;
    case 'link_opened': return `Opened their ${what} link`;
    case 'link_used': return `Used their ${what} link`;
    case 'link_revoked': return `Revoked ${who}'s ${what} link`;
    case 'link_invalid': return 'An invalid or expired link was opened';
    case 'page_view': return `Opened ${e.path}`;
    case 'page_denied': return `Was refused ${e.path} (needs ${perm(e.permission)})`;
    case 'api_denied': return `Request refused: ${e.method} ${e.path} (needs ${perm(e.permission)})${e.count && e.count > 1 ? ` ×${e.count}` : ''}`;
    case 'api_unauthenticated': return `Request without a valid session (${reason(e.reason)}): ${e.method} ${e.path}${e.count && e.count > 1 ? ` ×${e.count}` : ''}`;
    case 'change': return `${e.action} ${e.entity}${e.entityId && e.entity !== 'security-settings' ? ` ${e.entityId.slice(0, 8)}` : ''}`;
    case 'dropped': return `${e.count} more events in this minute were not stored (flood protection)`;
  }
}
/** The pill next to each event. */
export const KIND_LABEL: Record<string, string> = {
  sign_in: 'Sign-in', sign_in_failed: 'Sign-in', sign_out: 'Sign-out', session_ended: 'Refused', link_created: 'Link', link_opened: 'Link', link_used: 'Link',
  link_revoked: 'Link', link_invalid: 'Link', page_view: 'Page view', page_denied: 'Refused', api_denied: 'Refused', api_unauthenticated: 'Refused', change: 'Change', dropped: 'Dropped',
};
export const KIND_CLASS: Record<string, string> = { sign_in_failed: 'bad', session_ended: 'bad', page_denied: 'warn', api_denied: 'warn', api_unauthenticated: 'bad', link_invalid: 'warn', dropped: 'bad', change: 'info', sign_in: 'ok' };

@Component({
  selector: 'app-activity-list',
  imports: [DatePipe, JsonPipe, RouterLink],
  template: `
    @if (items().length) {
      <table class="tbl activity" [class.mini]="compact()">
        <thead><tr><th>When</th>@if (!userId()) { <th>Who</th> }<th>What</th><th>From</th></tr></thead>
        <tbody>
          @for (e of items(); track e.id) {
            <tr (click)="toggle(e)" class="clickable" [class.open]="open() === e.id">
              <td class="cell-sub nowrap">{{ e.at | date: 'd MMM, HH:mm:ss' }}</td>
              @if (!userId()) {
                <td>@if (e.userId && e.userName) { <a class="link cell-main" [routerLink]="e.userId === 'system' ? null : ['/team', e.userId]" (click)="$event.stopPropagation()">{{ e.userName }}</a>@if (e.userStatus === 'removed') { <span class="tag">removed</span> } }
                  @else { <span class="cell-sub">{{ e.userId === 'system' ? 'System' : 'Unknown' }}</span> }</td>
              }
              <td><span class="pill" [class]="'pill ' + (kindClass[e.kind] ?? '')">{{ kindLabel(e.kind) }}</span> {{ text(e) }}</td>
              <td class="cell-sub">{{ e.ip ?? '' }}</td>
            </tr>
            @if (open() === e.id) {
              <tr class="details"><td [attr.colspan]="userId() ? 3 : 4">
                @if (e.kind === 'change') {
                  @if (change(); as c) {
                    <div class="grid2"><div><b>Before</b><pre>{{ c.before === undefined ? '—' : (c.before | json) }}</pre></div><div><b>After</b><pre>{{ c.after === undefined ? '—' : (c.after | json) }}</pre></div></div>
                  } @else { Loading… }
                } @else {
                  <dl class="kv">
                    @if (e.userAgent) { <dt>Browser</dt><dd>{{ e.userAgent }}</dd> }
                    @if (e.path) { <dt>Path</dt><dd class="mono">{{ e.method ? e.method + ' ' : '' }}{{ e.path }}</dd> }
                    @if (e.permission) { <dt>Missing permission</dt><dd>{{ permLabel(e.permission) }}</dd> }
                    @if (e.reason) { <dt>Reason</dt><dd>{{ reasonLabel(e.reason) }}</dd> }
                    @if (e.count) { <dt>Times</dt><dd>{{ e.count }} in this minute</dd> }
                    @if (e.kind === 'page_view' || e.kind === 'page_denied') { <dt>Note</dt><dd>Reported by the backoffice in the member's browser (informational).</dd> }
                  </dl>
                }
              </td></tr>
            }
          }
        </tbody>
      </table>
      @if (next()) { <div class="acts-h mt"><button class="btn" (click)="more()">Load more</button></div> }
    } @else if (loaded()) { <p class="cell-sub">No activity matches.</p> } @else { <p class="cell-sub">Loading…</p> }`,
})
export class ActivityList {
  private api = inject(ApiService);
  userId = input<string | null>(null);
  query = input<ActivityQuery>({});
  compact = input(false);
  items = signal<ActivityItem[]>([]); next = signal<string | null>(null); loaded = signal(false);
  open = signal<string | null>(null); change = signal<FullAuditEntry | null>(null);
  kindClass = KIND_CLASS;
  text = describe; permLabel = perm; reasonLabel = reason;
  constructor() { effect(() => { const q = this.query(), u = this.userId(); untracked(() => this.load(q, u)); }); }
  private params(q: ActivityQuery, u: string | null): ActivityQuery { return { ...q, ...(u ? { userId: u } : {}), limit: this.compact() ? 15 : 50 }; }
  load(q = this.query(), u = this.userId()) {
    this.loaded.set(false);
    this.api.activity(this.params(q, u)).subscribe((r) => { this.items.set(r.items); this.next.set(r.next); this.loaded.set(true); });
  }
  more() {
    this.api.activity({ ...this.params(this.query(), this.userId()), before: this.next()! }).subscribe((r) => { this.items.set([...this.items(), ...r.items]); this.next.set(r.next); });
  }
  kindLabel(k: string) { return KIND_LABEL[k] ?? k; }
  toggle(e: ActivityItem) {
    if (this.open() === e.id) { this.open.set(null); return; }
    this.open.set(e.id); this.change.set(null);
    if (e.kind === 'change' && e.auditId) this.api.activityChange(e.auditId).subscribe((c) => this.change.set(c));
  }
}
