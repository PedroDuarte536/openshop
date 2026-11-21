import { Component, computed, input, model, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AREAS, AREA_LABELS, PERMISSIONS, closure, type PermissionDef, type PermissionId } from "@openshop/iam";
import type { NewLink, StaffMember } from '../api.service';

/** Status label and pill colour for a staff member. */
export function statusOf(m: Pick<StaffMember, 'status' | 'sudo' | 'inviteExpired'>): { label: string; cls: string } {
  if (m.sudo) return { label: 'Owner', cls: 'info' };
  if (m.status === 'invited') return m.inviteExpired ? { label: 'Invitation expired', cls: 'bad' } : { label: 'Invited', cls: 'warn' };
  if (m.status === 'suspended') return { label: 'Suspended', cls: 'warn' };
  if (m.status === 'removed') return { label: 'Removed', cls: 'bad' };
  return { label: 'Active', cls: 'ok' };
}

/** Short names for the Access overview cells. */
export const SHORT: Record<string, string> = {
  'catalog.view': 'View', 'catalog.stock': 'Stock', 'catalog.manage': 'Edit',
  'orders.view': 'View', 'orders.fulfil': 'Ship', 'orders.payments': 'Payments', 'orders.cancel': 'Cancel',
  'customers.view': 'View', 'customers.manage': 'Edit', 'customers.delete': 'Delete', 'customers.accounts': 'Accounts',
  'discounts.view': 'View', 'discounts.manage': 'Edit', 'discounts.codes': 'Codes',
  'pages.manage': 'Edit', 'insights.view': 'View', 'settings.manage': 'Edit',
};
/** "—", "View" or the actions ("Stock, Edit") a set of permissions gives in one area. */
export function areaCell(perms: Iterable<string>, area: string): string {
  const have = new Set(perms);
  const inArea = PERMISSIONS.filter((p) => p.area === area && have.has(p.id));
  if (!inArea.length) return '—';
  const actions = inArea.filter((p) => p.kind === 'change').map((p) => SHORT[p.id]);
  return actions.length ? actions.join(', ') : 'View';
}
export const AREA_LIST = AREAS.map((a) => ({ id: a, label: AREA_LABELS[a] }));

/** A one-time link, shown once, with copy. */
@Component({
  selector: 'app-link-box',
  imports: [DatePipe],
  template: `
    @if (link(); as l) {
      <div class="linkbox" role="status">
        <p><b>Send this {{ l.purpose === 'reset' ? 'password reset' : 'invitation' }} link to {{ name() }}</b> yourself (chat, SMS, in person).
          It works once, until {{ l.expiresAt | date: 'd MMM, HH:mm' }}. <b>Anyone who opens it can {{ l.purpose === 'reset' ? 'set this password' : 'create this account' }}</b>, so send it privately. It won't be shown again.</p>
        <input class="inp mono" readonly [value]="full()" (focus)="$any($event.target).select()" aria-label="One-time link">
        <div class="acts-h"><button type="button" class="btn sm" (click)="copy()">{{ copied() ? 'Copied' : 'Copy link' }}</button></div>
      </div>
    }`,
})
export class LinkBox {
  link = input<NewLink | null>(null);
  name = input('them');
  copied = signal(false);
  full = computed(() => { const l = this.link(); return l ? l.url ?? `${location.origin}${l.path}` : ''; });
  copy() { navigator.clipboard?.writeText(this.full()).then(() => this.copied.set(true), () => undefined); }
}

/**
 * Permissions by area with their descriptions. Ticking one also ticks what it needs; unticking one also unticks what
 * depends on it. The server applies the same rule.
 */
@Component({
  selector: 'app-permission-grid',
  template: `
    <div class="pgrid-perms">
      @for (a of areas; track a.id) {
        <fieldset class="parea">
          <legend>{{ a.label }}</legend>
          @for (p of byArea(a.id); track p.id) {
            <label class="pperm" [class.on]="value().includes(p.id)">
              <input type="checkbox" [name]="p.id" [checked]="value().includes(p.id)" [disabled]="readonly()" (change)="toggle(p.id, $any($event.target).checked)">
              <span><b>{{ p.label }}</b> <small class="kind">{{ p.kind === 'view' ? 'view' : 'change' }}</small>
                <small>{{ p.description }}</small>
                @if (p.sensitive) { <small class="warn-txt">⚠ {{ p.sensitive }}</small> }
                @if (p.requires.length) { <small class="req-txt">Needs: {{ needs(p.requires) }}</small> }
              </span>
            </label>
          }
        </fieldset>
      }
    </div>
    @if (note()) { <p class="note-box" role="status">{{ note() }}</p> }`,
})
export class PermissionGrid {
  value = model<string[]>([]);
  readonly = input(false);
  note = signal('');
  areas = AREA_LIST;
  byArea = (a: string): PermissionDef[] => PERMISSIONS.filter((p) => p.area === a);
  needs = (ids: readonly string[]) => ids.map((i) => PERMISSIONS.find((p) => p.id === i)?.label).join(', ');
  toggle(id: string, on: boolean) {
    const cur = new Set(this.value());
    if (on) {
      const added = [...closure([id])].filter((x) => !cur.has(x) && x !== id);
      closure([...cur, id]).forEach((x) => cur.add(x));
      this.note.set(added.length ? `Also ticked: ${this.needs(added)} (needed by “${PERMISSIONS.find((p) => p.id === id)!.label}”).` : '');
    } else {
      cur.delete(id);
      const dependents = PERMISSIONS.filter((p) => cur.has(p.id) && closure([p.id]).has(id as PermissionId)).map((p) => p.id);
      dependents.forEach((d) => cur.delete(d));
      this.note.set(dependents.length ? `Also unticked: ${this.needs(dependents)} (they need “${PERMISSIONS.find((p) => p.id === id)!.label}”).` : '');
    }
    this.value.set(PERMISSIONS.map((p) => p.id).filter((x) => cur.has(x)));
  }
}
