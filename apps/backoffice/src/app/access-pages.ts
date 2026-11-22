import { Component, DestroyRef, computed, effect, inject, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { feature, permission, requirementIds, type Requirement } from '@openshop/iam';
import { ApiService } from './api.service';

/** "Create and change offers", "Owner only", "… or …" for a requirement. */
export function requirementLabel(req: Requirement): string {
  if (req === 'sudo') return 'the shop owner only';
  if (req === 'authenticated') return 'a signed-in account';
  const ids = requirementIds(req);
  const sep = typeof req === 'object' && 'any' in req ? ' or ' : ' and ';
  return ids.map((id) => `“${permission(id)?.label ?? id}”`).join(sep);
}

@Component({
  selector: 'app-no-access',
  imports: [RouterLink],
  template: `
    <div class="access-page">
      <div class="access-ico" aria-hidden="true">🔒</div>
      <h1>You don't have access to {{ featureLabel() }}</h1>
      @if (d(); as d) { <p>This needs {{ needs() }}.</p> }
      <p>Ask <b>{{ owner() }}</b> to add you to a group that includes it. Once they have, reload this page.</p>
      <div class="acts-h"><a class="btn primary" [routerLink]="home()">Go to {{ homeLabel() }}</a><button class="btn" (click)="signOut()">Sign out</button></div>
    </div>`,
})
export class NoAccess {
  private api = inject(ApiService); private router = inject(Router);
  d = this.api.denied;
  featureLabel = computed(() => (this.d()?.feature ? feature(this.d()!.feature!)?.label ?? 'this page' : 'this page'));
  needs = computed(() => (this.d() ? requirementLabel(this.d()!.perm) : ''));
  owner = computed(() => this.api.me()?.owner.name ?? 'the shop owner');
  home = computed(() => this.api.landing());
  homeLabel = computed(() => { const h = this.home(); return h === '/welcome' ? 'your account' : FEATURE_LABEL(h); });
  constructor() {
    const d = this.d();
    if (d && this.api.token()) this.api.beacon({ kind: 'page_denied', path: d.url, feature: d.feature, permission: requirementIds(d.perm).join(' + ') }).subscribe({ error: () => undefined });
  }
  signOut() { this.api.logout(); this.router.navigate(['/login']); }
}
const FEATURE_LABEL = (path: string) => feature(path.replace(/^\//, ''))?.label ?? path;

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <div class="access-page">
      <div class="access-ico" aria-hidden="true">🧭</div>
      <h1>Page not found</h1>
      <p>There is no page at this address. It may have moved, or the link is mistyped.</p>
      <div class="acts-h"><a class="btn primary" [routerLink]="api.token() ? '/' : '/login'">{{ api.token() ? 'Go to the backoffice' : 'Sign in' }}</a></div>
    </div>`,
})
export class NotFound { api = inject(ApiService); }

@Component({
  selector: 'app-welcome',
  imports: [RouterLink],
  template: `
    <div class="access-page">
      <div class="access-ico" aria-hidden="true">👋</div>
      <h1>You're in{{ api.me() ? ', ' + api.me()!.name : '' }}</h1>
      <p>Your account works, but <b>{{ api.me()?.owner?.name ?? 'the shop owner' }}</b> hasn't given you access to any part of the shop yet.
        Ask them to add you to a group. The menu updates by itself once they have.</p>
      <div class="acts-h"><a class="btn" routerLink="/account">My account</a></div>
    </div>`,
})
export class Welcome {
  api = inject(ApiService);
  private router = inject(Router);
  constructor() {
    // If access arrives while this page is open, go to the first screen the member may use.
    effect(() => { if (this.api.me() && this.api.landing() !== '/welcome') untracked(() => this.router.navigateByUrl(this.api.landing())); });
    const t = setInterval(() => this.api.refreshMe(), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }
}
