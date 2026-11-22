import { Component, DestroyRef, computed, inject } from '@angular/core';
import { Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { FEATURES } from '@openshop/iam';
import { ApiService } from './api.service';
import { ActivityTracker } from './activity-tracker';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  protected api = inject(ApiService);
  private router = inject(Router);
  /** Menu entries from the feature registry, filtered by the member's permissions. */
  protected main = computed(() => (this.api.me() ? FEATURES.filter((f) => f.menu === 'main' && this.api.can(f.perm)) : []));
  protected shell = computed(() => !!this.api.token() && !!this.api.me());
  protected foot = computed(() => (this.api.me() ? FEATURES.filter((f) => f.menu === 'foot' && this.api.can(f.perm)) : []));
  constructor() {
    inject(ActivityTracker).start();
    if (this.api.token()) this.api.ensureMe().subscribe({ error: () => undefined });
    // Permissions can change while the backoffice is open: check again on focus and every 5 minutes.
    const refresh = () => this.api.refreshMe();
    window.addEventListener('focus', refresh);
    const t = setInterval(refresh, 5 * 60_000);
    inject(DestroyRef).onDestroy(() => { window.removeEventListener('focus', refresh); clearInterval(t); });
  }
  protected logout() { this.api.logout(); this.router.navigate(['/login']); }
}
