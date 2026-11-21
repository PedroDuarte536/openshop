import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { checkPassword, policyRules, type PasswordPolicy } from '@openshop/iam';
import { ApiService, SecuritySettingsView } from './api.service';

type Realm = 'staff' | 'customers';

/** Settings → Security (owner only): password policies for staff and customers, activity retention. */
@Component({
  selector: 'app-security-settings',
  imports: [FormsModule, DatePipe],
  template: `
    @if (s(); as s) {
      <section class="card pad block" id="security">
        <div class="sec-row"><h3>Security</h3>@if (s.updatedAt) { <small>Last changed {{ s.updatedAt | date: 'd MMM y, HH:mm' }}</small> }</div>
        <p class="hint-top">Only you (the owner) can see and change these. Password rules apply to new passwords: invitations, resets and password changes.
          Length protects better than character rules; regular forced changes are not offered because they tend to make passwords weaker.</p>
        <div class="grid2">
          @for (r of realms; track r.id) {
            <div class="policy" [attr.data-realm]="r.id">
              <h4>{{ r.label }}</h4>
              <label class="fld"><span>Minimum length</span><input class="inp" type="number" [attr.name]="r.id + '-min'" [min]="s.bounds.minLength.min" [max]="s.bounds.minLength.max" [(ngModel)]="draft[r.id].minLength">
                <small>{{ s.bounds.minLength.min }} to {{ s.bounds.minLength.max }} characters</small></label>
              <label class="fld"><span>Character types required</span>
                <select class="inp" [attr.name]="r.id + '-classes'" [(ngModel)]="draft[r.id].requireClasses">
                  <option [ngValue]="0">None</option><option [ngValue]="1">1 of 4</option><option [ngValue]="2">2 of 4</option><option [ngValue]="3">3 of 4</option><option [ngValue]="4">All 4</option>
                </select><small>Lower-case, upper-case, digit, symbol</small></label>
              <label class="sw"><span><b>Must not contain the email</b></span><input type="checkbox" [attr.name]="r.id + '-email'" [(ngModel)]="draft[r.id].disallowEmail"><i></i></label>
              <label class="sw"><span><b>Block common passwords</b><small>Like “password123” or “qwerty”</small></span><input type="checkbox" [attr.name]="r.id + '-common'" [(ngModel)]="draft[r.id].blockCommon"><i></i></label>
              @if (r.id === 'staff') {
                <label class="sw"><span><b>Require at next sign-in</b><small>Staff whose password doesn't meet these rules must choose a new one when they next sign in</small></span><input type="checkbox" name="enforce" [(ngModel)]="enforce"><i></i></label>
              }
              <label class="fld mt"><span>Try a password</span><input class="inp" [attr.name]="r.id + '-try'" [(ngModel)]="trial[r.id]" autocomplete="off" placeholder="Type to test the rules"></label>
              @if (trial[r.id]) { <p [class]="issues(r.id).length ? 'ferr' : 'ok-msg'">{{ issues(r.id).length ? issues(r.id).join(' ') : 'Meets these rules.' }}</p> }
              <ul class="rules">@for (rule of rules(r.id); track rule) { <li>{{ rule }}</li> }</ul>
            </div>
          }
        </div>
        <label class="fld narrow mt"><span>Keep activity for</span>
          <select class="inp" name="retention" [(ngModel)]="retention">@for (d of s.bounds.retention; track d) { <option [ngValue]="d">{{ d }} days</option> }</select>
          <small>Older sign-ins, page views and refusals are deleted automatically. The change history of records is kept.</small></label>
        <div class="acts-h"><button class="btn primary" (click)="save()">Save security settings</button><button class="btn ghost" (click)="reset()">Undo</button></div>
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
        @if (msg()) { <p class="ok-msg" role="status">{{ msg() }}</p> }
      </section>
    }`,
})
export class SecuritySettings {
  private api = inject(ApiService);
  s = signal<SecuritySettingsView | null>(null); error = signal(''); msg = signal('');
  realms: { id: Realm; label: string }[] = [{ id: 'staff', label: 'Staff accounts (backoffice)' }, { id: 'customers', label: 'Customer accounts (shop)' }];
  draft: Record<Realm, PasswordPolicy> = { staff: blank(), customers: blank() };
  trial: Record<Realm, string> = { staff: '', customers: '' };
  enforce = false; retention = 180;
  constructor() { this.api.securitySettings().subscribe((s) => this.set(s)); }
  private set(s: SecuritySettingsView) {
    this.s.set(s);
    this.draft = { staff: { ...s.passwordPolicy.staff }, customers: { ...s.passwordPolicy.customers } };
    this.enforce = s.enforceStaffPolicyAtSignIn; this.retention = s.activityRetentionDays;
  }
  reset() { this.set(this.s()!); this.msg.set(''); this.error.set(''); }
  rules = (r: Realm) => policyRules(this.norm(r));
  issues = (r: Realm) => checkPassword(this.trial[r], this.norm(r), { email: r === 'staff' ? this.api.me()?.email : 'customer@example.com' }).map((i) => i.message);
  private norm(r: Realm): PasswordPolicy { const d = this.draft[r]; return { ...d, minLength: Number(d.minLength), requireClasses: Number(d.requireClasses) as PasswordPolicy['requireClasses'] }; }
  save() {
    this.error.set(''); this.msg.set('');
    const body = { passwordPolicy: { staff: this.norm('staff'), customers: this.norm('customers') }, enforceStaffPolicyAtSignIn: this.enforce, activityRetentionDays: Number(this.retention), version: this.s()!.version };
    this.api.updateSecuritySettings(body).subscribe({
      next: (s) => { this.set(s); this.msg.set('Security settings saved.'); },
      error: (e) => this.error.set(e.error?.fields?.[0]?.message ? `Check the ${e.error.fields[0].field.includes('customers') ? 'customer' : 'staff'} policy: ${e.error.fields[0].message}` : e.error?.error ?? 'Could not save.'),
    });
  }
}
const blank = (): PasswordPolicy => ({ minLength: 12, requireClasses: 0, disallowEmail: false, blockCommon: false });
